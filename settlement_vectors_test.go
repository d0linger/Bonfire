package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSettlementVectors(t *testing.T) {
	var cases []struct {
		Name                                                                                                       string
		Opening, Closing, Supply, Skim, Expense, Returned, Donation, Refund, Deposit, DepositReturn, Unbooked, Net int64
	}
	raw, err := os.ReadFile("tests/settlement-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			cash := func(kind string, n int64) row {
				return row{Kind: kind, Data: data{Amount: &n, Wallet: "w", Method: "Bar"}}
			}
			opening, closing := cash("count", tc.Opening), cash("count", tc.Closing)
			opening.Data.Phase, closing.Data.Phase = "Anfang", "Ende"
			list := []row{{ID: "w", Kind: "wallet"}, opening, cash("supply", tc.Supply), cash("skim", tc.Skim), cash("expense", tc.Expense), cash("donation", tc.Donation), cash("refund", tc.Refund), cash("deposit", tc.Deposit), cash("deposit-return", tc.DepositReturn), closing, cash("return", tc.Returned)}
			for _, pooled := range []bool{false, true} {
				var got int64
				var ok bool
				if pooled {
					list[len(list)-2].Data.Wallet = ""
					list[len(list)-2].Data.Fields = map[string]string{"countScope": "all"}
					got, ok = pooledRevenue(list)
				} else {
					got, ok = walletRevenue(list, "w")
				}
				if !ok || got != tc.Unbooked || got+tc.Donation-tc.Refund != tc.Net {
					t.Fatalf("pooled=%v: unbooked %d, confirmed %v", pooled, got, ok)
				}
			}
		})
	}
}

func TestInvoicePositionRounding(t *testing.T) {
	for _, tc := range []struct{ quantity, price, want int64 }{{500, 1, 1}, {499, 1, 0}, {1250, 225, 281}, {10000000, 999999999, 9999999990000}} {
		got, err := amountPositions([]position{{Description: "Fixture", QuantityMilli: tc.quantity, UnitCents: tc.price}})
		if err != nil || got != tc.want {
			t.Fatalf("%+v: %d %v", tc, got, err)
		}
	}
	if _, err := amountPositions([]position{{Description: "Fixture", QuantityMilli: -1}}); err == nil {
		t.Fatal("negative quantity accepted")
	}
	if _, err := amountPositions(make([]position, 201)); err == nil {
		t.Fatal("too many positions accepted")
	}
}

func TestCountCutoff(t *testing.T) {
	opening, closing, before, after := int64(1000), int64(2000), int64(200), int64(300)
	rows := []row{
		{ID: "w", Kind: "wallet"},
		{Kind: "count", Data: data{Wallet: "w", Phase: "Anfang", Date: "2026-07-01", Amount: &opening}},
		{Kind: "supply", Data: data{Wallet: "w", Date: "2026-07-02", PostingOrder: 2, Amount: &before}},
		{Kind: "count", Data: data{Wallet: "w", Phase: "Ende", Date: "2026-07-02", PostingOrder: 3, Amount: &closing}},
		{Kind: "supply", Data: data{Wallet: "w", Date: "2026-07-02", PostingOrder: 4, Amount: &after}},
	}
	rows = append(rows, row{Kind: "supply", Data: data{Wallet: "w", Date: "2026-07-03", Amount: &after}})
	if got, ok := walletRevenue(rows, "w"); !ok || got != 800 {
		t.Fatalf("individual settlement = %d, valid = %v", got, ok)
	}
	rows[3].Data.Wallet = ""
	rows[3].Data.Fields = map[string]string{"countScope": "all"}
	if got, ok := pooledRevenue(rows); !ok || got != 800 {
		t.Fatalf("pooled settlement = %d, valid = %v", got, ok)
	}
}

