package main

const (
	roleAdmin = "Admin"
	roleWrite = "Write"
	roleRead  = "Read"
)

// Existing clients may still submit the role names used before migration 026.
func canonicalRole(value string) string {
	switch value {
	case "Leitung":
		return roleAdmin
	case "Kassa":
		return roleWrite
	case "Prüfung":
		return roleRead
	default:
		return value
	}
}
