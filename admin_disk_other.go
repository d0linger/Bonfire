//go:build !linux

package main

func appDiskCapacity() map[string]uint64    { return nil }
func diskCapacity(string) map[string]uint64 { return nil }
