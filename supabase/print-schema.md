# Schema `print`

Angelegt am 24.08.2026 im gemeinsamen Supabase-Projekt `csmguwcvzreefluhahyu`
über drei Migrationen: `print_relay_schema`, `print_relay_user_functions`,
`print_relay_agent_functions`, `print_relay_public_api`. Der exakte Wortlaut liegt
in `supabase_migrations.schema_migrations` — dort nachlesen, nicht hier
rekonstruieren.

## Tabellen

| Tabelle | Inhalt |
|---|---|
| `print.agents` | Freigeschaltete Agenten: Name, `token_hash` (SHA-256), Hostname, Version, `last_seen_at`, `approved_by` |
| `print.printers` | Was ein Agent gemeldet hat: Warteschlange, Status, `options` (aus `lpoptions`), `scan_host`, `can_scan`, `scan_caps` |
| `print.jobs` | Auftrag: `kind` (print/scan), Status queued→claimed→running→done/error, `settings`, `payload` (Upload, wird beim Abschluss geleert), `result`, `error` |
| `print.job_pages` | Ergebnisseiten eines Scans als `bytea` samt MIME und Größe |

`print.agents` ist für `anon` und `authenticated` gesperrt; sichtbar wird nur, was
`print.list_agents()` zurückgibt (ohne Token-Hash).

## Sichten in `public`

PostgREST liefert nur freigegebene Schemas aus. Statt die Projektkonfiguration zu
ändern, liegen Sicht und Aufrufe in `public`: `print_printers`, `print_jobs`,
`print_job_pages` (alle `security_invoker`, also mit RLS des Aufrufers).

## Funktionen

Nutzerseite (`authenticated`): `print_submit_print_job`, `print_submit_scan_job`,
`print_job_page`, `print_register_agent` (nur `app_role = 'admin'`),
`print_list_agents`.

Agentseite (Token statt Sitzung): `print_agent_hello`, `print_agent_next_job`
(`for update skip locked`), `print_agent_add_page`, `print_agent_finish_job`.
`print.agent_id_for` ist bewusst nicht ausführbar für `anon`/`authenticated`.

## Regeln

- Einstellen nur mit Profil im Intranet (`print.is_roots_user()`).
- Lesen nur eigene Aufträge und deren Seiten (RLS auf `requested_by = auth.uid()`).
- 25 MB pro Upload und pro Scanseite (`print.max_bytes()`).
- `print.cleanup(3)` löscht Aufträge samt Seiten nach drei Tagen, geplant als
  `pg_cron`-Job `print-cleanup` um 03:17 UTC.

## Rechte

`EXECUTE` wird von Postgres standardmäßig an `PUBLIC` vergeben. Die
Nutzerfunktionen sind deshalb ausdrücklich für `public` und `anon` entzogen —
geprüft: ein Aufruf mit dem Anon-Key antwortet mit `42501 permission denied`. Die
vier Agentfunktionen bleiben für `anon` offen, weil der Agent keine Sitzung hat;
ohne gültiges Token liefern sie nur eine Fehlermeldung.

## Warum bytea und nicht Storage

Der Agent authentifiziert sich mit einem eigenen Token, nicht mit einem
Nutzerkonto. Ohne Sitzung kann er keine signierten Storage-URLs erzeugen, und ein
Service-Key auf dem Büro-Rechner wäre ein größeres Risiko als Seiten in der
Datenbank, die nach drei Tagen verschwinden. Bei viel Scan-Volumen ist der Wechsel
auf Storage mit eigenem Agent-Konto der nächste Schritt.
