# Referenzübernahme

| Bereich | Geprüfter Stand und Quelle | Entscheidung und Nachweis |
| --- | --- | --- |
| README / About | Parkrr ed481721 und Treckrr 646069ad, README.md und GitHub-About | Zentrierte Originalmarke, englische Kurzbeschreibung, Workflowbadge und Vorschau nach dem gemeinsamen Schema. BONFIRE-Bedienung und Betrieb bleiben deutsch. Eigene Angaben und Topics, kein Offline-Topic. |
| CI / Container | Parkrr ed481721, .github/workflows/ci.yml | Prüfsummengesicherter Trivy-Download als Vorbild für die lokalen Container, ohne Deployment. |
| Anmeldung / Sicherung | Parkrr ed481721, internal/auth und internal/backup, Treckrr 646069ad, internal/backup | Eigene Implementierung mit Online-Rollen, Sitzungen und verschlüsseltem PostgreSQL-Restore. Geprüft über ops/accept-online.ps1. |
| Betriebsdokumentation | Household 9388e61e, README.md | Gliederung für Migration, Backup, Restore und Rechte verglichen. Eigenständige BONFIRE-Betriebsbefehle. |

Die lokalen Referenzquellen und öffentlichen About-Metadaten waren lesbar. Die Referenzprojekte haben eigene Lizenzdateien. Die konzeptionelle Übernahme begründet keine Lizenzwahl für BONFIRE. Weitere Komponenten und Quellpfade sind im [früheren Referenzvergleich](REFERENZEN.md) dokumentiert.
