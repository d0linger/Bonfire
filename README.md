# BONFIRE · Feuerwehrfinanzen

Lokale Entwicklungsinstallation für eine Feuerwehr mit einer zuständigen PostgreSQL-Datenbank. Der Lieferstand und die Grenzen der Finanz-, Offline- und Vorlagenfunktionen stehen in [der Statusmatrix](docs/IMPLEMENTIERUNGSSTATUS.csv), in der [Einzelprüfung der 111 Akzeptanzkriterien](docs/AKZEPTANZ.csv) und im [Prüfbericht](docs/ABNAHME.md).

## Lokaler Start

Voraussetzungen sind Docker mit Compose und für die folgenden Betriebsbefehle PowerShell 7.4 oder neuer. Im Verzeichnis dieses Repositorys ausführen.

```powershell
./ops/init.ps1
docker compose up -d --build --wait
```

Auf bestehenden Entwicklungsinstallationen die vorhandene `.env` weiterverwenden. Die Oberfläche öffnet unter [localhost:8137](http://localhost:8137). Der Dienst `migrate` richtet Schema und Rollen ein und beendet sich anschließend. Der HTTP-Dienst läuft mit der eingeschränkten Datenbankrolle `bonfire_runtime`. `init.ps1` ergänzt deren Zufallskennwort auch bei bestehenden Entwicklungsinstallationen. Die erste Anmeldung verwendet `leitung` und den lokal generierten Wert von `BONFIRE_ADMIN_PASSWORD` aus `.env`. Das Startpasswort wird beim ersten Einrichten der Datenbank gehasht. Die Entwicklungsumgebung bindet den HTTP-Port an die Loopback-Adresse.

## Von der Anmeldung zum Finanzarbeitsplatz

Der halb gefüllte Kreis oben rechts schaltet mit einem Klick zwischen Hell- und Dunkelmodus um. Bis zur ersten manuellen Auswahl folgt BONFIRE dem Betriebssystem. Die Auswahl gilt im jeweiligen Browser für Anmeldung und Arbeitsplatz und bleibt nach einem Neustart erhalten.

1. Mit E-Mail-Adresse oder bestehendem Kontonamen und Passwort anmelden. Bei aktiviertem MFA folgt der Authenticator- oder Recoverycode.
2. Unter **Geschäftsjahre** eine Bezeichnung, den ersten und den letzten Tag eingeben. Beide Tage gehören zum Jahr. Geschäftsjahre können kürzer oder länger als zwölf Monate sein. Eine Überschneidung wird abgewiesen. Für den Zeitraum entsteht ein allgemeines Kassenbuch.
3. In der linken Navigation unter dem BONFIRE-Logo das Geschäftsjahr auswählen. Unter der Bezeichnung steht der Zeitraum; bei 2027 beispielsweise 01.11.2026 – 31.12. Unter **Kassenbuch** buchen beide Kassiere in das allgemeine Kassenbuch des gewählten Jahres. Für ein Fest **Veranstaltungen → Fest auswählen → Veranstaltungsbuchungen öffnen** wählen. Auch Kontakte, Spenden und Dokumente des Fests sind dort als Reiter erreichbar. Die Seitenleiste führt zurück zum allgemeinen Jahresbereich. Im Erfassungsdialog stehen Buchungsziel und Geschäftsjahr. Nach dem Neuladen bleibt das Jahr ausgewählt. Wer ausschließlich für Veranstaltungen freigeschaltet ist, wählt das Fest aus der Liste.
4. **Speichern** überträgt die Buchung direkt an PostgreSQL. Bei unterbrochener Verbindung ist keine Buchung möglich. Beide Kassiere können im selben zugewiesenen Arbeitsbereich buchen. **Serverstand aktualisieren** lädt die Buchungen des anderen Kontos. Berechtigungen lassen sich unter **Verwaltung → Benutzer** zuweisen.
5. Vorhandene Arbeitsbereiche ohne Jahresbezug stehen unter **Geschäftsjahr → Geschäftsjahre öffnen → Bisherige Arbeitsbereiche** bereit. Ein Admin kann sie einem passenden Jahr zuordnen. Dabei werden der Veranstaltungszeitraum und bestehende Finanzbuchungen geprüft.

Der Offlinebetrieb ist vorerst deaktiviert. Bereits vorhandene verschlüsselte Geräteprofile bleiben im jeweiligen Browser erhalten. Ausschließlich dort gespeicherte Altvorgänge erscheinen erst nach einer gesonderten Übernahme im zentralen Kassenbuch. Für die Weiterarbeit das Browserprofil aufbewahren.

## Konto und Sicherheit

Beide Kassiere öffnen ihr eigenes Konto links unter ihrem Namen. Das funktioniert auch vor der Zuweisung eines Arbeitsbereichs.

- **Passwort ändern** verlangt das aktuelle Passwort und bei aktivierter Zwei-Faktor-Anmeldung zusätzlich einen Authenticator- oder Recoverycode. Die aktuelle Sitzung erhält ein neues Cookie. Andere Sitzungen enden.
- **Authenticator einrichten** zeigt einen lokal erzeugten QR-Code und einen manuellen Schlüssel. Den sechsstelligen Code der App bestätigen und die acht einmal angezeigten Recoverycodes sicher verwahren. Jeder Recoverycode kann einmal verwendet werden. Erneuern ersetzt den gesamten Satz.
- **Passkey hinzufügen** vergibt einen Namen für den Schlüssel. Anschließend im Browser mit dem Gerät oder einem Sicherheitsschlüssel bestätigen. Bei der nächsten Anmeldung **Mit Passkey anmelden** wählen. Unter **Passkeys** stehen registrierte Schlüssel und ihre letzte Verwendung.
- **Aktive Sitzungen** zeigt Browser, Beginn, Ablauf und die aktuelle Sitzung. Andere Sitzungen lassen sich einzeln oder zusammen beenden.

Für Passkeys lokal immer dieselbe Adresse verwenden: `http://localhost:8137`. Eine Installation unter eigener HTTPS-Adresse setzt `BONFIRE_PASSKEY_ORIGIN` auf die von den Browsern verwendete Origin einschließlich eines abweichenden Ports. Ein vollständiger Restore stellt auch die registrierten Passkeys des Sicherungszeitpunkts wieder her. Nach dem Restore zwischenzeitlich entfernte Schlüssel prüfen.

## Verwaltung

Unter **Verwaltung → Benutzer** wählt ein Admin die Rolle und die freigegebenen Arbeitsbereiche eines Kontos.

| Rolle | Berechtigung |
| --- | --- |
| **Admin** | Verwaltet die gesamte Installation einschließlich Benutzern, Geschäftsjahren, Veranstaltungen, Backups und Systemstatus. Darf buchen, Konflikte klären und Abschlüsse freigeben. |
| **Write** | Darf in zugewiesenen Kassenbüchern und Veranstaltungen Geldbewegungen erfassen und Fachdaten bearbeiten. Kann das Audit dieser Arbeitsbereiche einsehen. |
| **Read** | Darf Daten und Audit der zugewiesenen Arbeitsbereiche einsehen. Buchungen, Änderungen an Fachdaten und Abschlussfreigaben sind gesperrt. |

Alle drei Rollen verwalten ihr eigenes Passwort, MFA, Passkeys und ihre Sitzungen unter **Konto und Sicherheit**. Bei der Aktualisierung übernimmt BONFIRE bestehende Konten und Zuweisungen. **Leitung** wird **Admin**, **Kassa** wird **Write** und **Prüfung** wird **Read**. Veranstaltungs- und Periodenabschlüsse sowie Ausnahmeentscheidungen bei Gerätevorfällen gibt künftig ein Admin frei. Der bisherige Anmeldename bleibt gültig.

Die Sicherungen umfassen den gesamten Serverbestand mit seinen Geschäftsjahren. Eine Restore-Probe läuft in einer getrennten Datenbank. Die [Anleitung für Backup und Wiederherstellung](docs/VERWALTUNG-BACKUP.md) beschreibt Verschlüsselung, Schlüsselverwahrung und S3-Konfiguration. Die [Anleitung für Audit und Systemstatus](docs/VERWALTUNG-AUDIT.md) erklärt Filter, Rechte und Integritätsprüfungen.

Für einen vollständigen S3-Probelauf mit einem lokalen S3-kompatiblen Dienst und einem eigenen Test-Bucket `./ops/accept-s3.ps1` ausführen.

## Entwicklung und Tests

Der folgende Abnahmelauf erstellt eigene Compose-Projekte für Online- und Offlineprüfungen mit jeweils leerer Datenbank und zufälligem Loopback-Port. Er entfernt anschließend die Testvolumes. Erzeugte Berichte, Screenshots und Sicherungen liegen lokal unter `test-results/`. Bestehende Testeinträge aus früheren Läufen in einer Arbeitsinstallation bleiben dort erhalten.

```powershell
go test ./...
go vet ./...
npm ci
npm test
npm run build
npx playwright install chromium
./ops/acceptance.ps1
```

Die API- und Browserprüfungen arbeiten gegen den laufenden lokalen Stack und verwenden neue erfundene Datensätze. Die gesonderte historische Offlineprüfung verwendet ihre eigene API-Fixture und ein synchronisiertes Original aus dem Browsertest. Der Dump-Pfad muss neu sein. Optional bezeichnet `BONFIRE_BROWSER` die ausführbare Datei eines bereits installierten Chromium-Browsers. Die Tests geben keine Gerätekennwörter oder Beleginhalte aus.

Eine optionale Übungsveranstaltung für eine isolierte lokale Installation erzeugt `node ops/seed.mjs`. `./ops/accept-online.ps1` prüft den normalen Jahres- und Buchungsablauf. Die vollständige Abnahme aktiviert den historischen Offlinebetrieb zusätzlich in einer getrennten Prüfinstallation.

Für Dankesbriefe unterstützt der lokale Word-Layoutimport A4-DOCX mit Tabellen, PNG/JPEG, Kopf-/Fußteilen und expliziten Seitenumbrüchen. BONFIRE-Felder in doppelten geschweiften Klammern dürfen über mehrere Word-Textläufe verteilt sein. Im Entwurfsmodus lassen sich beide Formate vor der Freigabe prüfen. Das DOCX bleibt editierbar. Für das PDF dieser importierten Layouts werden die gerenderten Seiten lokal als Bilder eingebettet. Die Standardprofile erzeugen PDF mit auswählbarem Text.

## Betrieb, Aktualisierung und Sicherung

- **Datenhaltung.** PostgreSQL enthält Vorgänge, Revisionen, Konflikte, Audit, Gerätestände, Originaldateien und Anhänge. Im aktuellen Onlinebetrieb bestätigt der Server jede Buchung. Alte, nur lokal vorliegende Gerätesicherungen gesondert aufbewahren.
- **Sicherung.** `./ops/backup.ps1 -Path <neuer-Pfad.dump>` erstellt einen konsistenten Datenbankdump und gibt seinen SHA-256-Wert aus. Dump, verwendeten Git-Stand, Imageversionen und Zugangskonfiguration geschützt verwahren. Datenbanksicherungen enthalten sensible Daten im Klartext. Lokale Outboxen finden sich nur in den separat verschlüsselten Gerätesicherungen. Vorhandene Gerätesicherungen bleiben bis zu einer gesonderten Wiederaufnahme des Offlinebetriebs separat verwahrt.
- **Wiederherstellung.** `./ops/restore-test.ps1 -Path <Sicherung>` legt eine neue Datenbank mit eigenem Namen an. `verify-restore.ps1` führt zusätzlich eine isolierte App mit Loopback-Port gegen den Klon aus, vergleicht Geschäftsjahre, Arbeitsbereichszuordnung und Originalhashes. Der historische Übungslauf mit `-VerifyExercise` prüft zusätzlich Gerätewiederholungen. Der Prüfcontainer wird beendet. Die isolierte Datenbank bleibt zur Nachprüfung verfügbar. Im Ernstfall muss der alte Schreibserver vor der Umschaltung außer Betrieb sein.
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
