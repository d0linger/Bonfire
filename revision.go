package main

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"strconv"
	"strings"
)

func archiveKey(v data) string {
	key := v.Reference
	if v.Fields["series"] == "confirmation" {
		key += ":confirmation"
	}
	if v.Fields["previous"] != "" {
		return key + ":after:" + v.Fields["previous"]
	}
	return key
}
func predecessor(ctx context.Context, tx pgx.Tx, d device, v data) (*int64, bool, error) {
	text := v.Fields["previous"]
	if text == "" {
		return nil, true, nil
	}
	number, err := strconv.ParseInt(text, 10, 64)
	if err != nil || number < 1 || strconv.FormatInt(number, 10) != text || len(strings.TrimSpace(v.Fields["reason"])) < 3 {
		return nil, false, fail("Enter the preceding document number and a reason for the correction.")
	}
	var matches bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM originals o WHERE o.event=$1 AND o.number=$2 AND o.device=$3 AND coalesce(o.snapshot->>'subject',o.subject)=$4 AND o.snapshot->>'profile'=($5::jsonb->>'profile') AND NOT EXISTS(SELECT 1 FROM originals c WHERE c.previous_number=o.number))`, d.Event, number, d.ID, v.Reference, v.Note).Scan(&matches)
	return &number, matches, err
}
func digestHex(bytes []byte) string { return fmt.Sprintf("%x", hash(string(bytes))) }
