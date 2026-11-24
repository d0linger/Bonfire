# BONFIRE · Offene Punkte für die beiden Kassiere

Planungsstand 24.11.2026, bezogen auf den lokalen Stand `15d2997`. Grundlage sind die fachliche Klärung zu Kassenbuch, Veranstaltungen, Kontakten, Feuerwehrkonten und Dokumenten sowie die später freigegebenen Änderungen. Die genannten Masken sind Vorschläge. Für eine Abnahme werden ausschließlich erfundene Daten verwendet.

## Stand nach Umsetzung

Die fünf Arbeitspakete sind in der Anwendung umgesetzt. Die Bedienwege stehen in der [Anleitung](../README.md). Die folgenden Abschnitte dokumentieren den Ausgangspunkt und den freigegebenen Umfang. Der [Abnahmebericht](ABNAHME.md) und die Statuszeilen BF-045 bis BF-049 enthalten die Nachweise und die ausstehende praktische Abnahme.

## Bereits nutzbar

Das allgemeine Kassenbuch und die Veranstaltungen haben getrennte Buchungswege innerhalb eines frei definierbaren Geschäftsjahrs. Offene Jahre und Veranstaltungen sind bearbeitbar. Anfangsbestand, Istbestand, Übernahme aus dem Vorjahr, Abschluss und Wiederöffnung sind vorhanden. Sponsoringforderungen, Zahlungen und Festspenden sind unter **Zahlungen & Kosten** zusammengeführt. Das zentrale Kontaktverzeichnis, elf Exportprofile, PDF/DOCX und der Originalbelegablauf bilden die Grundlage.

Bei Geldtaschen funktionieren Einzel- und Gesamtzählung, Gruppierung nach Bar, Nachversorgung und die Wahl zwischen Betrag und Stückelung samt Schnelltasten. Für diese Abläufe besteht bereits eine automatisierte Abnahme. Sie bleiben Ausgangspunkt für die folgenden Erweiterungen.

## 1. Rechnungssteller und Anschrift im Buchungsalltag

**Heute.** Bezeichnung und Notiz können einen Lieferanten und den Einkaufszweck aufnehmen. Das Kontaktformular hat ein gemeinsames Feld für die Anschrift. Ein eigenes Rechnungsstellerfeld sowie getrennte Adresszeilen fehlen.

**Oberfläche.** Im Ausgaben-Popup von Kassenbuch und Veranstaltung stehen **Betrag**, **Rechnungssteller** und **Wofür?** zusammen. Beispiel mit erfundenen Daten: „Markt am Turm“ und „Getränke fürs Übungsfest“. Häufige Rechnungssteller sollen als Vorschlag erscheinen, ein einmaliger Einkauf per Freitext möglich sein. Im Kontakt-Popup stehen **Name/Firma**, **Straße und Hausnummer**, **PLZ** und **Ort**. Die Belegvorschau zeigt Straße und PLZ/Ort in zwei Zeilen. Im Veranstaltungsmenü bleibt die zentrale Kontaktauswahl beim Sponsoring.

**Abnahme.** Eine Ausgabe in beiden Arbeitsbereichen speichern, wieder öffnen und nach dem Rechnungssteller finden. Eine bestehende Freitextadresse auch ohne nachträgliche Aufteilung vollständig anzeigen. Die Änderung eines Kontakts darf ein bereits ausgestelltes Original nicht verändern.

## 2. Feuerwehrkonten und Jahresabgleich

**Heute.** Konten sind Einträge eines Arbeitsbereichs. Kontozuordnung, Transfers, Soll-/Ist-Prüfung und Vorjahresübernahme existieren. Für Handkassa, Bankkonto und Sparbuch fehlt eine gemeinsame Kontenpflege mit einer durchgängigen Jahressicht über Kassenbuch und Feste.

**Oberfläche.** Unter **Verwaltung → Feuerwehrkonten** legt ein Admin die Konten einmal an. Im Buchungsdialog steht das passende aktive Konto zur Auswahl, wenn die Kontozuordnung eingeschaltet ist. Unter **Geschäftsjahr → Kontenabgleich** gibt es je Konto die Spalten **Anfang**, **Eingänge**, **Ausgänge**, **interne Bewegungen**, **Soll**, **Ist** und **Differenz**. Ein Klick auf eine Differenz öffnet die zugehörigen Bewegungen aus Kassenbuch und Festen. Vor der Übernahme ins Folgejahr sieht der Kassier die bestätigten Schlussbestände je Konto.

