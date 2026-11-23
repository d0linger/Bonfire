ALTER TABLE events ADD COLUMN general_ledger boolean NOT NULL DEFAULT false;
CREATE INDEX entries_paper_reference ON entries(event,(data->>'Reference')) WHERE kind='paper';
