#!/usr/bin/env node
/**
 * ROOTS Print Agent
 *
 * Läuft auf einem Rechner im Büro-Netz und arbeitet die Warteschlange in
 * Supabase ab: Drucker melden, Aufträge holen, drucken (CUPS) und scannen
 * (AirScan/eSCL), Ergebnisseiten zurückschreiben.
 *
 * Damit braucht niemand mehr eigene Software — der Browser spricht nur mit
 * Supabase, und dieser Prozess ist der einzige, der den Drucker erreicht.
 *
 * Anmeldung: Der Agent erzeugt beim ersten Start ein Token in
 * ~/.roots-print/agent-token und zeigt dessen SHA-256-Hash an. Ein Admin trägt
 * den Hash im Tool unter „Agent" ein. Das Token selbst verlässt den Rechner nie.
 *
 * Keine Abhängigkeiten. Node >= 18.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const dev = require("./device-lib.js");

const VERSION = "1.0.0";
const STATE_DIR = path.join(os.homedir(), ".roots-print");
const TOKEN_FILE = path.join(STATE_DIR, "agent-token");
const CONFIG_FILE = path.join(STATE_DIR, "agent.json");

const SUPABASE_URL = process.env.ROOTS_SUPABASE_URL || "https://csmguwcvzreefluhahyu.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.ROOTS_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNzbWd1d2N2enJlZWZsdWhhaHl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NjM0ODcsImV4cCI6MjA5MjUzOTQ4N30.Fiafx7XBaQZXUX3bKQIBH7znBHx3B51yL-bftOHsL4Q";
const POLL_MS = Number(process.env.ROOTS_PRINT_POLL_MS || 2000);
const HELLO_MS = Number(process.env.ROOTS_PRINT_HELLO_MS || 60000);
const MAX_PAGE_BYTES = 25 * 1024 * 1024;

/* ---------------------------------------------------------------- token --- */

function loadToken() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(TOKEN_FILE)) {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  }
  const t = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  return t;
}

const TOKEN = loadToken();
const TOKEN_HASH = crypto.createHash("sha256").update(TOKEN).digest("hex");

function agentName() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      if (cfg.name) return String(cfg.name);
    }
  } catch (e) {
    /* Standardname genügt */
  }
  return os.hostname();
}

/* ------------------------------------------------------------------ rpc --- */