**Umsetzung und Abnahme.** Bestehende Arbeitsbereichskonten ausdrücklich den Feuerwehrkonten zuordnen. Eine reine Namensgleichheit genügt dafür nicht. Eine Einzahlung von 300 € aus der Handkassa aufs Bankkonto senkt die Handkassa um 300 € und erhöht das Bankkonto um 300 €. Gesamtbestand und Ergebnis bleiben gleich. Ein Festumsatz erscheint einmal im Jahresabgleich. Die spätere Übergabe des Bargelds an die Handkassa ist ein Transfer. Bei abgeschalteter Kontozuordnung bleibt der Gesamtabgleich nutzbar.

## 3. Festabrechnung und Bankomat

**Heute.** Zählungen, direkte Barergebnisse, Kosten, Vorverkauf, Kartenzahlungen, Gebühren und Anbieterauszahlungen sind vorhanden. Für die gewünschte Festabrechnung fehlen eine gemeinsame nachvollziehbare Darstellung und der ausdrückliche Vorgang für an Gäste ausgezahltes Bargeld.

**Oberfläche.** Unter **Fest → Abschluss → Festabrechnung** stehen zwei Blöcke. **Bargeld** zeigt Anfangswechselgeld, Nachversorgung, Abschöpfungen und gezählten Endbestand. **Festergebnis** zeigt die daraus ermittelten Bareinnahmen, Vorverkauf, gezahltes Sponsoring, weitere Einnahmen, direkte Kosten und Gebühren. Jede Zeile öffnet ihre Buchungen. Bei Einzelzählung ist die Aufschlüsselung nach Börse und Bar möglich. Bei gemeinsamer Endzählung steht das Ergebnis auf Festebene. Gemeinsame Festkosten werden keiner Bar zugerechnet.

Vor dem Fest zeigt **Wechselgeld vorbereiten** den bereits aus den Börsenplänen berechenbaren Bedarf je Nennwert mit **benötigt**, **vorhanden** und **noch zu beschaffen**. Wer ausschließlich Gesamtbeträge erfasst, sieht den benötigten Eurobetrag. Fehlende Stückzahlen bleiben offen.

**Bankomat.** Für den beschriebenen Fall ist die geplante Aktion **Bargeld an Gast auszahlen**. Der Kassier wählt Geldtasche, Betrag und Terminal. Das Bargeld sinkt, bis zur Bankgutschrift steht eine Forderung an den Zahlungsanbieter offen. Der Eingang am Bankkonto gleicht diese aus. Eine allfällige Gebühr wird getrennt erfasst. Eine Abhebung vom eigenen Bankkonto zum Beschaffen von Wechselgeld bleibt ein anderer, einfacher Transfer.

**Abnahme.** Anfangswechselgeld, Nachversorgung, Kartenvorverkauf, bereits gebuchte Barspende, bezahlte und offene Sponsoringforderung sowie Terminalgutschrift in einem Testfest kombinieren. Vorverkauf und Sponsoring nur insoweit hinzurechnen, wie sie nicht schon im abgeleiteten Barerlös enthalten sind. Bei einer Barauszahlung von 50 € an einen Gast entstehen 0 € Erlös. Die Abrechnung muss bei gemeinsamem Zählen und beim Summieren identischer Einzelzählungen auf dasselbe Festergebnis kommen.

## 4. Belege direkt bei Spende, Rechnung und Zahlung

**Heute.** Beim Sponsoring führt **Rechnung öffnen** bereits in den Dokumentenbereich. Spendenbeleg, Rechnungsprofile für Barzahlung und Überweisung, Originalarchiv und Nachdruck sind vorhanden. Der direkte Ablauf ab einer Spendenzeile, die allgemeine Zahlungsbestätigung und die gezielte Übergabe der gespeicherten Datei an Mail oder Messenger sind auszubauen.

