package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"
)

// This command runs inside the worker container via an operator's Docker session.
func runOperatorBackup(args []string) error {
	usage := errors.New("Use operator-backup status, backup <local|s3>, or schedule <local|s3> <cron> <retention days>")
	if len(args) == 0 {
		return usage
	}
	action := args[0]
	method := http.MethodGet
	var body io.Reader
	if action != "status" || len(args) != 1 {
		if len(args) < 2 || (args[1] != "local" && args[1] != "s3") {
			return usage
		}
		command := backupCommand{Action: action, Target: args[1]}
		switch {
		case action == "backup" && len(args) == 2:
		case action == "schedule" && len(args) == 4:
			days, err := strconv.Atoi(args[3])
			if err != nil {
				return usage
			}
			command.Cron, command.Days = args[2], days
		default:
			return usage
		}
		raw, err := json.Marshal(command)
		if err != nil {
			return err
		}
		body, method = bytes.NewReader(raw), http.MethodPost
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, "http://backup/", body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Bonfire-Actor", "Operator")
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", "/run/bonfire-backup/worker.sock")
	}}
	defer transport.CloseIdleConnections()
	response, err := transport.RoundTrip(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		detail, err := io.ReadAll(io.LimitReader(response.Body, 1024))
		if err != nil {
			return err
		}
		return fmt.Errorf("backup worker returned %d: %s", response.StatusCode, detail)
	}
	_, err = io.Copy(os.Stdout, io.LimitReader(response.Body, 16<<20))
	return err
}
