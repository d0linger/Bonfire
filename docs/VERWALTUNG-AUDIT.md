# Audit-Log und Systemstatus

**Admin** öffnet Audit und Systemstatus über **Verwaltung**. **Write** und **Read** können das Audit ihrer zugewiesenen Arbeitsbereiche einsehen und exportieren. Installationsprotokoll und Systemstatus erfordern **Admin**.

## Einen Vorgang prüfen

Nach Benutzer, Aktion, Geschäftsjahr, Arbeitsbereich und Datum filtern. „Bis einschließlich“ bezieht sich auf den ganzen Tag in Europe/Vienna. Die Suche findet unter anderem Objektkennungen und Ereignisnummern. Die Aktionsbezeichnung klappt die Details direkt unter dem Eintrag auf und wieder zu. Mehrere Einträge lassen sich gleichzeitig öffnen. Bei finanziellen Berichtigungen kommen der ursprüngliche und der berichtigte Centbetrag sowie Revisionen aus dem Storno- und Ersatzjournal. Die Zeit der Serverannahme und eine vorhandene lokale Erfassungszeit stehen getrennt in der Ansicht. Kontobezeichnungen werden aus dem zugehörigen Arbeitsbereich aufgelöst.

Der CSV-Export verwendet die aktiven Filter und den serverseitigen Berechtigungsumfang. Über 10.000 Treffer erfordern eine engere Auswahl. Der Export selbst erzeugt einen Betriebseintrag. Die Schnittstelle gibt nur ausgewählte Metadaten aus. Kontengeheimnisse, Geburtsdatenfelder, Belegdateien und komplette Datensätze werden nicht in diese Ansicht übernommen. Freitextbegründungen mit erkannten sensiblen Angaben werden ausgeblendet. Begründungen sollten ausschließlich fachlich erforderliche Informationen enthalten.

## Was die Integritätsprüfung belegt

Migration 020 erzeugt einen Ausgangsstand aus der vorhandenen Historie. Neue Ereignisse werden in derselben Datenbanktransaktion wie der fachliche Vorgang in die jeweilige SHA-256-Kette aufgenommen. Sperren pro Kette ordnen gleichzeitige Einträge. Die Prüfung liest einen konsistenten Stand, berechnet die Hashes erneut und kontrolliert Verknüpfungen, Länge, Kettenkopf und fehlende Siegel. Zum Nachweis gehören die beim Eintrag bereits vorhandenen Finanzrevisionen und unveränderlichen Operationsmetadaten. **Prüfketten prüfen** sowie **Systemstatus → Aktualisieren** lösen eine aktuelle Prüfung aus.

Die laufende Anwendung hat Leserechte auf die Siegel, der Datenbanktrigger schreibt sie. Eine nachträgliche Prüfung kann frühere, bereits vor Migration 020 veränderte Daten nicht erkennen. Wer Datenbank und sämtliche Kettenköpfe mit Eigentümerrechten ersetzen kann, kann auch einen neuen konsistenten Stand erzeugen. Unabhängig aufbewahrte verschlüsselte Sicherungen und deren Prüfwerte bleiben daher wichtige Nachweise.

## Betriebsdaten lesen

Systemstatus zeigt Build-ID der laufenden Binärdatei, Laufzeit des Prozesses, PostgreSQL-Version und Schema, Datenbankgröße, Sitzungen, Verbindungsbelegung und offene Klärfälle. Die freie Kapazität beschreibt unter Linux das Dateisystem des App-Containers. Das Datenbankvolume kann separat liegen. Zeitpunkte und letzte Ergebnisse der Ziel- und Restore-Läufe liefert der Backupdienst. Fehlende Messungen erscheinen als unbekannt. Der HTTP-Fehlerzähler gilt seit Prozessstart und umfasst auch abgewiesene Anfragen.

## Abnahme

`tests/admin-audit.mjs` prüft in einem getrennten lokalen Stack zwei Finanzrevisionen, Beträge, maskierte Begründungen, CSV, Jahres-/Arbeitsbereichssicht, Rechte, abgemeldete Sitzungen, Integrität und echte Statusmesswerte. Vor dem Aufruf `BONFIRE_URL` auf den zufälligen Loopback-Prüfport setzen. Das Skript verwendet synthetische Datensätze.
