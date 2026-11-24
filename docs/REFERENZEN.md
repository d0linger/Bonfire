# Abgleich der Referenzprojekte

Geprüft wurden die lokal bereitgestellten Git-Bäume von Parkrr und Treckrr auf `dev`. Der Paketstand ist 1.0, die Auftragsfassung 0.5 und die maßgebliche Exportfassung 0.4. Die private Ablage liegt neben diesem Checkout.

| Baustein | Nachweis | Entscheidung für BONFIRE |
| --- | --- | --- |
| PostgreSQL-Treiber | Parkrr, `go.mod`, pgx v5.13.0 | Version übernehmen. Eigene Ereignis- und Abgleichtransaktionen implementieren. |
| Passwort und Wiederherstellung | Parkrr, `internal/auth/backupcodes.go`; in `go.mod` sind OTP und WebAuthn aufgeführt | Eigene Rollen-, Sitzungs- und Recoverylogik. Die Offlinefreigabe ist an Benutzer, Veranstaltung und Gerät gebunden. |
| Sicherung | Treckrr, `internal/backup/durability.go`, `ops_integration_test.go`; Parkrr, `internal/backup/audit_test.go` | Eigene PostgreSQL-Sicherung mit Wiederherstellungstest und zusätzlicher lokaler Gerätesicherung. |
| Deployment und Tests | Treckrr, `Dockerfile`, `compose.e2e.yml`, `e2e/` | Compose-Testinstallation und getrennte Browserprofile. |
| Merge und Sicherheit | Beide GitHub-Repositories, Settings im Einrichtungsschritt geprüft | main als Standard, dev als Arbeitsbranch, zusätzliche PR-Pflicht auf main. Lokale Dependency-Konfiguration für die nun tatsächlich vorhandenen Ökosysteme. |

Der zweite lokale Vergleich auf `dev` verwendete Parkrr `ed48172` und Treckrr `646069a`. Beide pinnen die Actions für Checkout und Dependency Review auf Commit-Hashes, lesen Repositoryinhalte mit minimalen Rechten und lassen hoch eingestufte Abhängigkeitsfunde einen PR-Check fehlschlagen. BONFIRE übernimmt diese Konfiguration, die historische Geheimnissuche ohne PR-Kommentar und die wöchentliche Prüfung der Go-Abhängigkeiten. Zusätzlich prüft BONFIRE seinen npm-Lockfile und führt den verschlüsselten Restore im Testworkflow aus. Dependabot berücksichtigt auch Compose-Images. Ein PostgreSQL-Hauptversionswechsel erfordert eine bewusste Migration. Die Konfiguration liegt lokal auf `dev`.

Diese Übernahmeprüfung belegt die genannten Komponenten und Entscheidungen. Eine Gleichwertigkeit mit den Sicherheits- und Betriebsfunktionen beider Bestandsprodukte ist nicht abgenommen.
