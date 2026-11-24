# Betrieb und Wiederanlauf

## Aktueller Onlinebetrieb

Die Jahresauswahl, Anlage und Zuordnung vorhandener Arbeitsbereiche beschreibt der [lokale Einstieg](../README.md). Geschäftsjahreswahl und direkter Serverzugriff sind die Standardeinstellung. Die Anleitungen dieses Dokuments zu Geräteprofilen, Gerätesiegeln und Offlineabgleich gelten für den früheren Gerätebetrieb. Der Gerätebetrieb ist zurückgestellt. [Abgrenzung und Umgang mit Altbeständen](offline-backlog.md).

## Installation und Zuständigkeit

Der ausgelieferte Stack ist eine lokale Entwicklungsinstallation. PostgreSQL speichert synchronisierte Einträge und Originaldateien. Die aktuelle Oberfläche erfasst ausschließlich online. Frühere Geräteprofile können noch verschlüsselte, unübertragene Einträge enthalten. Ein Veranstaltungsserver benötigt einen stabilen HTTPS-Origin im lokalen WLAN, ein auf den Geräten vertrauenswürdiges Zertifikat und genau eine zuständige Schreibinstanz. Der mitgelieferte Stack bindet seinen Webport an Loopback. Ein Zielnetz und eine öffentliche Domäne wurden nicht festgelegt.

Ein Admin richtet Arbeitsbereiche, Benutzer, Kontenoption und Nummern ein. Zur Einsicht genügt **Read** mit Freigaben für die betroffenen Arbeitsbereiche. Kassiere mit **Write** können dort außerdem buchen. Für Spendenmeldedaten muss ein Admin ein eigenes berechtigtes Gerät vorbereiten. Die Webanwendung verbindet sich als `bonfire_runtime`. Schemaänderungen führt der kurzlebige Compose-Dienst `migrate` mit dem Datenbankeigentümer aus.

## Vor einer Veranstaltung

1. Sicherung erzeugen und eine Wiederherstellung prüfen. Zeitpunkt, Softwarestand, Schlüsselverantwortung und Sicherungsziel intern festhalten.
2. Arbeitsbereiche, frei gewählte Perioden, Eröffnungswerte, Konten und Geldtaschen prüfen. Beide Kassiere können im zugewiesenen Arbeitsbereich auf alle Geldtaschen buchen. Nur geklärte Preise freigeben. Originalformulare und Rechtstexte benötigen die Freigabe der verantwortlichen Stelle.
3. Jedes Gerät mit eigenem Profil vorbereiten. Daten abgleichen, den gewünschten Vorlagenstand anheften und unter **Gerät & Sync** die Offlinebereitschaft prüfen. Netz trennen, PWA vollständig beenden und erneut öffnen. Bei Formular- oder Druckbedarf die konkrete Ausgabe auf demselben Gerät erproben.
4. Gerätepasswort sicher verwahren. Verschlüsseltes Gerätearchiv zusätzlich sichern. Auf dem Server fehlen während der Trennung die dort noch nicht bestätigten Vorgänge und Dateien.

## Abschluss und Gerätevorfälle

Jedes beteiligte Gerät übermittelt nach Ende der Erfassung seine ausstehenden Daten und bestätigt das Erfassungsende. Ein Admin klärt Konflikte mit Gegenüberstellung und Begründung. Ein Admin vergleicht unabhängig erhobene Istwerte und gibt den passenden Zeitraum frei. Eine Wiederöffnung benötigt einen dokumentierten Grund. Das Nummernregister zeigt die reservierten Digital- und Papierbereiche je Gerät. Papierbelege auf bereits erfasste Zahlungen beziehen.

