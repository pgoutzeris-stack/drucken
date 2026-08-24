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
const ipp = require("./ipp.js");

const VERSION = "1.0.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Die mDNS-Suche antwortet nicht immer im ersten Versuch. Was einmal gefunden
// wurde, bleibt gemerkt — und Scan-Fähigkeiten werden nur einmal geholt, weil
// der eSCL-Aufruf das Gerät aufweckt.
const knownHosts = new Map();
const capsCache = new Map();
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

function config() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    log(`agent.json ist kein gültiges JSON — Datei wird ignoriert: ${e.message}`);
  }
  return {};
}

function agentName() {
  return String(config().name || os.hostname());
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

/** Netzname, in dem der Agent steht — macOS und Linux getrennt abgefragt. */
async function currentSsid() {
  if (process.platform === "darwin") {
    const res = await dev.run("networksetup", ["-getairportnetwork", "en0"], { timeout: 8000 });
    const m = res.stdout.match(/:\s*(.+)$/m);
    if (m) return m[1].trim();
    return null;
  }
  const res = await dev.run("iwgetid", ["-r"], { timeout: 8000 });
  return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

/**
 * Anwesenheit rein passiv feststellen. Ein Aufruf an IPP oder eSCL weckt das
 * Gerät aus dem Ruhezustand — es fährt hoch und macht Geräusche. Deshalb zählt
 * nur, was ohne Zutun ohnehin im Netz steht: die Bonjour-Ankündigung (die bei
 * schlafenden AirPrint-Geräten der Sleep-Proxy beantwortet) und ein bereits
 * vorhandener ARP-Eintrag.
 */
async function isPresent(host, seenViaMdns) {
  if (seenViaMdns) return true;
  if (!host) return null;
  const arp = await dev.run("arp", ["-n", host], { timeout: 5000 });
  if (arp.code === 0 && /(([0-9a-f]{1,2}:){5}[0-9a-f]{1,2})/i.test(arp.stdout)) return true;
  return null; // keine Aussage — nicht als "offline" behaupten
}

/**
 * Läuft der Agent nicht im gleichen Netz wie der Drucker — etwa auf einer
 * Cloud-Maschine, die per WireGuard in das Büronetz eingewählt ist —, dann
 * findet mDNS nichts. Dann zählt allein, was in agent.json steht: feste
 * Adressen statt Suche.
 */
const DIRECT_OPTIONS = [
  { key: "ColorModel", label: "Color Mode", values: ["RGB", "Gray"], current: "RGB" },
  { key: "Duplex", label: "2-Sided Printing", values: ["None", "DuplexNoTumble", "DuplexTumble"], current: "DuplexNoTumble" },
  { key: "PageSize", label: "Media Size", values: ["A4", "A5", "B5", "Letter", "Legal"], current: "A4" },
  { key: "InputSlot", label: "Media Source", values: ["auto", "by-pass-tray", "tray-1"], current: "auto" },
];

async function staticInventory(entries) {
  const { printers } = await dev.listPrinters().catch(() => ({ printers: [] }));
  const known = new Set(printers.map((p) => p.name));
  const out = [];
  for (const entry of entries) {
    const queue = String(entry.queue || "").trim();
    const host = String(entry.host || "").trim();
    if (!queue || !host) {
      log("Eintrag in agent.json ohne queue oder host — übersprungen.");
      continue;
    }
    // Ohne CUPS-Warteschlange druckt der Agent direkt per IPP. Das ist auf einer
    // Cloud-Maschine der Normalfall: dort ist kein Treiber installiert, und
    // `lpadmin -m everywhere` scheitert an der Attributantwort dieses Geräts.
    const direct = entry.direct === true || !known.has(queue);
    let options = DIRECT_OPTIONS;
    if (!direct) {
      try {
        options = (await dev.printerOptions(queue)).options;
      } catch (e) {
        options = DIRECT_OPTIONS;
      }
    }
    // Nur einmal pro Lauf abfragen: der eSCL-Aufruf weckt das Gerät.
    let scanCaps = capsCache.get(queue) || null;
    if (!scanCaps && entry.canScan !== false) {
      scanCaps = await dev.scannerCapabilities(host).catch(() => null);
      if (scanCaps) capsCache.set(queue, scanCaps);
    }
    const live = printers.find((p) => p.name === queue);
    out.push({
      queue,
      display_name: entry.display_name || scanCaps?.makeAndModel || queue,
      state: live?.state || "idle",
      state_text: live?.stateText || `direkt über ${host}`,
      is_default: !!entry.is_default,
      options,
      scan_host: scanCaps ? host : null,
      can_scan: !!scanCaps,
      scan_caps: scanCaps,
      print_host: direct ? host : null,
      reachable: await isPresent(host, false),
    });
  }
  return out;
}

async function inventory() {
  const cfg = config();
  if (Array.isArray(cfg.printers) && cfg.printers.length) return staticInventory(cfg.printers);
  const { printers } = await dev.listPrinters();
  let devices = await dev.resolveIppHosts().catch(() => []);
  if (!devices.length) {
    await sleep(1500);
    devices = await dev.resolveIppHosts().catch(() => []);
  }
  const out = [];
  for (const p of printers) {
    let match = devices.find((d) => d.instance === p.dnssdInstance) || (devices.length === 1 ? devices[0] : null);
    if (match) knownHosts.set(p.name, match);
    else match = knownHosts.get(p.name) || null;
    let options = [];
    try {
      options = (await dev.printerOptions(p.name)).options;
    } catch (e) {
      /* Ohne Optionen bleibt der Drucker nutzbar */
    }
    let scanCaps = capsCache.get(p.name) || null;
    if (!scanCaps && match?.canScan && match.host) {
      // Einmal pro Agentenlauf: der eSCL-Aufruf weckt den Scanner.
      scanCaps = await dev.scannerCapabilities(match.host).catch(() => null);
      if (scanCaps) capsCache.set(p.name, scanCaps);
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
      reachable: await isPresent(match?.host || null, !!match),
    });
  }
  return out;
}

/* -------------------------------------------------------------- job work --- */

const DIRECT_MIME = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg" };

function directTarget(queue) {
  const entry = (config().printers || []).find((p) => p.queue === queue);
  if (!entry) return null;
  return entry.direct === true || entry.host ? String(entry.host) : null;
}

async function runPrintJob(job) {
  if (!job.queue) throw Object.assign(new Error("Dem Auftrag fehlt eine Warteschlange."), { hint: "Drucker im Tool neu wählen." });
  const data = Buffer.from(job.payload || "", "base64");
  if (!data.length) throw new Error("Der Auftrag enthält keine Datei.");

  const host = directTarget(job.queue);
  const cupsKnown = (await dev.run("lpstat", ["-p", job.queue])).code === 0;
  if (host && !cupsKnown) {
    const settings = job.settings || {};
    const suffix = String(job.filename || "").split(".").pop().toLowerCase();
    const mime = DIRECT_MIME[suffix];
    if (!mime) {
      throw Object.assign(new Error(`Dieses Gerät nimmt ${suffix ? "." + suffix : "dieses Format"} nicht direkt an.`), {
        hint: "Ohne Treiber gehen PDF und JPEG. Datei als PDF exportieren.",
      });
    }
    const res = await ipp.printJob(host, {
      data,
      mime,
      jobName: job.filename || "ROOTS Print",
      copies: settings.copies,
      options: settings.options || {},
      user: (job.requested_email || "roots-print").split("@")[0],
    });
    return { jobId: res.jobId, bytes: data.length, via: `ipp://${host}` };
  }
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
  const ssid = await currentSsid().catch(() => null);
  await rpc("print_agent_hello", {
    p_token: TOKEN,
    p_hostname: os.hostname(),
    p_version: VERSION,
    p_printers: printers,
    p_meta: { ssid },
  });
  lastHello = Date.now();
  if (!enrolled) {
    enrolled = true;
    log(`Freigeschaltet. Netz ${ssid || "unbekannt"}. ${printers.length} Warteschlange(n): ${printers.map((p) => `${p.queue}${p.reachable === false ? " (nicht erreichbar)" : ""}`).join(", ") || "keine"}`);
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
