# ROOTS Drucken

Drucken und Scannen am ROOTS-Netzwerkdrucker aus dem Browser: Warteschlangen und
Treiberoptionen aus CUPS, Scannen über AirScan/eSCL mit Vorschau, Download und
Netzdiagnose.

- Oberfläche: https://pgoutzeris-stack.github.io/drucken/
- Zugang: ROOTS-Konto (gemeinsames Supabase-Projekt), nur Adressen der Domänen
  `roots-consultants.com` und `roots-consultants.de`.

## Warum ein lokaler Helfer nötig ist

Eine Seite auf GitHub Pages läuft über HTTPS. Der Drucker spricht unverschlüsseltes
HTTP unter einem mDNS-Namen (`Canonebc1a3.local`), und CUPS (`lp`, `lpstat`) ist aus
JavaScript überhaupt nicht erreichbar. Der Browser blockiert diese Zugriffe:
Mixed Content, CORS, keine `.local`-Auflösung. Ein reines Frontend kann deshalb
nicht drucken oder scannen — unabhängig davon, wie es gebaut ist.

`bridge/roots-print-bridge.js` schließt die Lücke. Der Helfer läuft auf dem Mac des
Nutzers, hört ausschließlich auf `127.0.0.1`, verlangt bei jedem Aufruf ein Token
und liefert dieselbe Oberfläche zusätzlich selbst aus.

```
Browser ──HTTPS──► GitHub Pages (Oberfläche, Supabase-Login)
   │
   └──HTTP──► 127.0.0.1:7331 (Helfer) ──► CUPS (lp/lpstat)
                                     └──► Drucker eSCL (Scan) / mDNS (Suche)
```

Safari lässt Aufrufe von einer HTTPS-Seite auf `127.0.0.1` nicht zu. Dort das Tool
direkt über **http://127.0.0.1:7331** öffnen; der Helfer liefert die identischen
Dateien aus. Chrome und die Tauri-App funktionieren über beide Wege (der Helfer
antwortet auf den Private-Network-Preflight).

## Helfer starten

```bash
git clone https://github.com/pgoutzeris-stack/drucken.git
cd drucken
node bridge/roots-print-bridge.js     # Node >= 18, keine Abhängigkeiten
```

Beim ersten Start entsteht `~/.roots-print/token` (0600). Dieses Token im Tool
unter „Verbindung" einsetzen.

Dauerhaft als LaunchAgent:

```bash
bash bridge/install.sh      # entfernen: bash bridge/uninstall.sh
```

Anderer Port: `ROOTS_PRINT_PORT=7332 node bridge/roots-print-bridge.js`

## Berechtigungen

| Ebene | Prüfung |
|---|---|
| Oberfläche | Supabase-Session erforderlich, sonst nur Anmeldemaske |
| Konto | E-Mail-Domäne muss in `ALLOWED_EMAIL_DOMAINS` stehen |
| Helfer | Bearer-Token aus `~/.roots-print/token` bei jedem `/api/*`-Aufruf |
| Netz | Bindung nur an `127.0.0.1`, CORS nur für Intranet-Origin und localhost |

Der Helfer ist damit nicht aus dem Netz erreichbar: wer keinen Zugriff auf den Mac
hat, kann ihn nicht ansprechen, und wer das Token nicht kennt, erhält 401.

## API des Helfers

| Endpunkt | Zweck |
|---|---|
| `GET /api/health` | Erreichbarkeit und Tokenprüfung (ohne Token aufrufbar) |
| `GET /api/printers` | Warteschlangen, Status, Standarddrucker |
| `GET /api/printer/options?queue=` | Treiberoptionen aus `lpoptions -l` |
| `GET /api/printer/jobs?queue=` | Offene Aufträge |
| `POST /api/print?queue=&copies=&options=` | Datei im Body an `lp` übergeben |
| `GET /api/discover` | AirPrint-Geräte über mDNS (`_ipp._tcp`) |
| `GET /api/scanner/capabilities?host=` | eSCL-Fähigkeiten je Vorlagenquelle |
| `GET /api/scanner/status?host=` | Gerätestatus und Einzugszustand |
| `POST /api/scan` | Scan starten, liefert Auftrags-ID |
| `GET /api/scan/:id` | Fortschritt und Seitenliste |
| `GET /api/scan/:id/page/:n` | Einzelne Seite (JPEG/PDF) |
| `GET /api/diagnose?host=` | WLAN, CUPS, mDNS, Ping, eSCL |

## Fehlerbilder

| Meldung im Tool | Ursache | Lösung |
|---|---|---|
| Helfer offline | Prozess läuft nicht | `node bridge/roots-print-bridge.js` starten |
| Browser blockiert 127.0.0.1 | Safari mit HTTPS-Seite | Tool über `http://127.0.0.1:7331` öffnen |
| Token fehlt | Token leer oder veraltet | `cat ~/.roots-print/token`, unter „Verbindung" einsetzen |
| Kein Scanner gefunden | Drucker schläft, anderes WLAN, AP-Isolation | Gerät wecken, „Netz durchsuchen", Diagnose lesen |
| Scanner antwortet nicht | Falscher Host, Netzwechsel | Diagnose: Ping und eSCL prüfen |
| Vorlageneinzug ist leer | Kein Papier im Einzug | Papier einlegen oder auf Flachbett wechseln |
| Scanner ist beschäftigt | Auftrag läuft am Gerät | Warten, Display am Gerät prüfen |
| Warteschlange nimmt keine Aufträge an | Drucker pausiert | `cupsenable <Warteschlange>` |
| Drucker ist macOS unbekannt | Warteschlange gelöscht | Systemeinstellungen › Drucker & Scanner |
| Datei größer als 64 MB | Upload-Grenze | Kleiner exportieren |

## Getestet gegen

Canon MF732C/734C/735C (eSCL 2.62, `Canonebc1a3.local`), macOS 14, Node 20:
Warteschlangen und Optionen gelesen, Auftrag über `lp` angenommen, Scan über
Flachbett und Einzug inklusive Vorschau und Download.
