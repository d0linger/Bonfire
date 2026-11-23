package main

import (
	"context"
	"github.com/jackc/pgx/v5"
	"time"
)

type printLog struct {
	ID, Subject string
	At          time.Time
}

func acceptPrintLog(ctx context.Context, tx pgx.Tx, d device, logs []printLog) error {
	if len(logs) > 1000 {
		return fail("Zu viele Nachdruckereignisse.")
	}
	for _, l := range logs {
		if !idPattern.MatchString(l.ID) || !key.MatchString(l.Subject) || l.At.IsZero() {
			return fail("Ungültiger Nachdruckbezug.")
		}
		tag, err := tx.Exec(ctx, "INSERT INTO print_log(id,event,device,subject,local_time) SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM originals WHERE event=$2 AND subject=$4) ON CONFLICT DO NOTHING", l.ID, d.Event, d.ID, l.Subject, l.At)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 1 {
			if err = audit(ctx, tx, d.Event, d.User, "Nachdruck", l.Subject); err != nil {
				return err
			}
		}
	}
	return nil
}