**Oberfläche.** Bei einer Kassenbuchspende öffnet **Spendenbeleg** ein Popup mit vorausgewählter Buchung, berechtigter Kontaktauswahl, Anschrift, Betrag und Vorschau. Bei einer Sponsoringforderung führt **Rechnung** zur Rechnung mit Leistungspositionen, bei einem Zahlungseingang **Zahlung bestätigen** zum tatsächlich erhaltenen Betrag. Eine allgemeine Ausgangsrechnung soll auch außerhalb einer Sponsoringzusage ausgestellt werden können. Nach der Originalausgabe stehen **PDF speichern**, **DOCX speichern** und auf unterstützten Geräten **Teilen** bereit. Am PC ist der PDF-Download für den manuellen Mailanhang verfügbar.

**Abnahme.** Eine erfundene Spende und eine teilweise bezahlte Rechnung vom Eintrag bis zum archivierten Original durchspielen. Die Bestätigung über eine Teilzahlung weist nur den eingegangenen Betrag aus. Erneutes Herunterladen oder Teilen verwendet dieselbe Datei und Nummer. Das Öffnen des Teilen-Menüs erzeugt keinen Versandnachweis. Für Tests erfolgt keine tatsächliche Übermittlung.

## 5. Vorlagen, Preislisten und Veranstaltung kopieren

**Heute.** Es gibt elf anpassbare Profile, Preisstände, Druckvorschau und ein Kopieren der Veranstaltungsstruktur. Getränkekarten unterstützen bereits bis zu drei und Essenskarten bis zu sieben Exemplare pro Blatt. Die Gästepreisliste hat eine Papierauswahl. Der Import eines freien Word-Layouts ist bisher auf den Dankesbrief begrenzt. Im Kopierdialog ist die aktuelle Veranstaltung die Quelle, ihr Name fehlt im Formular.

**Oberfläche.** Eine zentrale **Vorlagenbibliothek** zeigt Profil, freigegebene Version und Vorschau. Im Fest wählt man **Vorlage übernehmen**, danach für die Preisliste **Ganzes Blatt** oder eine zum Papierformat passende **Anzahl je Blatt**. Beispielbelege dienen lokal dem Layoutvergleich. Beim Kopieren steht oben **Quelle: Übungsfest 2026**. Darunter stehen **Zielname**, **Geschäftsjahr**, **Zeitraum** und die zu übernehmenden Elemente, etwa Bars, Börsen und Preisentwürfe.

**Abnahme.** Alle elf Profile mit erfundenen Daten als PDF und DOCX ausgeben und gegen die freigegebenen Muster vergleichen. Preislisten im Einzel- und Mehrfachdruck auf Lesbarkeit, Seitenumbrüche und Zuschnitt prüfen. Ein kopiertes Fest hat eigene Stammdaten und einen eindeutig bezeichneten Vorlagenstand. Es startet ohne Buchungen, Spenderdaten, Zählstände und ausgestellte Originale.

## Reihenfolge und Freigabe

Zuerst Buchungsfelder, Kontakte und Kontenzuordnung vereinheitlichen. Darauf bauen Kontenabgleich und Festabrechnung auf. Belege und Vorlagen können nach Festlegung der Kontaktfelder parallel zur Festabrechnung entstehen. Die sichtbare Kopierquelle ist eine kleine, unabhängig vorziehbare Änderung.

Ein gemeinsamer Abnahmelauf verbindet anschließend eine Ausgabe, eine Spende, ein Testfest, den Bankabgleich, die Originalbelege und die Übernahme ins Folgejahr. Automatisierte Finanz-, Rechte- und Browsertests und die praktische Abnahme mit den beiden Kassieren auf Handy, PC und Drucker werden getrennt dokumentiert. Der Offlinebetrieb ist auf Wunsch zurückgestellt. Die weitergehenden Betriebs- und Pilotnachweise bleiben in der bestehenden Statusmatrix geführt.

Grundlagen im Repository: [Bedienungsanleitung](../README.md), [Statusmatrix](IMPLEMENTIERUNGSSTATUS.csv), [Abnahmekriterien](AKZEPTANZ.csv), [Testnachweise](ABNAHME.md).
