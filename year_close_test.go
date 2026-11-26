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
