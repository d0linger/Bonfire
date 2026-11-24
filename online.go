package main

import (
	"context"
	"errors"
	"net/http"
	"os"

	"github.com/jackc/pgx/v5"
)

func offlineEnabled() bool { return os.Getenv("BONFIRE_OFFLINE_ENABLED") == "true" }

// The server actor preserves the author and numbering of online transactions.
// Its identifier is public. Only a live account session authorizes a request.
func lockOnline(ctx context.Context, tx pgx.Tx, r *http.Request) (device, error) {
	var d device
	cookie, err := r.Cookie("bonfire_session")
	if err != nil || cookie.Value == "" {
		return d, problem{401, "Bitte erneut anmelden."}
	}
	err = tx.QueryRow(ctx, `SELECT u.name,u.role FROM sessions s JOIN users u ON u.name=s.username
 WHERE s.token=$1 AND s.expires>now() AND u.active`, hash(cookie.Value)).Scan(&d.User, &d.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, problem{401, "Bitte erneut anmelden."}
	}
	if err != nil {
		return d, err
	}
	d.Event = r.Header.Get("X-Bonfire-Event")
	if r.URL.Path == "/api/online" {
		d.Event = r.URL.Query().Get("event")
	}
	if !idPattern.MatchString(d.Event) {
		return d, fail("Arbeitsbereich auswählen.")
	}
	err = tx.QueryRow(ctx, `SELECT e.closed,e.accounts FROM events e WHERE e.id=$1
 AND ($2='Leitung' OR EXISTS(SELECT 1 FROM grants_event g WHERE g.event=e.id AND g.username=$3)) FOR UPDATE`, d.Event, d.Role, d.User).Scan(&d.Closed, &d.Accounts)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, problem{403, "Arbeitsbereich nicht zugewiesen."}
	}
	if err != nil {
		return d, err
	}
	d.Online = true
	d.Donor = r.Header.Get("X-Bonfire-Donor") == "true"
	if d.Donor && d.Role != "Leitung" {
		return d, problem{403, "Meldedaten erfordern Leitungsrecht."}
	}
	err = tx.QueryRow(ctx, `SELECT id::text,block,last_seq,digital_count FROM devices
 WHERE event=$1 AND username=$2 AND online_actor`, d.Event, d.User).Scan(&d.ID, &d.Block, &d.Last, &d.DigitalCount)
	if errors.Is(err, pgx.ErrNoRows) {
		// The event lock serializes creation across tabs and concurrent requests.
		err = tx.QueryRow(ctx, `INSERT INTO devices(id,username,event,name,secret,expires,online_actor)
 VALUES($1,$2,$3,$2,''::bytea,now(),true) RETURNING id::text,block,last_seq,digital_count`, uuid(), d.User, d.Event).Scan(&d.ID, &d.Block, &d.Last, &d.DigitalCount)
	}
	if err != nil {
		return d, err
	}
	_, err = tx.Exec(ctx, "SELECT set_config('bonfire.device',$1,true)", d.ID)
	return d, err
}

func onlineDetails(ctx context.Context, tx pgx.Tx, d device, out map[string]any) error {
	var e event
	err := tx.QueryRow(ctx, `SELECT id::text,name,starts::text,ends::text,closed,accounts,general_ledger,coalesce(fiscal_year::text,'')
 FROM events WHERE id=$1`, d.Event).Scan(&e.ID, &e.Name, &e.Starts, &e.Ends, &e.Closed, &e.Accounts, &e.General, &e.Year)
	if err != nil {
		return err
	}
	next, err := nextOnlineNumber(ctx, tx, d)
	if err != nil {
		return err
	}
	out["event"], out["user"], out["role"] = e, d.User, d.Role
	out["device"], out["donorAccess"] = d.ID, d.Donor
	out["nextNumber"], out["first"] = next, d.Block*1000
	out["limit"], out["paperLimit"] = d.Block*1000+d.DigitalCount-1, d.Block*1000+999
	return nil
}

func nextOnlineNumber(ctx context.Context, tx pgx.Tx, d device) (int64, error) {
	var next int64
	err := tx.QueryRow(ctx, "SELECT coalesce(max(number)+1,$2::bigint) FROM originals WHERE device=$1", d.ID, d.Block*1000).Scan(&next)
	return next, err
}

const retiredWorker = `self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith("bonfire-")) await caches.delete(key);
  await self.clients.claim();
})()));`

func (a *app) registerCapture(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mode", route(func(context.Context, http.ResponseWriter, *http.Request) (any, error) {
		return map[string]bool{"offline": offlineEnabled()}, nil
	}))
	mux.HandleFunc("POST /api/online", route(a.syncEvent))
	if offlineEnabled() {
		mux.HandleFunc("POST /api/prepare", route(a.prepare))
		mux.HandleFunc("POST /api/renew", route(a.renew))
		mux.HandleFunc("POST /api/sync", route(a.syncEvent))
		return
	}
	mux.HandleFunc("GET /sw.js", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte(retiredWorker))
	})
}
