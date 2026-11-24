package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestCashVectors(t *testing.T) {
	raw, err := os.ReadFile("tests/cash-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name   string
		Pieces map[string]int64
		Amount int64
		Valid  bool
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			err := checkCashAmount(data{Amount: &tc.Amount, Pieces: tc.Pieces})
			if (err == nil) != tc.Valid {
				t.Fatalf("valid=%v: %v", tc.Valid, err)
			}
		})
	}
}

func FuzzCashPieces(f *testing.F) {
	f.Add("500", int64(3))
	f.Add("05", int64(-1))
	f.Fuzz(func(t *testing.T, key string, count int64) {
		// A single valid denomination must survive multiplication and validation.
		value, known := denoms[key]
		valid := known && count >= 0 && count <= 1000000
		var total int64
		if valid {
			total = value * count
		}
		err := checkCashAmount(data{Amount: &total, Pieces: map[string]int64{key: count}})
		if (err == nil) != valid {
			t.Fatalf("unexpected acceptance for %q, %d", key, count)
		}
	})
}
