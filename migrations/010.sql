CREATE TABLE donation_reports (
    id uuid PRIMARY KEY, event uuid NOT NULL REFERENCES events, period text NOT NULL,
    previous uuid REFERENCES donation_reports, payload bytea NOT NULL, digest text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX donation_report_lookup ON donation_reports(event,period,created_at DESC);
CREATE TABLE donation_report_steps (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, request_id uuid UNIQUE NOT NULL,
    report uuid NOT NULL REFERENCES donation_reports, status text NOT NULL CHECK
    (status IN ('Geprüft','Exportiert','Übermittelt','Bestätigt','Korrektur')),
    actor text NOT NULL REFERENCES users, evidence text NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX donation_report_history ON donation_report_steps(report,seq DESC);