func TestPooledSettlementCompleteness(t *testing.T) {
	zero, end := int64(0), int64(500)
	wallet := row{ID: "w", Kind: "wallet"}
	opening := row{Kind: "count", Data: data{Wallet: "w", Phase: "Anfang", Amount: &zero}}
	closing := row{Kind: "count", Data: data{Phase: "Ende", Amount: &end, Fields: map[string]string{"countScope": "all"}}}
	settlement := row{ID: pooledSettlement, Kind: "income", Data: data{Amount: &end}}
	if err := validateSettlement([]row{wallet, opening, closing, settlement}); err != nil {
		t.Fatal(err)
	}
	pooledStart := row{Kind: "count", Data: data{Phase: "Anfang", Amount: &zero, Fields: map[string]string{"countScope": "all"}}}
	for _, rows := range [][]row{
		{wallet, closing},
		{wallet, opening, closing, pooledStart},
		{wallet, opening, closing, {Kind: "count", Data: data{Wallet: "w", Phase: "Ende", Amount: &end}}},
		{wallet, opening, closing, {ID: "settlement:w", Kind: "income", Data: data{Amount: &end}}},
		{wallet, closing, {Kind: "count", Data: data{Wallet: "other", Phase: "Anfang", Amount: &zero}}},
	} {
		if _, known := pooledRevenue(rows); known {
			t.Fatal("ambiguous or missing pooled opening accepted")
		}
	}
	if err := validateSettlement([]row{wallet, opening, closing}); err == nil {
		t.Fatal("closing without a booked pooled settlement accepted")
	}
	if err := validateSettlement([]row{{Kind: "attachment"}}); err == nil {
		t.Fatal("closing with missing attachment accepted")
	}
}

func TestWalletTransferBetweenOpeningCounts(t *testing.T) {
	n := int64(100)
	zero := int64(0)
	day := "2026-06-01"
	rows := []row{
		{ID: "a", Kind: "wallet"}, {ID: "b", Kind: "wallet"},
		{Kind: "count", Data: data{Wallet: "a", Phase: "Anfang", Date: day, PostingOrder: 2, Amount: &zero}},
		{Kind: "count", Data: data{Wallet: "b", Phase: "Anfang", Date: day, PostingOrder: 4, Amount: &zero}},
		{Kind: "supply", Data: data{Wallet: "a", Date: day, PostingOrder: 1, Amount: &n}},
		{Kind: "transfer", Data: data{Account: "a", To: "b", Date: day, PostingOrder: 3, Amount: &n}},
		{Kind: "count", Data: data{Phase: "Ende", Fields: map[string]string{"countScope": "all"}, Date: day, PostingOrder: 5, Amount: &zero}},
	}
	if got, known := pooledRevenue(rows); !known || got != n {
		t.Fatalf("pooled settlement %d (%t)", got, known)
	}
	rows = append(rows, row{Kind: "donation", Data: data{Method: "Bar", Date: day, PostingOrder: 3, Amount: &n}})
	if _, known := pooledRevenue(rows); known {
		t.Fatal("unassigned cash between wallet openings must be reviewed")
	}
	rows = append(rows, row{Kind: "count", Data: data{Phase: "Ende", Wallet: "a", Date: day, PostingOrder: 5, Amount: &zero}})
	if got, known := walletRevenue(rows, "a"); !known || got != n {
		t.Fatalf("wallet settlement %d (%t)", got, known)
	}
}

func TestUnknownPostingOrderRequiresReconciliation(t *testing.T) {
	amount := int64(100)
	for _, day := range []string{"2026-05-01", "2026-05-03"} {
		start := row{Kind: "count", Data: data{Wallet: "w", Phase: "Anfang", Date: "2026-05-01", PostingOrder: 1, Amount: &amount}}
		end := row{Kind: "count", Data: data{Wallet: "w", Phase: "Ende", Date: "2026-05-03", PostingOrder: 3, Amount: &amount}}
		supply := row{Kind: "supply", Data: data{Wallet: "w", Date: day, Amount: &amount}}
		rows := []row{{Kind: "wallet", ID: "w"}, start, end, supply}
		if _, ok := walletRevenue(rows, "w"); ok {
			t.Fatalf("unknown order %s on individual settlement", day)
		}
		rows[2].Data.Wallet = ""
		rows[2].Data.Fields = map[string]string{"countScope": "all"}
		if _, ok := pooledRevenue(rows); ok {
			t.Fatalf("unknown order %s with separate openings", day)
		}
		rows[1].Data.Wallet = ""
		rows[1].Data.Fields = map[string]string{"countScope": "all"}
		if _, ok := pooledRevenue(rows); ok {
			t.Fatalf("unknown order %s on pooled settlement", day)
		}
		rows[3].Data.Date = "2026-05-02"
		if got, ok := pooledRevenue(rows); !ok || got != -amount {
			t.Fatal("distinct posting dates have a known order")
		}
	}
}
