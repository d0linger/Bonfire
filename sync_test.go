package main

import "testing"

func amount(n int64) *int64 { return &n }

func TestUsedWalletRequiresSettlement(t *testing.T) {
	wallet := row{ID: "tasche", Kind: "wallet"}
	if err := validateSettlement([]row{wallet}); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"supply", "skim", "income", "expense"} {
		movement := row{Kind: kind, Data: data{Wallet: wallet.ID, Amount: amount(500), Method: "Bar"}}
		if err := validateSettlement([]row{wallet, movement}); err == nil {
			t.Errorf("%s ohne Geldtaschenabrechnung freigegeben", kind)
		}
	}
}

func TestAccountReconciliation(t *testing.T) {
	entries := []row{{Kind: "opening", Data: data{Account: "Kassa", Amount: amount(100000)}}, {Kind: "transfer", Data: data{Account: "Kassa", To: "Tasche", Amount: amount(30000)}}, {Kind: "actual", Data: data{Account: "Kassa", Amount: amount(70000)}}, {Kind: "actual", Data: data{Account: "Tasche", Amount: amount(30000)}}}
	entries = append(entries, row{ID: "Kassa", Kind: "account"}, row{ID: "Tasche", Kind: "wallet"})
	if err := checkBalance(entries, true); err != nil {
		t.Fatal(err)
	}
	if err := checkBalance(entries[:3], true); err == nil {
		t.Fatal("unvollständiges Ist freigegeben")
	}
	entries[3].Data.Amount = amount(0)
	if err := checkBalance(entries, true); err == nil {
		t.Fatal("Differenz übergangen")
	}
}
func TestZeroVersusUnknown(t *testing.T) {
	v := []row{{Kind: "opening", Data: data{Amount: amount(0)}}, {Kind: "actual", Data: data{Amount: amount(0)}}}
	if err := checkBalance(v, false); err != nil {
		t.Fatal(err)
	}
	v[1].Data.Amount = nil
	if checkBalance(v, false) == nil {
		t.Fatal("fehlende Zählung als Null gewertet")
	}
}
func TestDenominations(t *testing.T) {
	o := op{ID: uuid(), Seq: 1, Target: countKey("count", "Tasche", "Ende"), Kind: "count", Data: data{Label: "Abend", Date: "2026-07-01", Wallet: "Tasche", Phase: "Ende", Amount: amount(5006), Pieces: map[string]int64{"5000": 1, "2": 3}}}
	if err := validate(o, false); err != nil {
		t.Fatal(err)
	}
	o.Data.Pieces["2"] = -2
	if validate(o, false) == nil {
		t.Fatal("negative Stückelung")
	}
}

func TestSupplyCashInput(t *testing.T) {
	for _, tc := range []struct {
		name, mode string
		pieces     map[string]int64
		valid      bool
	}{
		{"existing amount", "", nil, true},
		{"manual amount", "amount", nil, true},
		{"counted amount", "pieces", map[string]int64{"1000": 2, "100": 5}, true},
		{"wrong sum", "pieces", map[string]int64{"1000": 1}, false},
		{"unsupported denomination", "pieces", map[string]int64{"2500": 1}, false},
		{"stale pieces", "amount", map[string]int64{"500": 5}, false},
		{"missing pieces", "pieces", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o := op{ID: uuid(), Seq: 1, Target: uuid(), Kind: "supply", Data: data{
				Label: "Übung", Date: "2026-07-01", Account: "Kassa", To: "Tasche", Wallet: "Tasche",
				Amount: amount(2500), Pieces: tc.pieces, Fields: map[string]string{"countMode": tc.mode},
			}}
			err := validate(o, false)
			if (err == nil) != tc.valid {
				t.Fatalf("validate: %v", err)
			}
		})
	}
}

func TestBalanceNeedsAFreshObservation(t *testing.T) {
	entry := func(kind string, n, order int64) row {
		return row{Kind: kind, Data: data{Date: "2026-06-11", Amount: amount(n), BalanceOrder: order}}
	}
	rows := []row{entry("opening", 100, 1), entry("actual", 100, 2), entry("income", 25, 3), entry("expense", 25, 4)}
	if checkBalance(rows, false) == nil {
		t.Fatal("stale equal balance accepted")
	}
	rows[2].Data.Date, rows[3].Data.Date = "2026-06-10", "2026-06-10"
	if checkBalance(rows, false) == nil {
		t.Fatal("backdated postings accepted after observation")
	}
	rows[1].Data.BalanceOrder = 5
	if err := checkBalance(rows, false); err != nil {
		t.Fatal(err)
	}
	rows[2].Data.Date = rows[1].Data.Date
	rows[2].Data.BalanceOrder = 0
	if checkBalance(rows, false) == nil {
		t.Fatal("unknown order accepted")
	}
}
