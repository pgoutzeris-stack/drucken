# ROOTS Print

Drucken und Scannen am ROOTS-Netzwerkdrucker aus dem Browser: Warteschlangen und
Treiberoptionen aus CUPS, Scannen über AirScan/eSCL mit Vorschau und Download,
Auftragsliste und Netzdiagnose.

- Oberfläche: https://pgoutzeris-stack.github.io/drucken/
- Zugang: Im Intranet übergibt `roots-user-bridge.js` die Sitzung (Aufruf mit
  `?authBroker=v1`, kein zweites Login). Direkt geöffnet fragt das Tool E-Mail und
  Passwort des ROOTS-Kontos ab. Zugelassen sind nur Adressen der Domänen
  `roots-consultants.com` und `roots-consultants.de`.

## Zwei Wege zum Gerät

Ein Browser erreicht einen AirPrint-Drucker nicht direkt: die Seite läuft über
HTTPS, der Drucker spricht HTTP unter einem mDNS-Namen (`Canonebc1a3.local`), und
CUPS (`lp`, `lpstat`) ist aus JavaScript überhaupt nicht ansprechbar. Supabase
allein hilft nicht — Edge Functions laufen in der Cloud und kommen nie in das
Büro-LAN. Es braucht immer einen Prozess im Netz des Druckers. Die Frage ist nur,
auf wie vielen Rechnern er läuft.

**Warteschlange (Standard, empfohlen)**

```
Browser (überall) ──► Supabase: print.jobs + print.job_pages
                            ▲ pollt
        Agent auf einem Rechner im Büro ──► Drucker (lp / eSCL)
```

Niemand installiert etwas, das Tool läuft in Safari, in der Mac-App, am Handy und
von zuhause. Ein Rechner im Büro muss den Agenten laufen haben.

**Lokaler Helfer**

```
Browser ──► 127.0.0.1:7331 (Helfer) ──► Drucker
```

Ohne Cloud, sofort, aber nur auf dem eigenen Mac und nur in Browsern, die den
Zugriff auf 127.0.0.1 erlauben. Safari verbietet ihn von einer HTTPS-Seite; dort
das Tool direkt über **http://127.0.0.1:7331** öffnen — der Helfer liefert
dieselben Dateien aus.

Das Tool nimmt automatisch den Helfer, wenn er antwortet, sonst die
Warteschlange. Unter „Verbindung“ lässt sich der Weg festnageln.

## Ganz ohne Rechner im Büro

Ein Browser oder eine Edge Function erreicht den Drucker nie direkt: er hängt in
einem privaten Netz hinter NAT, und aus der Cloud lässt sich keine Verbindung
dorthin aufbauen. Etwas im Netz des Druckers muss die Verbindung nach außen
herstellen. Dieses „Etwas" muss aber kein Mac sein — und es muss nicht einmal im
Büro stehen:

**Agent auf einer Cloud-Maschine, Tunnel über den Router.** Die FRITZ!Box kann ab
FRITZ!OS 7.56 WireGuard. Eine kleine Cloud-Maschine wählt sich als
WireGuard-Gegenstelle ein und erreicht den Drucker dann wie ein Gerät im Büro. Im
Büro läuft dafür nichts außer Router und Drucker.

1. Drucker im Router auf eine feste IP festlegen (hier `192.168.178.21`).
2. FRITZ!Box: Internet › Freigaben › VPN (WireGuard) › Verbindung für die
   Cloud-Maschine anlegen, Konfigurationsdatei herunterladen.
3. Auf der Cloud-Maschine WireGuard starten, dann prüfen:
   `curl http://192.168.178.21/eSCL/ScannerStatus`
4. CUPS installieren und `~/.roots-print/agent.json` anlegen — siehe
   `bridge/agent.example.json`. Mit `printers` überspringt der Agent die
   mDNS-Suche (die über den Tunnel nicht funktioniert) und legt die
   CUPS-Warteschlange selbst an (`ipp://<IP>/ipp/print`).
5. `node bridge/roots-print-agent.js` starten und den Hash im Tool freischalten.

Was das kostet: eine kleine Maschine (ab etwa 4 € im Monat) und ein Tunnel, der
Zugang in das Büronetz gibt — wird die Maschine übernommen, hängt sie im
Firmennetz. Deshalb den Tunnel auf die Drucker-IP begrenzen und die Maschine
sonst dicht halten.

**Alternative ohne Cloud-Maschine und ohne Tunnel:** ein kleines Dauergerät im
Büro, etwa ein Raspberry Pi Zero 2 W (einmalig etwa 25 €) oder ein
ausgedientes Telefon. Gleicher Agent, keine monatlichen Kosten, mDNS funktioniert.

**Ganz ohne Agent, aber nur für Scans:** Der Drucker kann Scans selbst
verschicken (Scan to E-Mail, FTP, geteilter Ordner). Ein Eingangs-Webhook für
E-Mail plus eine Edge Function könnte sie in `print.job_pages` ablegen. Gestartet
wird der Scan dann am Gerät, nicht im Browser.

