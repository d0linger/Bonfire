//go:build linux

package main

import (
	"math"
	"syscall"
)

// These figures describe the app filesystem. PostgreSQL may use another volume.
func appDiskCapacity() map[string]uint64 { return diskCapacity("/") }

func diskCapacity(path string) map[string]uint64 {
	var s syscall.Statfs_t
	if err := syscall.Statfs(path, &s); err != nil {
		return nil
	}
	if s.Bsize <= 0 {
		return nil
	}
	size := uint64(s.Bsize)
	if s.Blocks > math.MaxUint64/size || s.Bavail > math.MaxUint64/size {
		return nil
	}
	return map[string]uint64{"total": s.Blocks * size, "free": s.Bavail * size}
}
