Steuere deine JUWEL-Aquarientechnik mit Homey über die MyJUWEL-Cloud, denselben Dienst, den auch die offizielle JUWEL AppControl App nutzt.

Unterstützte Geräte

- JUWEL HeliaLux (Beleuchtung): unterstützt und getestet.
- JUWEL SmartFeed (Futterautomat): unterstützt, aber ungetestet.
- JUWEL EccoFlow (Pumpe): grundlegende Unterstützung, ungetestet.

Du hast einen SmartFeed oder eine EccoFlow? Melde, was funktioniert, unter github.com/moogblob/homey-juwel-appcontrol/issues

Was du mit einer HeliaLux machen kannst

- Die Leuchte ein- und ausschalten
- Die Gesamthelligkeit einstellen
- Eine Farbe mit dem Farbrad von Homey wählen
- Den Weißkanal getrennt einstellen
- Zwischen Zeitplan (die Leuchte folgt dem in MyJUWEL gespeicherten Tagesprofil) und Manuell (die Leuchte zeigt die in Homey eingestellten Werte) wechseln
- All das in Flows nutzen, wie bei jeder anderen Homey-Leuchte

Was du mit einem SmartFeed machen kannst

- Jetzt füttern, mit der am Gerät eingestellten Menge oder einer gewählten Menge (auch in Flows)
- Die Futtermenge einstellen, und die Menge für die Taste am Gerät
- Den Futterautomaten und seine Status-LED ein- und ausschalten
- Einen Alarm erhalten, wenn die Futterkammer leer ist oder der Futterautomat einen Fehler meldet
- Sehen, wann zuletzt gefüttert wurde, und einen Flow starten, wenn gefüttert wird
- Futterpläne können in Homey noch nicht bearbeitet werden. Nutze dafür die JUWEL App.

Was du mit einer EccoFlow machen kannst

- Die Pumpe ein- und ausschalten sowie Fütterungspause und Leistungsgrenze schalten, sofern die Pumpe das erlaubt
- Betriebsart und Durchfluss sehen
- In Flows die Betriebsart ändern und die Wartungszeitgeber zurücksetzen
- Wassertemperatur und Pumpenalarme sind nicht verfügbar, da JUWEL sie für Apps nicht beschreibt

Was dich erwartet

- Wenn du bei einer HeliaLux Farbe, Helligkeit oder Weißanteil änderst, wechselt die Leuchte in den manuellen Modus. Dieser dauert 1 Stunde, danach kehrt die Leuchte von selbst zu ihrem Zeitplan zurück, genau wie die Vorschau in der JUWEL App.
- Homey fragt den Zustand jedes Geräts standardmäßig alle 30 Sekunden in der Cloud ab. In den Geräteeinstellungen kannst du einen Wert zwischen 10 und 3600 Sekunden wählen. Eine Änderung in der JUWEL App oder direkt am Gerät kann so lange brauchen, bis sie in Homey erscheint.
- Solange eine HeliaLux im Zeitplan-Modus ist, zeigt Homey die Werte, die der manuelle Modus verwenden würde, nicht das Licht, das der Zeitplan gerade erzeugt.
- Alles läuft über die MyJUWEL-Cloud, deine Geräte und Homey brauchen also Internetzugang. Ist die Cloud nicht erreichbar, kann Homey deine Geräte nicht steuern.
- Ist ein Gerät in MyJUWEL offline, wird es in Homey als nicht verfügbar angezeigt.

Erste Schritte

1. Stelle sicher, dass deine Geräte in der offiziellen JUWEL AppControl App eingerichtet sind und funktionieren.
2. Installiere diese App und öffne ihre Einstellungen.
3. Gib die E-Mail-Adresse und das Passwort deines MyJUWEL-Kontos ein und tippe auf Speichern.
4. Füge ein Gerät hinzu, wähle HeliaLux, SmartFeed oder EccoFlow und wähle deine Geräte aus.

Lehnt MyJUWEL deine E-Mail-Adresse oder dein Passwort ab, werden deine Geräte als nicht verfügbar angezeigt, bis du die Daten in den App-Einstellungen korrigierst.

Hinweis

Dies ist eine inoffizielle Community-App. Sie wird von JUWEL Aquarium weder entwickelt noch unterstützt oder empfohlen. Sie nutzt die MyJUWEL-Cloud-API, die nicht öffentlich dokumentiert ist und sich ohne Vorankündigung ändern kann. Die Details zur API stammen aus der Home-Assistant-Integration von Melle79 (github.com/Melle79/juwel-appcontrol).
