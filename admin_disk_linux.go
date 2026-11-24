//go:build linux

package main

import "syscall"

// These figures describe the app filesystem. PostgreSQL may use another volume.
func appDiskCapacity() map[string]uint64 {
	var s syscall.Statfs_t
	if err := syscall.Statfs("/", &s); err != nil {
		return nil
	}
	return map[string]uint64{"total": s.Blocks * uint64(s.Bsize), "free": s.Bavail * uint64(s.Bsize)}
}
