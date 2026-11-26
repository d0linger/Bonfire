package main

import (
	"bytes"
	"testing"
)

func TestLoginIdentitiesAreScoped(t *testing.T) {
	pair, source, account := loginIdentities("fixture-source", "cashier")
	otherPair, otherSource, sameAccount := loginIdentities("second-source", "cashier")
	if bytes.Equal(pair, otherPair) || bytes.Equal(source, otherSource) || !bytes.Equal(account, sameAccount) || bytes.Equal(pair, source) || bytes.Equal(source, account) {
		t.Fatal("login counters must distinguish source, account and pair")
	}
}