async function rpc(fn, args, { timeout = 120000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        detail = JSON.parse(text).message || text;
      } catch (e) {
        /* Rohtext genügt */
      }
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------- inventory --- */

async function inventory() {
  const { printers } = await dev.listPrinters();
  const devices = await dev.resolveIppHosts().catch(() => []);
  const out = [];
  for (const p of printers) {
    const match = devices.find((d) => d.instance === p.dnssdInstance) || (devices.length === 1 ? devices[0] : null);
    let options = [];
    try {
      options = (await dev.printerOptions(p.name)).options;
    } catch (e) {
      /* Ohne Optionen bleibt der Drucker nutzbar */
    }
    let scanCaps = null;
    if (match?.canScan && match.host) {
      scanCaps = await dev.scannerCapabilities(match.host).catch(() => null);
    }
    out.push({
      queue: p.name,
      display_name: match?.model || p.name,
      state: p.state,
      state_text: p.stateText,
      is_default: p.isDefault,
      options,
      scan_host: match?.host || null,
      can_scan: !!(match?.canScan && match.host),
      scan_caps: scanCaps,
    });
  }
  return out;
}

/* -------------------------------------------------------------- job work --- */

async function runPrintJob(job) {
  if (!job.queue) throw Object.assign(new Error("Dem Auftrag fehlt eine Warteschlange."), { hint: "Drucker im Tool neu wählen." });
  const data = Buffer.from(job.payload || "", "base64");
  if (!data.length) throw new Error("Der Auftrag enthält keine Datei.");
  const name = String(job.filename || "druck.bin").replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
  const tmp = path.join(os.tmpdir(), `roots-print-${Date.now()}-${name}`);
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try {
    const settings = job.settings || {};
    const res = await dev.printFile(tmp, { queue: job.queue, copies: settings.copies, options: settings.options || {} });
    return { jobId: res.jobId, bytes: data.length, queue: job.queue };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (e) {
      /* Aufräumen ist Nebensache */
    }
  }
}

async function runScanJob(job) {
  const settings = job.settings || {};
  const host = settings.host;
  if (!host) throw Object.assign(new Error("Dem Scan-Auftrag fehlt der Scanner."), { hint: "Im Tool ein Gerät mit Scan-Funktion wählen." });
  const started = await dev.startScanJob(settings);
  let count = 0;
  for await (const page of dev.streamPages(started)) {
    if (page.buffer.length > MAX_PAGE_BYTES) {
      throw Object.assign(new Error(`Seite ${count + 1} ist größer als 25 MB.`), { hint: "Auflösung senken oder in Graustufen scannen." });
    }
    await rpc("print_agent_add_page", {
      p_token: TOKEN,
      p_job: job.id,
      p_idx: count,
      p_mime: page.mime,
      p_data: page.buffer.toString("base64"),
    });
    count++;
    log(`Seite ${count} übertragen (${Math.round(page.buffer.length / 1024)} KB)`);
  }
  if (!count) throw Object.assign(new Error("Der Scanner hat keine Seite geliefert."), { hint: "Vorlage einlegen und erneut starten." });
  return { pages: count, host };
}

/* ----------------------------------------------------------------- loop --- */

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

let stopping = false;
let lastHello = 0;
let enrolled = false;

async function hello() {
  const printers = await inventory().catch((e) => {
    log(`Drucker konnten nicht gelesen werden: ${e.message}`);
    return [];
  });
  await rpc("print_agent_hello", {
    p_token: TOKEN,
    p_hostname: os.hostname(),
    p_version: VERSION,
    p_printers: printers,
  });
  lastHello = Date.now();
  if (!enrolled) {
    enrolled = true;
    log(`Freigeschaltet. ${printers.length} Warteschlange(n) gemeldet: ${printers.map((p) => p.queue).join(", ") || "keine"}`);
  }
  return printers;
}

async function tick() {
  if (Date.now() - lastHello > HELLO_MS) await hello();
  const job = await rpc("print_agent_next_job", { p_token: TOKEN });
  if (!job) return;
  log(`Auftrag ${job.kind} ${job.id} von ${job.requested_email || "?"}`);
  try {
    const result = job.kind === "print" ? await runPrintJob(job) : await runScanJob(job);
    await rpc("print_agent_finish_job", { p_token: TOKEN, p_job: job.id, p_status: "done", p_result: result });
    log(`Auftrag ${job.id} fertig`);
  } catch (e) {
    const error = { code: e.code || "agent_failed", message: e.message || "Unbekannter Fehler", hint: e.hint || null };
    await rpc("print_agent_finish_job", { p_token: TOKEN, p_job: job.id, p_status: "error", p_error: error }).catch(() => {});
    log(`Auftrag ${job.id} fehlgeschlagen: ${error.message}`);
  }
}

async function main() {
  log(`ROOTS Print Agent ${VERSION} – ${agentName()} (${os.hostname()})`);
  try {
    await hello();
  } catch (e) {
    if (/nicht freigeschaltet/i.test(e.message)) {
      process.stdout.write(
        [
          "",
          "Dieser Agent ist noch nicht freigeschaltet.",
          "Ein Admin trägt diesen Hash im Tool unter „Agent“ ein:",
          "",
          `  ${TOKEN_HASH}`,
          "",
          "Der Agent wartet und versucht es weiter.",
          "",
        ].join("\n")
      );
    } else {
      log(`Anmeldung fehlgeschlagen: ${e.message}`);
    }
  }

  while (!stopping) {
    try {
      await tick();
    } catch (e) {
      if (/nicht freigeschaltet/i.test(e.message)) {
        // Warten, bis ein Admin den Hash eingetragen hat.
        await sleep(10000);
        continue;
      }
      log(`Fehler in der Warteschlange: ${e.message}`);
      await sleep(5000);
    }
    await sleep(POLL_MS);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on("SIGINT", () => {
  stopping = true;
  log("Beendet.");
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopping = true;
  process.exit(0);
});

if (process.argv.includes("--hash")) {
  process.stdout.write(TOKEN_HASH + "\n");
} else {
  main().catch((e) => {
    log(`Abbruch: ${e.message}`);
    process.exit(1);
  });
}
