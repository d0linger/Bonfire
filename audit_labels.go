package main

// Audit actions are retained verbatim in the sealed journal. The audit query
// uses these labels for both display and search, before applying pagination.
var auditLabels = func() map[string]string {
	labels := map[string]string{
		"Übernommen": "Accepted", "Konflikt": "Conflict", "Geklärt": "Resolved", "Abgewiesen": "Rejected", "Fehlgeschlagen": "Failed", "Erfolgreich": "Successful",
		"Anmeldung erfolgreich": "Signed in", "Anmeldung abgewiesen": "Sign-in denied", "Abmeldung": "Signed out",
		"Eigenes Passwort geändert": "Changed own password", "Eigener Authenticator deaktiviert": "Disabled own authenticator",
		"Eigene Recoverycodes erneuert": "Regenerated recovery codes", "Eigene Sitzung widerrufen": "Revoked own session",
		"Andere eigene Sitzungen widerrufen": "Revoked other sessions", "Authenticator eingerichtet": "Authenticator set up", "TOTP eingerichtet": "Authenticator set up",
		"Passkey eingerichtet": "Passkey registered", "Passkey entfernt": "Passkey removed", "Startpasswort geändert": "Initial password changed",
		"Benutzer angelegt": "User created", "Benutzer zugewiesen": "User assigned", "Kontodaten bearbeitet": "Account updated",
		"Benutzer gesperrt": "User disabled", "Benutzer wieder aktiviert": "User reactivated", "Sitzungen widerrufen": "Sessions revoked",
		"Passwort zurückgesetzt": "Password reset", "Zweiter Faktor und Recoverycodes zurückgesetzt": "Second factor and recovery codes reset",
		"Zugriff zugewiesen": "Access granted", "Zugriff entzogen": "Access revoked", "Audit-CSV exportiert": "Audit log exported",
		"Geschäftsjahr angelegt": "Fiscal year created", "Geschäftsjahr bearbeitet": "Fiscal year updated",
		"Geschäftsjahr abgeschlossen": "Fiscal year closed", "Geschäftsjahr wieder geöffnet": "Fiscal year reopened",
		"Arbeitsbereich wieder geöffnet": "Workspace reopened", "Bestehenden Arbeitsbereich zugeordnet": "Existing workspace assigned",
		"Veranstaltung im Geschäftsjahr angelegt": "Event created in fiscal year", "Veranstaltung bearbeitet": "Event updated",
		"Veranstaltungsstruktur kopiert": "Event setup copied", "Leere Veranstaltung gelöscht": "Empty event deleted",
		"Veranstaltungsabschluss": "Event closed", "Kassenbuch abgeschlossen": "Cashbook closed",
		"Periodenabschluss": "Accounting period closed", "Periode wieder geöffnet": "Accounting period reopened",
		"Feuerwehrkonto gepflegt": "Fire brigade account updated", "Feuerwehrkonto zugeordnet": "Fire brigade account linked",
		"Jahreskontenstand erfasst": "Annual account balance recorded", "Kontozuordnung aktiviert": "Account assignment enabled",
		"Kontozuordnung deaktiviert": "Account assignment disabled", "Kontozuordnung geklärt": "Account assignment resolved",
		"Eintrag entfernt": "Entry removed", "Buchung storniert": "Booking reversed", "Eintrag umgebucht": "Entry moved",
		"Umbuchung aus Veranstaltung": "Transferred from event", "Geldbewegung berichtigt": "Financial transaction corrected",
		"Archiviert": "Archived", "Wiederhergestellt": "Restored", "Archivierte Konfliktfassung abgerufen": "Archived conflict revision retrieved",
		"beibehalten": "Kept existing version", "übernehmen": "Accepted incoming version", "Nachdruck": "Reprint",
		"Spendenprüfliste eingesehen": "Donation review list viewed", "Spendenexport abgerufen": "Donation export retrieved",
		"Wiederherstellung übernommen": "Restore applied", "Gerät vorbereitet": "Device prepared", "Gerätefreigabe erneuert": "Device authorization renewed",
		"Rückkehr abgeglichen und bestätigt": "Returning device reconciled and confirmed", "Erfassungsende": "Entry completed",
		"Gerät vermisst": "Device reported missing", "Ausnahmeentscheid – Abschluss unvollständig": "Exception recorded – closing incomplete",
		"Gerät zurück – ausstehende Vorgänge einzeln prüfen": "Device returned – review pending entries",
		"Backup · Zeitplan geändert":                         "Backup schedule changed", "Backup · Datei zur Probe hochgeladen": "Backup uploaded for verification",
	}
	for de, en := range map[string]string{"Geldbewegung": "Financial transaction", "Facheintrag": "Entry", "Belegausgabe": "Document issued"} {
		for _, result := range []string{"Übernommen", "Konflikt"} {
			labels[de+" · "+result] = en + " · " + labels[result]
		}
	}
	for de, en := range map[string]string{"Geprüft": "Reviewed", "Exportiert": "Exported", "Übermittelt": "Submitted", "Bestätigt": "Confirmed", "Korrektur": "Correction"} {
		labels["Spendenprüflauf · "+de] = "Donation review · " + en
	}
	for _, action := range []string{"backup", "probe", "promote", "test"} {
		labels["Backup · Gestartet "+action] = "Backup · started " + action
	}
	return labels
}()
