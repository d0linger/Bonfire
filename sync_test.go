package main

import "testing"

func amount(n int64) *int64 { return &n }
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
