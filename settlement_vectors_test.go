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