Bei Geräteverlust den Vorfall im zugehörigen Arbeitsbereich dokumentieren, den letzten Abgleich prüfen und die Rechte am Server entziehen. Eine getrennte PWA erfährt den Entzug erst bei erneuter Verbindung. Mit einem vorhandenen Gerätearchiv kann der geschützte Lesemodus die lokalen Daten und Originale prüfen. Die Wiederherstellung vergibt keine neue Schreib- oder Ausstellungsbefugnis und ersetzt keine Bestätigung des fehlenden Geräts. Unter **Gerät & Sync** meldet ein Admin das betroffene Gerät als vermisst. Ein Admin kann die Rekonstruktion und verbleibende Lücke dokumentieren. Der Bereich bleibt bis zur Rückmeldung unvollständig. Bei physischer Rückkehr gibt ein Admin das Gerät zur Einzelprüfung frei. Die zugehörige Person meldet sich auf demselben Profil erneut an. Der neue Geräteschlüssel ersetzt den bisherigen. Nachgereichte Vorgänge bleiben bis zur begründeten Entscheidung eines Admins in der Konfliktliste. Anschließend bestätigt das zurückgekehrte Gerät seinen letzten Sequenzstand.

## Spenden prüfen und exportieren

Im vorbereiteten Meldedatenprofil unter **Datenaustausch → Spendenmeldedaten** den Meldezeitraum laden. Die Vorschau nennt meldbare Einzelbeträge und ausgeschlossene Vorgänge. Anonyme Spenden erscheinen dort nur mit Kennung und Ausschlussgrund. Ein Admin prüft die Liste, dokumentiert einen Prüfvermerk und gibt den Export frei. Beim Abruf verifiziert der Browser die SHA-256-Prüfsumme der gespeicherten JSON-Datei. Für eine extern erfolgte Übermittlung oder Bestätigung einen separaten Nachweis hinterlegen. Änderungen erfordern einen begründeten Korrekturlauf. Frühere freigegebene Dateien bleiben unter ihrem Prüflauf abrufbar.

## Belegübertragung und Gerätereserve

Bei der Vorbereitung lässt sich die benötigte Zahl digitaler Belegnummern zwischen 0 und 1000 wählen. Der Papierkreis bleibt getrennt. Unter **Dokumente** zeigt jedes Profil die noch verfügbaren Digitalnummern. Nach Verbrauch des Bereichs sind weiter Arbeitsfassungen und Nachdrucke möglich.

Neue PDF-, JPEG- und PNG-Anhänge werden lokal zusammen mit ihren Metadaten gespeichert. Der Server bestätigt die Metadaten und anschließend die mit Länge und SHA-256 geprüfte Datei. Andere Geräte sehen während der Unterbrechung den ausständigen Dateistand. Der nächste Abgleich setzt die Übertragung fort. Ein fehlender Anhang verhindert den vollständigen Abschluss.

## Strittige Originalbelege und frühere Preisstände

Bei doppelten Belegen die Zahlungsreferenz und beide Fassungen unter **Gerät & Sync** prüfen. Ein Admin entscheidet über die finanzielle Wirkung. Über **Strittige Originalfassungen laden** können berechtigte Personen PDF und DOCX anhand der Vorgangskennung erneut abrufen. Spendenoriginale benötigen ein Meldedatenprofil. Das Nummernregister enthält auch die Nummern geklärter Konfliktfassungen.

Für Karten und Gästepreislisten steht im Dokumentformular der beim letzten Abgleich übernommene Preisverlauf zur Auswahl. Bei Widersprüchen zwischen zwei Portionsangaben die Quellangaben separat erhalten, die zutreffende Ausgabeeinheit eintragen und die Entscheidung begründen. Die erste Migration archiviert den vorhandenen Preisstand. Frühere Ausgaben bleiben als vorhandene Dateien belegt.

Unter **Kontakte & Preise** können Name, Adresse und dokumentierte Abgrenzung in der Kontaktauswahl gesucht werden. Gleichnamige Offline-Neuanlagen prüft ein Admin. Eine begründete getrennte Neuanlage behält beide Adressen. Bei Sponsoringforderungen zeigt die Anwendung Zusage, Zahlungen, offenen Rest und je nummeriertem Beleg den externen Übergabevermerk. Eine tatsächlich erfolgte Übergabe wird mit Nachweis manuell erfasst. Ein Korrekturbeleg erhält einen eigenen Versandstand.

Bei einer freigegebenen Importzeile sichert der Server die Quellenstelle über alle Veranstaltungen gegen Doppelübernahme. Ein Admin kann die Quelldatei im eigenen Arbeitsbereich prüfen. Ein Kassenprofil erhält die Quellenreferenz. Formeln, Summenzeilen und Folgevorlagen bleiben in der historischen Vorschau Vergleichsdaten.

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
