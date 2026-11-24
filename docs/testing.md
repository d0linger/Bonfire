# Teststrategie

Die Prüfinstallation arbeitet mit PostgreSQL und synthetischen Daten. Der dokumentierte Start verwendet PowerShell 7, Docker Compose, Node und die Go-Version aus go.mod. Unter Linux bündeln die Make-Targets die nachstehenden Prüfungen. Unter Windows lassen sich die enthaltenen Befehle direkt ausführen.

| Prüfung | Auftrag und Einstieg |
| --- | --- |
| Formatierung und statische Prüfung | make lint prüft Go-Formatierung, go vet und JavaScript-Syntax. |
| Go und JavaScript | make test führt Go mit Race Detector und Coverage sowie die Node-Tests aus. Für den Race Detector wird ein C-Compiler benötigt. |
| Finanzen | make test-finance verwendet unabhängige Sollbeträge. tests/cash-vectors.json wird von Go und JavaScript gelesen. |
| Integration, E2E, Verbindungsabbruch und Restore | Nach npm ci und npx playwright install chromium die lokale Konfiguration mit ./ops/init.ps1 anlegen. make test-integration startet die isolierte Suite. test-connectivity, test-e2e und test-restore nutzen denselben Ablauf. tests/online-api.mjs prüft konkurrierende Buchungen, tests/year-workplace.mjs unterbricht die Antwort im Browser. |
| Dokumente | make test-documents prüft den Austausch und die Word-Darstellung im Browser. Physische Drucke und echte Mobilgeräte brauchen eigene Abnahmen. |
| Abhängigkeiten | make test-security führt govulncheck und npm audit aus. |
| Gesamtprüfung | make check |

Bei einem Fehlschlag nennt der Online-Prüflauf den betroffenen Suite-Namen und entfernt seine eigenen Testvolumes. Testarchive, Schlüssel und lokale Zugangsdaten bleiben außerhalb von Git. Coverage im bisherigen Go-Hauptpaket erfasst nur die instrumentierten Go-Tests. HTTP-Aufrufe gegen das separate Compose-Image erhöhen diesen Wert nicht. 90 % für Rechenlogik und 80 % für handgeschriebene Anwendungslogik sind Abnahmeziele.
