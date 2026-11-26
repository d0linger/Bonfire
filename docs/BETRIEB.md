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

## Recovering an installation

For a **BONFIRE2** archive from the backup worker, restore the installation's backup-key volume from protected storage first. Use **Administration → Backup → Restore** to select or upload the encrypted archive. Run the restore rehearsal and inspect the integrity results, installation identity and original document hashes. During an approved maintenance window, stop incoming writes, confirm the restore using the administrator password and sign in again. The worker preserves the displaced database and invalidates old sessions. Check the fiscal year, balances, document originals, audit chain and a fresh backup against the recovered database.

The legacy host rotation script produces **BONFIRE1** archives. Only for this format, use `ops/verify-restore.ps1 -Path <archive> -KeyFile <legacy-key>` to decrypt and verify in a separate database. The worker uses a different archive format and key. For a manual database switch, stop the app and the backup worker, set the same verified target database for the migration service, the app and the backup worker, and retain their distinct database roles. Apply migrations, recreate the app and worker, verify read access and perform a fresh backup and restore rehearsal before reopening writes. Keep the original database available for rollback.

## Monitoring

`/health` checks the database connection. `/metrics` exposes aggregate database size, unresolved conflicts, device state and backup freshness. The online alert uses `bonfire_online_request_errors_total`, which counts server errors (HTTP 5xx) on POST requests to the online workspace. Permission denials, validation errors and ordinary revision conflicts do not increment it. Monitor archive retention and the result of a restore rehearsal alongside the completion timestamp. The host rotation job records the digest only after it produces the encrypted archive.
