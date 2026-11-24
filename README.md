# BONFIRE · Feuerwehrfinanzen

Lokale Entwicklungsinstallation für eine Feuerwehr mit einer zuständigen PostgreSQL-Datenbank. Der Lieferstand und die Grenzen der Finanz-, Offline- und Vorlagenfunktionen stehen in [der Statusmatrix](docs/IMPLEMENTIERUNGSSTATUS.csv), in der [Einzelprüfung der 111 Akzeptanzkriterien](docs/AKZEPTANZ.csv) und im [Prüfbericht](docs/ABNAHME.md).

## Lokaler Start

Voraussetzungen sind Docker mit Compose und für die folgenden Betriebsbefehle PowerShell 7.4 oder neuer. Im Verzeichnis dieses Repositorys ausführen.

```powershell
./ops/init.ps1
docker compose up -d --build --wait
```

Auf bestehenden Entwicklungsinstallationen die vorhandene `.env` weiterverwenden. Die Oberfläche öffnet unter [localhost:8137](http://localhost:8137). Der Dienst `migrate` richtet Schema und Rollen ein und beendet sich anschließend. Der HTTP-Dienst läuft mit der eingeschränkten Datenbankrolle `bonfire_runtime`. `init.ps1` ergänzt deren Zufallskennwort auch bei bestehenden Entwicklungsinstallationen. Die erste Anmeldung verwendet `leitung` und den lokal generierten Wert von `BONFIRE_ADMIN_PASSWORD` aus `.env`. Das Startpasswort wird beim ersten Einrichten der Datenbank gehasht. Die Entwicklungsumgebung bindet den HTTP-Port an die Loopback-Adresse.

## Von der Veranstaltung zum Abgleich

1. Als Leitung anmelden und einen Arbeitsbereich mit frei wählbarem Zeitraum anlegen. Für laufende Buchungen außerhalb von Veranstaltungen steht das allgemeine Kassenbuch zur Auswahl. Die Kontozuordnung ist einstellbar. Bei Bedarf eigene Benutzer für Kassa oder Prüfung anlegen und der Veranstaltung zuweisen.
2. Jeden vorgesehenen Browser separat vorbereiten. Ein eigenes lokales Passwort schützt den verschlüsselten Gerätespeicher. Das Offlinepaket muss beim Vorbereiten vollständig installiert sein. Die zeitlich begrenzte Freigabe gilt für den gewählten Arbeitsbereich. Mit persönlicher Onlineanmeldung kann ein unverändert berechtigtes Gerät dieselbe Freigabe verlängern. Nummern und ausstehende Vorgänge bleiben zugeordnet. Der Button „Gerät sperren“ verwirft den entsperrten Speicher im Tab.
3. Geldtaschen und Bars anlegen und vor der Trennung auf allen Geräten abgleichen. Danach lassen sich Journal, Stückelung, Zählungen, Kontakte, Spenden, Forderungen und Artikel lokal bearbeiten. Gerätespeicher und Browserprofil auch nach Veranstaltungsende bis zur Prüfung erhalten.
4. Unter **Dokumente** den Fachvorgang wählen. Die elf Profile erzeugen PDF oder DOCX lokal. Geänderte Vorlagen werden als Entwürfe gespeichert. Die Leitung gibt Fassungen frei. Andere Geräte übernehmen einen neuen Vorlagenstand ausdrücklich. Für Korrekturbelege sind Vorgänger und Grund erforderlich. Nummerierte Testoriginale werden mit beiden Dateiformaten verschlüsselt gespeichert und anschließend angeboten. Der gemeinsame Abgleich übernimmt die Dateien ins Archiv.
5. Unter **Gerät & Sync** ausstehende Vorgänge übertragen und den Stand anderer Geräte abrufen. Bei einer konkurrierenden Änderung sieht die Leitung die gespeicherte Fassung und den Vorschlag. Eine begründete Entscheidung wird protokolliert.
6. Eröffnungs- und Istbestand erfassen. Jedes vorbereitete Gerät bestätigt nach der letzten Erfassung sein Ende. Der Veranstaltungsabschluss verlangt eine Prüfrolle, passende Istbestände, alle Gerätesiegel und einen konfliktfreien Abgleich. Bei Geräteverlust sperrt die Leitung das Profil und dokumentiert die Lücke. Nach der Rückkehr prüft sie nachgereichte Vorgänge einzeln. Das Gerät bestätigt sein Erfassungsende selbst. Ein Erfassungsende darf erst nach tatsächlichem Abschluss der Arbeit bestätigt werden.
7. Prüfpaket, Journal und Importvorschau stehen unter **Datenaustausch**. Die Vorschau zeigt Herkunft und Prüffälle. Die ausdrücklich bestätigte Übernahme einer geeigneten Zeile verknüpft die Buchung mit dem Quellstand. Im Entwicklungstest ausschließlich mit erfundenen Beispielen arbeiten.

## Entwicklung und Tests

```powershell
go test ./...
go vet ./...
npm ci
npm test
npm run build
node tests/api.mjs
node tests/accounts.mjs
node tests/import.mjs
node tests/security.mjs
node tests/incidents.mjs
node tests/donation-reports.mjs
node tests/wallet-settlement.mjs
node tests/prices.mjs
node tests/conflict-originals.mjs
node tests/lifecycle.mjs
node tests/account-mode.mjs
node tests/carry-forward.mjs
node tests/attachments.mjs
node tests/layout-limits.mjs
npx playwright install chromium
node tests/offline.mjs
node tests/documents.mjs
node tests/storage.mjs
node tests/word-layout.mjs
./ops/verify-restore.ps1 -Path test-results/abnahme.dump
```

Die API- und Browserprüfungen arbeiten gegen den laufenden lokalen Stack und verwenden neue erfundene Datensätze. Der Restore benötigt API-Fixture und mindestens ein synchronisiertes Original aus dem Browsertest. Der Dump-Pfad muss neu sein. Optional bezeichnet `BONFIRE_BROWSER` die ausführbare Datei eines bereits installierten Chromium-Browsers. Die Tests geben keine Gerätekennwörter oder Beleginhalte aus.

Mit `node ops/seed.mjs` kann eine lokale Übungsveranstaltung angelegt werden. Geräteprofile werden je Browser vorbereitet. Die Leitung kann einem Profil bei der Vorbereitung Zugriff auf Spendenmeldedaten geben. Unter **Gerät & Sync** lässt sich der Stand von Nummern, Cache und Speicher prüfen. Als verloren gemeldete Geräte bleiben für den Abschluss sichtbar. Für ein verloren gegangenes Offlineprofil bleibt die Wiederherstellung als verschlüsseltes Lesearchiv verfügbar.

Für Dankesbriefe unterstützt der lokale Word-Layoutimport A4-DOCX mit Tabellen, PNG/JPEG, Kopf-/Fußteilen und expliziten Seitenumbrüchen. BONFIRE-Felder in doppelten geschweiften Klammern dürfen über mehrere Word-Textläufe verteilt sein. Im Entwurfsmodus lassen sich beide Formate vor der Freigabe prüfen. Das DOCX bleibt editierbar. Für das PDF dieser importierten Layouts werden die gerenderten Seiten lokal als Bilder eingebettet. Die Standardprofile erzeugen PDF mit auswählbarem Text.

## Betrieb, Aktualisierung und Sicherung

- **Datenhaltung.** PostgreSQL enthält Vorgänge, Revisionen, Konflikte, Audit, Gerätestände, Originaldateien und Anhänge. Der Browser speichert ein mit AES-GCM verschlüsseltes Profil in IndexedDB. Die lokale Schlüsselableitung verwendet PBKDF2-SHA256, zufälliges Salt und 600.000 Iterationen. Browserdaten können vom Betriebssystem entfernt werden. Vor einem Geräteeinsatz Speichererhalt, Neustart und Sicherung auf genau diesem Gerät prüfen.
- **Sicherung.** `./ops/backup.ps1 -Path <neuer-Pfad.dump>` erstellt einen konsistenten Datenbankdump und gibt seinen SHA-256-Wert aus. Dump, verwendeten Git-Stand, Imageversionen und Zugangskonfiguration geschützt verwahren. Datenbanksicherungen enthalten sensible Daten im Klartext. Lokale Outboxen finden sich nur in den separat verschlüsselten Gerätesicherungen. Der offizielle Geräte-Wiederherstellungsweg öffnet diese als Lesearchiv.
- **Wiederherstellung.** `./ops/restore-test.ps1 -Path <Sicherung>` legt eine neue Datenbank mit eigenem Namen an. `verify-restore.ps1` führt zusätzlich eine isolierte App mit Loopback-Port gegen den Klon aus, vergleicht Originalhashes und prüft Gerätewiederholungen. Der Prüfcontainer wird beendet. Die isolierte Datenbank bleibt zur Nachprüfung verfügbar. Im Ernstfall muss der alte Schreibserver vor der Umschaltung außer Betrieb sein.
- **Aktualisierung.** Zuerst lokale Ausstände abgleichen, Sicherung anlegen und die Wiederherstellung prüfen. `docker compose up -d --build --wait` startet die neue Version. Der Server prüft die Versionshashes der transaktionalen Migrationen. Für einen Rückweg eine kompatible App und die zugehörige Sicherung zusammen in einer separaten Instanz prüfen.
- **Monitoring.** `/health` prüft die aktive Datenbankverbindung. `/metrics` liefert offene Konflikte und Gerätestände, Synchronisationsfehler, Datenbankgröße und letzten Sicherungszeitpunkt. Mit `docker compose -f compose.yaml -f compose.monitoring.yaml up -d` startet zusätzlich der lokale Prometheus auf Port 9137 mit Alarmregeln. Eine externe Alarmzustellung benötigt ein Betriebsziel. Diagnoseprotokolle enthalten keine Nutzdaten. Compose meldet den Gesundheitszustand beider Dienste mit `docker compose ps`.
- **Veranstaltungs-WLAN.** Für weitere Geräte ist ein vertrauenswürdiger HTTPS-Endpunkt vor genau dieser Instanz erforderlich. Im lokalen DNS denselben stabilen Namen auf den Veranstaltungsserver auflösen und Zertifikatsvertrauen auf jedem Gerät prüfen. Ein Wechsel des Origins erzeugt einen anderen lokalen Browserspeicher. Die aktuelle Compose-Datei ist für localhost bestimmt.
- **Git.** Lokale Arbeit auf `dev`, Übernahme nach `main` per Pull Request. Übergabepaket, Privatquellen, Kennwörter, DB-Dumps und Testprofile gehören außerhalb des Git-Bestands.

## Verschlüsselter Sicherungslauf

Für die Sicherungswerkzeuge wird zusätzlich Node.js ab Version 22 benötigt. Beispiel für den Betrieb unter PowerShell aus dem Repositoryverzeichnis. Schlüsselverzeichnis und Sicherungsziel vorab mit passenden Zugriffsrechten bereitstellen. Ein Wiederherstellungsschlüssel benötigt eine separate, zugriffsgeschützte Kopie.

```powershell
node ops/crypt.mjs keygen X:/Schluessel/bonfire.key
./ops/rotate-backup.ps1 -Directory Y:/Sicherungen -KeyFile X:/Schluessel/bonfire.key -RetentionDays 30
./ops/verify-restore.ps1 -Path Y:/Sicherungen/<Dateiname>.dump.enc -KeyFile X:/Schluessel/bonfire.key
```

Der Rotationslauf erstellt einen konsistenten Custom-Dump und verschlüsselt ihn mit AES-256-GCM. Nach erfolgreicher Sicherung entfernt er eigene Archivdateien im gewählten Ziel, deren Alter die Aufbewahrungsfrist überschreitet. Der Prüflauf authentisiert das Archiv vor der Wiederherstellung. Die hostseitige Aufgabenplanung kann denselben Rotationsbefehl mit dem Repository als Arbeitsverzeichnis ausführen. Für die temporäre Klartextdatei ein zugriffsgeschütztes, verschlüsseltes Laufwerk verwenden. Dateizugriffsrechte für Schlüssel, Sicherungsziel und temporäres Verzeichnis liegen beim Betriebskonto.

Die [Betriebsanleitung](docs/BETRIEB.md) beschreibt Rollen, Sicherungsprüfung und den Wiederanlauf auf separater Hardware.

## Technische Entscheidungen

Go mit pgx, PostgreSQL und ein statisch gebündelter Browserclient halten die einzelne Schreibinstanz und den autonomen Offlinebetrieb getrennt. Beim Abgleich serialisiert eine Zeilensperre die Vorgänge derselben Veranstaltung. Der Server prüft Gerätefolge, Operationsidentität, Digest, erwartete Revision und fachliche Grenzen. Eine ID mit geändertem Inhalt wird abgelehnt. Gleich hohe Beträge verschiedener Vorgänge behalten eigene Identitäten.

Die produktbezogene Marke kommt ausschließlich aus `lucide@1.17.0` (Flame), mit dokumentierten Farben, Abmessungen und Strichstärke 1,7. Der Build erzeugt das transparente SVG und Raster-Icons in 32, 192 und 512 Pixeln. SHA-256 des SVG ist `f12b47ae30d1c088420b3407eae7ad912218208440d851c8c848772ec7f46119`. Die Wortmarke nutzt die übergebenen HTML-Schriftparameter. Renderer und Marke werden lokal gebündelt.

Die Cache-Navigation verwendet den kanonischen Pfad `/`. Die bereitgestellte Anwendung öffnet so auch nach Beenden des Browsers mit getrenntem Server. Quellen zu den eingesetzten Mechanismen: [Cache.addAll](https://developer.mozilla.org/en-US/docs/Web/API/Cache/addAll), [IndexedDB-Transaktionen](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction), [PostgreSQL-Zeilensperren](https://www.postgresql.org/docs/current/explicit-locking.html).
