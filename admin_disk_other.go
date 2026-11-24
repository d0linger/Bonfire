//go:build !linux

package main

func appDiskCapacity() map[string]uint64 { return nil }
