# Betrieb und Wiederanlauf

## Installation und Zuständigkeit

Der ausgelieferte Stack ist eine lokale Entwicklungsinstallation. PostgreSQL speichert synchronisierte Einträge und Originaldateien. Jede vorbereitete PWA hält zusätzlich einen verschlüsselten, gerätebezogenen Bestand. Ein Veranstaltungsserver benötigt einen stabilen HTTPS-Origin im lokalen WLAN, ein auf den Geräten vertrauenswürdiges Zertifikat und genau eine zuständige Schreibinstanz. Der mitgelieferte Stack bindet seinen Webport an Loopback. Ein Zielnetz und eine öffentliche Domäne wurden nicht festgelegt.

Die Leitung richtet Arbeitsbereiche, Benutzer, Kontenoption und Nummern ein. Zur Prüfung erhält eine separate Person die Rolle Prüfung und Freigaben für die betroffenen Arbeitsbereiche. Für Spendenmeldedaten muss die Leitung ein eigenes berechtigtes Gerät vorbereiten. Die Webanwendung verbindet sich als `bonfire_runtime`. Schemaänderungen führt der kurzlebige Compose-Dienst `migrate` mit dem Datenbankeigentümer aus.

## Vor einer Veranstaltung

1. Sicherung erzeugen und eine Wiederherstellung prüfen. Zeitpunkt, Softwarestand, Schlüsselverantwortung und Sicherungsziel intern festhalten.
2. Arbeitsbereiche, frei gewählte Perioden, Eröffnungswerte, Konten, Geldtaschen und Zuständigkeiten prüfen. Nur geklärte Preise freigeben. Originalformulare und Rechtstexte benötigen die Freigabe der verantwortlichen Stelle.
3. Jedes Gerät mit eigenem Profil vorbereiten. Daten abgleichen, den gewünschten Vorlagenstand anheften und unter **Gerät & Sync** die Offlinebereitschaft prüfen. Netz trennen, PWA vollständig beenden und erneut öffnen. Bei Formular- oder Druckbedarf die konkrete Ausgabe auf demselben Gerät erproben.
4. Gerätepasswort sicher verwahren. Verschlüsseltes Gerätearchiv zusätzlich sichern. Auf dem Server fehlen während der Trennung die dort noch nicht bestätigten Vorgänge und Dateien.

## Abschluss und Gerätevorfälle

Jedes beteiligte Gerät übermittelt nach Ende der Erfassung seine ausstehenden Daten und bestätigt das Erfassungsende. Die Leitung klärt Konflikte mit Gegenüberstellung und Begründung. Die Prüfrolle vergleicht unabhängig erhobene Istwerte und gibt den passenden Zeitraum frei. Eine Wiederöffnung benötigt einen dokumentierten Grund. Das Nummernregister zeigt die reservierten Digital- und Papierbereiche je Gerät. Papierbelege auf bereits erfasste Zahlungen beziehen.

Bei Geräteverlust den Vorfall im zugehörigen Arbeitsbereich dokumentieren, den letzten Abgleich prüfen und die Rechte am Server entziehen. Eine getrennte PWA erfährt den Entzug erst bei erneuter Verbindung. Mit einem vorhandenen Gerätearchiv kann der geschützte Lesemodus die lokalen Daten und Originale prüfen. Die Wiederherstellung vergibt keine neue Schreib- oder Ausstellungsbefugnis und ersetzt keine Bestätigung des fehlenden Geräts. Die verantwortliche Stelle muss den Umgang mit der verbleibenden Lücke entscheiden.

## Wiederanlauf aus einer Sicherung

1. Laufende Instanz und offene Geräte erfassen. Bei einem tatsächlichen Wechsel zuerst die bisherige Schreibinstanz vom Netz trennen. Geräten bis zur Prüfung der neuen Zuständigkeit keinen zweiten Schreibserver anbieten.
2. Eine zweite Installation mit dem geprüften Git-Stand und einem eigenen Compose-Projektnamen, Port und Datenvolume aufsetzen. Den Wiederherstellungsschlüssel getrennt vom verschlüsselten Archiv bereitstellen.
3. Das Archiv auf dem geschützten Ziel authentisieren und entschlüsseln. Einen bislang unbenutzten Dateinamen in einem verschlüsselten temporären Verzeichnis wählen.

   ```powershell
   node ops/crypt.mjs decrypt X:/Schluessel/bonfire.key Y:/Sicherungen/stand.dump.enc Z:/Wiederanlauf/pruefung.dump
   ./ops/restore-test.ps1 -Path Z:/Wiederanlauf/pruefung.dump
   ```

4. Das Skript gibt den Namen einer neu angelegten Datenbank aus. Aktive Arbeitsdaten werden dabei erhalten. Für einen automatisierten Entwicklungsnachweis führt `verify-restore.ps1` zusätzlich die gespeicherten synthetischen Wiederholungsfälle gegen den Testklon aus. Dazu gehören die passenden lokalen Testfixtures. Ein unabhängig restauriertes Betriebsarchiv mit den zugehörigen ursprünglichen Kontrollsummen, Perioden, Gerätelisten und Ausstellungsregistern prüfen.
5. Für die technische Umschaltung die geprüfte Zieldatenbank in den Verbindungszeichenfolgen des Migrations- und App-Dienstes einstellen. DB-Admin und Laufzeitrolle getrennt halten. Den Migrationsdienst für die geprüfte Zieldatenbank ausführen. Erst nach Freigabe den bekannten HTTPS-Origin umschalten und Geräte nacheinander abgleichen. Bei Rückstand werden lokal archivierte Geräteoperationen mit derselben ID/Sequenz wiederholt. Fehlt lokale Historie, den Bestand zur Klärung erhalten.
6. Ergebnis und Verantwortliche protokollieren. Arbeitskopien, Sicherungsdateien und Schlüssel nach der festgelegten lokalen Aufbewahrung behandeln. Offene Geräte, die während der Sicherung getrennt waren, gesondert prüfen.

## Überwachung

`/health` prüft die Datenbankverbindung. `/metrics` liefert aggregierte Werte für Datenbankgröße, Konflikte, Geräte, Server-/Syncfehler und den letzten protokollierten Datenbankdump. Der Zeitpunkt des Dumps allein belegt keine erfolgreiche externe Aufbewahrung. Für den verschlüsselten Rotationslauf daher zusätzlich den Exitstatus des Hostjobs und das Vorhandensein des verschlüsselten Archivs überwachen. Reale Alarmempfänger, Uhrzeiten, Aufbewahrungsfrist und Schlüsselhinterlegung legt der Betrieb fest. Der lokale Prometheus kann ohne Nachrichtenübermittlung geprüft werden.
