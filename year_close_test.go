package main

import "testing"

func TestCloseWithPaddedTerminalIdentifier(t *testing.T) {
	withdrawal, payout, fee := int64(150), int64(140), int64(10)
	entries := []row{
		{Kind: "cashback", Data: data{Amount: &withdrawal, Fields: map[string]string{"provider": "PSP"}}},
		{Kind: "payout", Data: data{Amount: &payout, Fields: map[string]string{"provider": "\tPSP "}}},
		{Kind: "fee", Data: data{Amount: &fee, Fields: map[string]string{"provider": "\u00a0PSP\n"}}},
	}
	if err := checkOpenPayments(entries); err != nil {
		t.Fatal(err)
	}
	if err := checkOpenPayments(entries[:2]); err == nil {
		t.Fatal("unsettled terminal accepted")
	}
}

func TestCloseChecksCardOnlySettlement(t *testing.T) {
	amount := int64(5000)
	entries := []row{
		{Kind: "card", Data: data{Amount: &amount, Fields: map[string]string{"provider": "Terminal"}}},
		{Kind: "payout", Data: data{Amount: &amount, Fields: map[string]string{"provider": "Terminal"}}},
	}
	if err := checkOpenPayments(entries[:1]); err == nil {
		t.Fatal("unsettled card receipts accepted")
	}
	if err := checkOpenPayments(entries); err != nil {
		t.Fatal(err)
	}
}

func TestFiscalCloseRejectsChangedCarrySource(t *testing.T) {
	fixture := newTxFixture(t)
	ctx := t.Context()
	source, destination, account := uuid(), uuid(), uuid()
	for _, step := range []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO fiscal_years(id,name,starts,ends,closed) VALUES($1,'Carry source 2874','2874-01-01','2874-12-31',true),($2,'Carry target 2875','2875-01-01','2875-12-31',false)", []any{source, destination}},
		{"INSERT INTO fire_accounts(id,name) VALUES($1,'Synthetic carry source')", []any{account}},
		{"INSERT INTO fire_year_counts(year,account,opening,actual,revision) VALUES($1,$2,0,150,1)", []any{source, account}},
		{"INSERT INTO fire_year_counts(year,account,opening,actual,revision,opening_source_year,opening_source_revision) VALUES($1,$2,150,150,1,$3,1)", []any{destination, account, source}},
	} {
		if _, err := fixture.owner.Exec(ctx, step.sql, step.args...); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := fixture.owner.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := checkYearEvents(ctx, tx, destination, uuid()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "UPDATE fire_year_counts SET actual=200,revision=2 WHERE year=$1 AND account=$2", source, account); err != nil {
		t.Fatal(err)
	}
	if err := checkYearEvents(ctx, tx, destination, uuid()); err == nil {
		t.Fatal("closing accepted an opening balance from an older revision")
	}
}
