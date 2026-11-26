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

func acceptPrintLog(ctx context.Context, tx pgx.Tx, d device, logs []printLog) ([]string, error) {
	if len(logs) > 1000 {
		return nil, fail("Too many reprint events.")
	}
	accepted := []string{}
	for _, l := range logs {
		if !idPattern.MatchString(l.ID) || !key.MatchString(l.Subject) || l.At.IsZero() {
			return nil, fail("Invalid reprint reference.")
		}
		tag, err := tx.Exec(ctx, "INSERT INTO print_log(id,event,device,subject,local_time) SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM originals WHERE event=$2 AND subject=$4) OR EXISTS(SELECT 1 FROM operations WHERE event=$2 AND device=$3 AND target='original:'||$4 AND kind='original' AND outcome='Geklärt') ON CONFLICT DO NOTHING", l.ID, d.Event, d.ID, l.Subject, l.At)
		if err != nil {
			return nil, err
		}
		if tag.RowsAffected() == 1 {
			if err = audit(ctx, tx, d.Event, d.User, "Nachdruck", l.Subject); err != nil {
				return nil, err
			}
		} else {
			var matched bool
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM print_log WHERE id=$1 AND event=$2 AND device=$3 AND subject=$4 AND local_time=$5)`, l.ID, d.Event, d.ID, l.Subject, l.At).Scan(&matched); err != nil {
				return nil, err
			}
			if !matched {
				continue
			}
		}
		accepted = append(accepted, l.ID)
	}
	return accepted, nil
}
