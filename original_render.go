package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"time"

	"github.com/jackc/pgx/v5"
)

const maxSimultaneousOriginals = 2

var originalRenderSlots = make(chan struct{}, maxSimultaneousOriginals)

// Build the print model from the locked workspace, never from client file bytes.
func renderOriginal(ctx context.Context, tx pgx.Tx, d device, requested data, subject data, previous *int64) (data, error) {
	var selected struct{ Profile string }
	if err := json.Unmarshal([]byte(requested.Note), &selected); err != nil {
		return data{}, fail("Select an approved document profile.")
	}
	result := requested
	if (selected.Profile == "donation_lfk_a6" || selected.Profile == "donation_confirmation_a4") && !d.Donor {
		return data{}, problem{http.StatusForbidden, "The document profile is unavailable."}
	}
	select {
	case originalRenderSlots <- struct{}{}:
		defer func() { <-originalRenderSlots }()
	default:
		return data{}, problem{http.StatusServiceUnavailable, "The renderer is busy. Try again shortly."}
	}
	var workspace event
	err := tx.QueryRow(ctx, "SELECT id::text,name,starts::text,ends::text,closed,accounts,general_ledger FROM events WHERE id=$1", d.Event).
		Scan(&workspace.ID, &workspace.Name, &workspace.Starts, &workspace.Ends, &workspace.Closed, &workspace.Accounts, &workspace.General)
	if err != nil {
		return data{}, err
	}
	parent := subject.Reference
	var parentContact string
	if parent != "" {
		err = tx.QueryRow(ctx, "SELECT coalesce((SELECT data->>'Contact' FROM entries WHERE event=$1 AND id=$2 AND kind='sponsorship'),'')", d.Event, parent).Scan(&parentContact)
		if err != nil {
			return data{}, err
		}
	}
	rows, err := tx.Query(ctx, `SELECT id,kind,device::text,revision,data FROM entries
		WHERE event=$1 AND (id IN ($2,$3,$4) OR kind='organization'
		  OR (kind='template' AND data->>'Reference'=$5)
		  OR (kind='payment' AND data->>'Reference' IN ($2,$3)))
		UNION ALL SELECT id,'contact',device::text,revision,data FROM directory WHERE id IN ($6,$7)
		ORDER BY id`, d.Event, requested.Reference, parent, subject.Wallet, selected.Profile, subject.Contact, parentContact)
	if err != nil {
		return data{}, err
	}
	printRows, err := pgx.CollectRows(rows, pgx.RowToStructByPos[row])
	if err != nil {
		return data{}, err
	}
	input, err := json.Marshal(map[string]any{
		"profile": selected.Profile, "event": workspace, "rows": printRows,
		"subject": requested.Reference, "number": requested.Number, "device": d.ID,
		"user": d.User, "previous": previous, "reason": requested.Fields["reason"], "donorAccess": d.Donor,
	})
	if err != nil {
		return data{}, err
	}
	renderCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(renderCtx, "node", "--max-old-space-size=128", "render-original.cjs")
	cmd.Env = []string{"TZ=Europe/Vienna"}
	cmd.Stdin = bytes.NewReader(input)
	output, err := cmd.Output()
	if err != nil {
		return data{}, problem{http.StatusServiceUnavailable, "The original renderer is unavailable. No number was issued."}
	}
	var rendered struct {
		PDF, DOCX, Note, Date, Label, Error string
	}
	if err := json.Unmarshal(output, &rendered); err != nil {
		return data{}, problem{http.StatusServiceUnavailable, "The original renderer returned an invalid response."}
	}
	if rendered.Error != "" {
		return data{}, fail(rendered.Error)
	}
	result.PDF, result.DOCX, result.Note, result.Date, result.Label = rendered.PDF, rendered.DOCX, rendered.Note, rendered.Date, rendered.Label
	return result, nil
}
