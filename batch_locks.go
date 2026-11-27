package main

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Acquire installation-wide resource locks before sealing the first audit row.
func lockBatchResources(ctx context.Context, tx pgx.Tx, ops []op) error {
	var targets, names []string
	for _, o := range ops {
		if o.Kind == "contact" || strings.HasPrefix(o.Target, "import:") {
			targets = append(targets, o.Target)
		}
		if o.Kind == "contact" && o.Base == 0 && len(strings.TrimSpace(o.Data.Fields["distinct"])) < 3 {
			names = append(names, o.Data.Label)
		}
	}
	if len(targets)+len(names) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(id)
		FROM (
			SELECT hashtextextended(value,0) AS id FROM unnest($1::text[]) AS input(value)
			UNION
			SELECT hashtextextended(lower(trim(regexp_replace(value,'[[:space:]]+',' ','g'))),1)
			FROM unnest($2::text[]) AS input(value)
			ORDER BY id
		) AS resources`, targets, names)
	return err
}