**Ganz ohne Agent, auch für Druck:** Das gibt es nur mit Canons eigener Cloud
(uniFLOW Online; der MF732Cdw ist über den Universal Login Manager kompatibel).
Dort holt sich das Gerät die Aufträge selbst. Kostet Abo über einen
Canon-Partner, und die Aufträge laufen über Canons Cloud statt über dieses Tool.

## Agent im Büro einrichten

```bash
git clone https://github.com/pgoutzeris-stack/drucken.git
cd drucken
node bridge/roots-print-agent.js      # Node >= 18, keine Abhängigkeiten
```

Beim ersten Start legt der Agent ein Token in `~/.roots-print/agent-token` (0600)
an und zeigt dessen SHA-256-Hash. Ein Admin trägt den Hash im Tool unter
„Verbindung → Agent freischalten“ ein. Das Token selbst verlässt den Rechner
nicht, ein Service-Key wird nirgends gebraucht.

Hash erneut anzeigen:

```bash
node bridge/roots-print-agent.js --hash
```

Dauerhaft im Hintergrund: `bash bridge/install.sh` (installiert den lokalen
Helfer als LaunchAgent; für den Agenten dieselbe Datei mit
`roots-print-agent.js` als Programm).

## Lokalen Helfer starten

```bash
node bridge/roots-print-bridge.js
```

Token steht in `~/.roots-print/token` und wird im Tool unter „Verbindung“
eingesetzt. Anderer Port: `ROOTS_PRINT_PORT=7332 node bridge/roots-print-bridge.js`

## Dateien

| Datei | Zweck |
|---|---|
| `index.html`, `app.js`, `config.js` | Oberfläche, beide Wege |
| `relay.js` | Client für die Warteschlange in Supabase |
| `bridge/device-lib.js` | Gerätezugriff: CUPS, mDNS, eSCL |
| `bridge/roots-print-bridge.js` | Lokaler Helfer, HTTP auf 127.0.0.1 |
| `bridge/roots-print-agent.js` | Agent, arbeitet die Warteschlange ab |
| `supabase/print-schema.sql` | Schema, Policies und Funktionen |

## Berechtigungen

| Ebene | Prüfung |
|---|---|
| Oberfläche | Im Intranet die übergebene Supabase-Sitzung, sonst eigene Anmeldung |
| Konto | E-Mail-Domäne muss in `ALLOWED_EMAIL_DOMAINS` stehen |
| Warteschlange | RLS: jeder sieht nur eigene Aufträge und Seiten; Einstellen nur mit Profil im Intranet |
| Agent | Eigenes Token, Hash liegt in `print.agents`; Freischalten nur mit `app_role = 'admin'` |
| Lokaler Helfer | Bearer-Token, Bindung nur an 127.0.0.1, CORS nur Intranet-Origin und localhost |

Grenzen der Warteschlange: 25 MB pro Datei und pro Scanseite, Aufträge und Seiten
werden nach drei Tagen gelöscht (`print.cleanup`, nachts per `pg_cron`).

## Fehlerbilder

| Meldung im Tool | Ursache | Lösung |
|---|---|---|
| Agent offline | Prozess im Büro läuft nicht | `node bridge/roots-print-agent.js` starten |
| Kein Drucker gemeldet | Agent nie gelaufen oder nicht freigeschaltet | Hash unter „Agent freischalten“ eintragen |
| Datei größer als 25 MB | Grenze der Warteschlange | Kleiner exportieren oder über den lokalen Helfer drucken |
| Helfer offline | Lokaler Helfer läuft nicht | Warteschlange nutzen oder Helfer starten |
| Browser blockiert 127.0.0.1 | Safari mit HTTPS-Seite | Warteschlange nutzen oder `http://127.0.0.1:7331` öffnen |
| Kein Scanner gemeldet | Drucker schläft, anderes WLAN, AP-Isolation | Gerät wecken, Agent neu starten, Diagnose lesen |
| Vorlageneinzug ist leer | Kein Papier im Einzug | Papier einlegen oder Flachbett wählen |
| Scanner ist beschäftigt | Auftrag läuft am Gerät | Warten, Display am Gerät prüfen |
| Warteschlange nimmt keine Aufträge an | Drucker pausiert | `cupsenable <Warteschlange>` |
| Dieses Konto hat kein Profil im Intranet | Konto ohne `profiles`-Zeile | Admin legt das Profil im Intranet an |

## Getestet gegen

Canon MF732C/734C/735C (eSCL 2.62, `Canonebc1a3.local`), macOS 14, Node 20:
Optionen aus `lpoptions` gelesen, Druckauftrag über `lp` angenommen (gehalten und
storniert), Scan über Flachbett und Einzug mit Vorschau und Download — beide Wege,
lokaler Helfer und Warteschlange. Ein Scan über die Warteschlange brauchte vom
Einstellen bis „fertig“ 10,7 Sekunden.
