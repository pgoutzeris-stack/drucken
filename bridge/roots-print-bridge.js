#!/usr/bin/env node
/**
 * ROOTS Print Bridge
 *
 * A browser page cannot talk to an AirPrint/eSCL printer directly: the printer
 * speaks plain HTTP on a .local mDNS name, the tool is served over HTTPS, and
 * CUPS (lp/lpstat) is not reachable from JavaScript at all. This local helper
 * closes that gap. It listens on 127.0.0.1 only, requires a bearer token, and
 * exposes a small JSON API for discovery, printing (CUPS) and scanning (eSCL).
 *
 * No dependencies. Node >= 18.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const PORT = Number(process.env.ROOTS_PRINT_PORT || 7331);
const HOST = "127.0.0.1";
const STATE_DIR = path.join(os.homedir(), ".roots-print");
const TOKEN_FILE = path.join(STATE_DIR, "token");
const WEB_ROOT = path.resolve(__dirname, "..");
const MAX_UPLOAD = 64 * 1024 * 1024;

const ALLOWED_ORIGINS = [
  "https://pgoutzeris-stack.github.io",
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  "tauri://localhost",
  "https://tauri.localhost",
];

/* ---------------------------------------------------------------- token --- */

function loadToken() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(TOKEN_FILE)) {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  }
  const t = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  return t;
}
const TOKEN = loadToken();

function tokenOk(req) {
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const header = String(req.headers["x-roots-token"] || "").trim();
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const query = String(url.searchParams.get("token") || "").trim();
  const given = bearer || header || query;
  if (!given || given.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
}

/* ----------------------------------------------------------------- util --- */

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 15000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || "", stderr: stderr || "", timedOut: !!(err && err.killed) });
    });
  });
}

/** dns-sd never exits on its own — run it for `ms` and keep what it printed. */
function runTimeboxed(cmd, args, ms) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, args);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => child.kill("SIGTERM"), ms);
    child.on("close", () => {
      clearTimeout(t);
      resolve(out);
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve(out);
    });
  });
}

function httpGet(url, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error("ETIMEDOUT")));
    req.on("error", reject);
  });
}

function httpPostXml(url, xml, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST", timeout, headers: { "Content-Type": "text/xml", "Content-Length": Buffer.byteLength(xml) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("ETIMEDOUT")));
    req.on("error", reject);
    req.end(xml);
  });
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:[a-z]+:)?${name}>([^<]*)</(?:[a-z]+:)?${name}>`, "i"));
  return m ? m[1] : null;
};
const tagAll = (xml, name) => [...xml.matchAll(new RegExp(`<(?:[a-z]+:)?${name}>([^<]*)</(?:[a-z]+:)?${name}>`, "gi"))].map((m) => m[1]);

/** Printer/scanner hosts are user-selected, but they still end up in a URL. */
function safeHost(host) {
  const h = String(host || "").trim();
  if (!/^[A-Za-z0-9._-]{1,253}(:\d{1,5})?$/.test(h)) throw new HttpError(400, "bad_host", `Ungültiger Host: ${h}`);
  return h;
}

class HttpError extends Error {
  constructor(status, code, message, hint) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

/* -------------------------------------------------------------- printers --- */

async function listPrinters() {
  const [pRes, vRes, dRes] = await Promise.all([run("lpstat", ["-p"]), run("lpstat", ["-v"]), run("lpstat", ["-d"])]);
  if (pRes.code !== 0 && !pRes.stdout.trim()) {
    throw new HttpError(503, "cups_unavailable", "CUPS antwortet nicht.", "Prüfe, ob das Drucksystem läuft: `lpstat -r`.");
  }
  const devices = {};
  for (const line of vRes.stdout.split("\n")) {
    const m = line.match(/(?:for|für)\s+([A-Za-z0-9._-]+):\s*(\S+)\s*$/);
    if (m) devices[m[1]] = m[2];
  }
  const defaultMatch = dRes.stdout.match(/:\s*(\S+)\s*$/);
  const defaultQueue = defaultMatch ? defaultMatch[1] : null;

  const printers = [];
  for (const line of pRes.stdout.split("\n")) {
    const m = line.match(/^\S+\s+[„"]?([A-Za-z0-9._-]+)[“"]?\s+(.*)$/);
    if (!m) continue;
    const name = m[1];
    const rest = m[2];
    const device = devices[name] || null;
    printers.push({
      name,
      state: /idle|inaktiv|bereit/i.test(rest) ? "idle" : /printing|druckt/i.test(rest) ? "printing" : /disabled|deaktiviert/i.test(rest) ? "disabled" : "unknown",
      stateText: rest.trim(),
      device,
      dnssdInstance: device && device.startsWith("dnssd://") ? decodeURIComponent(device.slice(8).split("._")[0]).replace(/%2F/gi, "/") : null,
      isDefault: name === defaultQueue,
    });
  }
  return { printers, defaultQueue };
}

async function resolveIppHosts() {
  const browse = await runTimeboxed("dns-sd", ["-t", "3", "-B", "_ipp._tcp", "local"], 3500);
  const instances = [...browse.matchAll(/_ipp\._tcp\.\s+(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
  const unique = [...new Set(instances)];
  const out = [];
  for (const inst of unique) {
    const lookup = await runTimeboxed("dns-sd", ["-t", "4", "-L", inst, "_ipp._tcp", "local"], 4000);
    const hm = lookup.match(/can be reached at\s+([A-Za-z0-9._-]+?)\.?:(\d+)/);
    const txt = lookup;
    out.push({
      instance: inst,
      host: hm ? hm[1] : null,
      port: hm ? Number(hm[2]) : null,
      model: (txt.match(/\bty=((?:[^\s\\]|\\.)+)/) || [])[1]?.replace(/\\032/g, " ").replace(/\\(.)/g, "$1") || null,
      canScan: /\bScan=T\b/.test(txt),
      canDuplex: /\bDuplex=T\b/.test(txt),
      canColor: /\bColor=T\b/.test(txt),
      adminUrl: (txt.match(/adminurl=(\S+)/) || [])[1] || null,
      uuid: (txt.match(/UUID=([0-9a-f-]+)/i) || [])[1] || null,
    });
  }
  return out;
}

async function printerOptions(queue) {
  const q = String(queue || "");
  if (!/^[A-Za-z0-9._-]+$/.test(q)) throw new HttpError(400, "bad_queue", `Ungültige Warteschlange: ${q}`);
  const res = await run("lpoptions", ["-p", q, "-l"]);
  if (res.code !== 0 && !res.stdout.trim()) {
    throw new HttpError(404, "queue_unknown", `Warteschlange „${q}“ kennt macOS nicht.`, "Drucker in den Systemeinstellungen erneut hinzufügen.");
  }
  const known = await run("lpstat", ["-p", q]);
  if (known.code !== 0) {
    throw new HttpError(404, "queue_unknown", `Warteschlange „${q}“ kennt macOS nicht.`, "Drucker in den Systemeinstellungen erneut hinzufügen, danach Liste neu laden.");
  }
  const options = [];
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^([^\/:]+)\/([^:]+):\s*(.*)$/);
    if (!m) continue;
    const values = m[3].trim().split(/\s+/).filter(Boolean);
    options.push({
      key: m[1],
      label: m[2],
      values: values.map((v) => v.replace(/^\*/, "")),
      current: values.find((v) => v.startsWith("*"))?.slice(1) || null,
    });
  }
  return { queue: q, options };
}

async function jobsFor(queue) {
  const res = await run("lpstat", ["-o", queue || "", "-W", "not-completed"]);
  const jobs = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\S+)\s+(\S+)\s+(\d+)/);
      return { id: m ? m[1] : l, user: m ? m[2] : null, size: m ? Number(m[3]) : null, raw: l };
    });
  return { jobs };
}

/* --------------------------------------------------------------- scanner --- */

const scanJobs = new Map(); // id -> { pages: [{buffer, mime}], state, error, started, settings }
let scanCounter = 0;

async function scannerCapabilities(host) {
  const h = safeHost(host);
  let res;
  try {
    res = await httpGet(`http://${h}/eSCL/ScannerCapabilities`, { timeout: 12000 });
  } catch (e) {
    throw new HttpError(504, "scanner_unreachable", `Scanner ${h} antwortet nicht.`, "Gleiches WLAN? Gerät aus dem Ruhezustand wecken und erneut suchen.");
  }
  if (res.status !== 200) throw new HttpError(502, "escl_unsupported", `Scanner ${h} liefert HTTP ${res.status} auf /eSCL/ScannerCapabilities.`, "Gerät unterstützt AirScan/eSCL nicht oder Scannen ist am Gerät deaktiviert.");
  const xml = res.body.toString("utf8");

  const section = (name) => {
    const m = xml.match(new RegExp(`<scan:${name}>([\\s\\S]*?)</scan:${name}>`, "i"));
    return m ? m[1] : null;
  };
  const platen = section("PlatenInputCaps");
  const adf = section("AdfSimplexInputCaps");
  const adfDuplex = section("AdfDuplexInputCaps");

  const capsFor = (block) =>
    block
      ? {
          colorModes: tagAll(block, "ColorMode"),
          resolutions: [...new Set(tagAll(block, "XResolution").map(Number))].sort((a, b) => a - b),
          formats: [...new Set(tagAll(block, "DocumentFormat").concat(tagAll(block, "DocumentFormatExt")))],
          intents: [...new Set(tagAll(block, "Intent"))],
          maxWidth: Number(tag(block, "MaxWidth")) || null,
          maxHeight: Number(tag(block, "MaxHeight")) || null,
          feederCapacity: Number(tag(block, "FeederCapacity")) || null,
        }
      : null;

  return {
    host: h,
    makeAndModel: tag(xml, "MakeAndModel"),
    serial: tag(xml, "SerialNumber"),
    version: tag(xml, "Version"),
    adminUrl: tag(xml, "AdminURI"),
    sources: {
      platen: capsFor(platen),
      feeder: capsFor(adf),
      feederDuplex: capsFor(adfDuplex),
    },
    supportsDuplex: !!adfDuplex,
  };
}

async function scannerStatus(host) {
  const h = safeHost(host);
  let res;
  try {
    res = await httpGet(`http://${h}/eSCL/ScannerStatus`, { timeout: 8000 });
  } catch (e) {
    throw new HttpError(504, "scanner_unreachable", `Scanner ${h} antwortet nicht.`, "Gleiches WLAN? Gerät aus dem Ruhezustand wecken und erneut suchen.");
  }
  const xml = res.body.toString("utf8");
  const adf = tag(xml, "AdfState");
  return {
    host: h,
    state: tag(xml, "State"),
    adfState: adf,
    adfLoaded: adf === "ScannerAdfLoaded",
    jobs: [...xml.matchAll(/<pwg:JobState>([^<]+)<\/pwg:JobState>/g)].map((m) => m[1]),
  };
}

function scanSettingsXml(s) {
  const source = s.source === "feeder" ? "Feeder" : "Platen";
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<scan:ScanSettings xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm" xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03">',
    "  <pwg:Version>2.62</pwg:Version>",
    `  <scan:Intent>${s.intent || "Document"}</scan:Intent>`,
    `  <pwg:InputSource>${source}</pwg:InputSource>`,
    `  <scan:ColorMode>${s.colorMode || "RGB24"}</scan:ColorMode>`,
    `  <scan:XResolution>${Number(s.resolution) || 300}</scan:XResolution>`,
    `  <scan:YResolution>${Number(s.resolution) || 300}</scan:YResolution>`,
    `  <pwg:DocumentFormat>${s.format || "application/pdf"}</pwg:DocumentFormat>`,
  ];
  if (s.source === "feeder" && s.duplex) lines.push("  <scan:Duplex>true</scan:Duplex>");
  if (s.brightness != null) lines.push(`  <scan:Brightness>${Number(s.brightness)}</scan:Brightness>`);
  if (s.contrast != null) lines.push(`  <scan:Contrast>${Number(s.contrast)}</scan:Contrast>`);
  if (s.width && s.height) {
    lines.push(
      "  <pwg:ScanRegions>",
      '    <pwg:ScanRegion>',
      "      <pwg:XOffset>0</pwg:XOffset>",
      "      <pwg:YOffset>0</pwg:YOffset>",
      `      <pwg:Width>${Number(s.width)}</pwg:Width>`,
      `      <pwg:Height>${Number(s.height)}</pwg:Height>`,
      "      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>",
      "    </pwg:ScanRegion>",
      "  </pwg:ScanRegions>"
    );
  }
  lines.push("</scan:ScanSettings>");
  return lines.join("\n");
}

async function startScan(settings) {
  const h = safeHost(settings.host);
  const status = await scannerStatus(h).catch(() => null);
  if (settings.source === "feeder" && status && status.adfState === "ScannerAdfEmpty") {
    throw new HttpError(409, "adf_empty", "Der Vorlageneinzug ist leer.", "Papier in den Einzug legen oder auf Flachbett umstellen.");
  }
  if (status && status.state && status.state !== "Idle") {
    throw new HttpError(409, "scanner_busy", `Scanner ist nicht bereit (Status: ${status.state}).`, "Laufenden Auftrag am Gerät beenden, Abdeckung schließen, dann erneut starten.");
  }

  const xml = scanSettingsXml(settings);
  let res;
  try {
    res = await httpPostXml(`http://${h}/eSCL/ScanJobs`, xml);
  } catch (e) {
    throw new HttpError(504, "scanner_unreachable", `Scan-Auftrag an ${h} nicht absendbar.`, "Gerät im gleichen WLAN und wach? Danach erneut versuchen.");
  }
  if (res.status === 409) throw new HttpError(409, "scanner_busy", "Der Scanner ist mit einem anderen Auftrag beschäftigt.", "Warten, bis der Auftrag am Gerät fertig ist.");
  if (res.status === 503) throw new HttpError(503, "scanner_busy", "Scanner meldet „nicht verfügbar“.", "Am Gerät prüfen: Papierstau, offene Abdeckung, Fehlermeldung im Display.");
  if (res.status !== 201 || !res.headers.location) {
    throw new HttpError(502, "scan_rejected", `Scanner lehnte die Einstellungen ab (HTTP ${res.status}).`, "Auflösung, Farbmodus oder Format auf die Gerätewerte zurückstellen.");
  }

  const jobUrl = res.headers.location.replace(/\/$/, "");
  const id = `scan-${++scanCounter}-${Date.now().toString(36)}`;
  const job = { id, jobUrl, host: h, settings, pages: [], state: "running", error: null, started: Date.now() };
  scanJobs.set(id, job);
  collectPages(job);
  return { id, jobUrl, host: h };
}

async function collectPages(job) {
  try {
    for (let n = 0; n < 200; n++) {
      const res = await httpGet(`${job.jobUrl}/NextDocument`, { timeout: 180000 });
      if (res.status === 404 || res.status === 410) break;
      if (res.status === 503) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (res.status !== 200 || !res.body.length) {
        job.state = "error";
        job.error = { code: "page_failed", message: `Seite ${n + 1} kam nicht an (HTTP ${res.status}).`, hint: "Scan neu starten. Bei Wiederholung Gerät kurz vom Strom trennen." };
        return;
      }
      job.pages.push({ mime: String(res.headers["content-type"] || job.settings.format || "application/pdf").split(";")[0], buffer: res.body });
    }
    if (!job.pages.length) {
      job.state = "error";
      job.error = { code: "no_pages", message: "Der Scanner hat keine Seite geliefert.", hint: "Vorlage einlegen und erneut starten. Bei Einzug: Papier gerade und Anschlag korrekt." };
      return;
    }
    job.state = "done";
  } catch (e) {
    job.state = "error";
    job.error = { code: "transfer_failed", message: `Übertragung abgebrochen: ${e.message}`, hint: "WLAN-Verbindung prüfen und Scan erneut starten." };
  }
}

/* ----------------------------------------------------------------- print --- */

async function printFile(filePath, { queue, copies, options }) {
  const q = String(queue || "");
  if (!/^[A-Za-z0-9._-]+$/.test(q)) throw new HttpError(400, "bad_queue", `Ungültige Warteschlange: ${q}`);
  const args = ["-d", q];
  if (copies && Number(copies) > 1) args.push("-n", String(Math.min(99, Number(copies))));
  for (const [k, v] of Object.entries(options || {})) {
    if (!/^[A-Za-z0-9._-]+$/.test(k) || v == null || v === "") continue;
    if (!/^[A-Za-z0-9._,\- ]+$/.test(String(v))) continue;
    args.push("-o", `${k}=${v}`);
  }
  args.push(filePath);
  const res = await run("lp", args, { timeout: 60000 });
  if (res.code !== 0) {
    const err = (res.stderr || res.stdout).trim();
    if (/is not accepting|nimmt keine/i.test(err)) throw new HttpError(409, "queue_paused", "Die Warteschlange nimmt keine Aufträge an.", "Druckerpause aufheben: `cupsenable <Warteschlange>` oder in den Systemeinstellungen fortsetzen.");
    if (/unknown destination|unbekanntes Ziel/i.test(err)) throw new HttpError(404, "queue_unknown", `Drucker „${q}“ ist macOS unbekannt.`, "Drucker in den Systemeinstellungen neu hinzufügen.");
    throw new HttpError(502, "print_failed", err || "lp brach ohne Meldung ab.", "Datei-Format prüfen (PDF, JPEG, PNG, TXT sind sicher).");
  }
  const jobId = (res.stdout.match(/(?:request id is|Anfrage-ID ist)\s+(\S+)/) || [])[1]?.replace(/–/g, "-") || null;
  return { jobId, raw: res.stdout.trim() };
}

/* ------------------------------------------------------------- diagnose --- */

async function diagnose(host) {
  const checks = [];
  const wifi = await run("networksetup", ["-getairportnetwork", "en0"]);
  const ssid = (wifi.stdout.match(/:\s*(.+)$/m) || [])[1]?.trim() || null;
  checks.push({
    id: "wifi",
    ok: !!ssid,
    label: "WLAN dieses Macs",
    detail: ssid || "Kein WLAN aktiv (evtl. LAN-Kabel).",
    hint: ssid ? null : "Ohne gemeinsames Netz findet der Mac den Drucker nicht. WLAN einschalten oder LAN prüfen.",
  });

  const cups = await run("lpstat", ["-r"]);
  checks.push({ id: "cups", ok: /is running|läuft|ist aktiv/i.test(cups.stdout), label: "Drucksystem", detail: cups.stdout.trim() || cups.stderr.trim(), hint: /is running|läuft|ist aktiv/i.test(cups.stdout) ? null : "CUPS neu starten: `sudo launchctl kickstart -k system/org.cups.cupsd`." });

  const mdns = await resolveIppHosts();
  checks.push({
    id: "mdns",
    ok: mdns.length > 0,
    label: "AirPrint-Geräte im Netz",
    detail: mdns.length ? mdns.map((d) => `${d.model || d.instance} (${d.host || "?"})`).join(", ") : "Keine Antwort auf _ipp._tcp",
    hint: mdns.length ? null : "Drucker aus dem Ruhezustand wecken. Getrenntes Gastnetz oder aktivierte AP-Isolation im Router blockiert mDNS.",
  });

  if (host) {
    const h = safeHost(host);
    const ping = await run("ping", ["-c", "2", "-W", "1500", h], { timeout: 8000 });
    const okPing = ping.code === 0;
    checks.push({ id: "ping", ok: okPing, label: `Erreichbarkeit ${h}`, detail: (ping.stdout.match(/round-trip.*$/m) || [])[0] || ping.stdout.trim().split("\n").pop() || "keine Antwort", hint: okPing ? null : "Name wird nicht aufgelöst oder Gerät antwortet nicht. Gerät wecken, danach erneut suchen." });
    let esclOk = false;
    let esclDetail = "";
    try {
      const res = await httpGet(`http://${h}/eSCL/ScannerStatus`, { timeout: 6000 });
      esclOk = res.status === 200;
      esclDetail = `HTTP ${res.status}`;
    } catch (e) {
      esclDetail = e.message;
    }
    checks.push({ id: "escl", ok: esclOk, label: "Scan-Schnittstelle (eSCL)", detail: esclDetail, hint: esclOk ? null : "Gerät kann nicht scannen oder AirScan ist im Geräte-Webinterface deaktiviert." });
  }

  return { ssid, checks, ok: checks.every((c) => c.ok) };
}

/* ---------------------------------------------------------------- server --- */

function corsHeaders(req) {
  const origin = req.headers.origin;
  const h = {
    Vary: "Origin",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Roots-Token, X-Roots-Filename",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  // Chrome Private Network Access: an HTTPS page reaching 127.0.0.1 preflights.
  if (req.headers["access-control-request-private-network"]) h["Access-Control-Allow-Private-Network"] = "true";
  return h;
}

function sendJson(req, res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function sendError(req, res, e) {
  const status = e instanceof HttpError ? e.status : 500;
  sendJson(req, res, status, { error: { code: e.code || "internal", message: e.message || "Unbekannter Fehler", hint: e.hint || null } });
}

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "too_large", "Datei ist größer als 64 MB.", "Kleiner exportieren oder direkt aus der App drucken."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Nicht gefunden");
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, { "Content-Type": STATIC_TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store", "Content-Length": body.length });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  try {
    // Unauthenticated: lets the tool detect the bridge and name the version.
    if (p === "/api/health") {
      return sendJson(req, res, 200, { ok: true, service: "roots-print-bridge", version: "1.0.0", platform: process.platform, tokenRequired: true, tokenValid: tokenOk(req) });
    }

    if (p.startsWith("/api/")) {
      if (!tokenOk(req)) {
        return sendJson(req, res, 401, { error: { code: "bad_token", message: "Token fehlt oder passt nicht.", hint: `Token steht in ${TOKEN_FILE} — im Tool unter „Verbindung“ einsetzen.` } });
      }

      if (p === "/api/printers" && req.method === "GET") return sendJson(req, res, 200, await listPrinters());
      if (p === "/api/discover" && req.method === "GET") return sendJson(req, res, 200, { devices: await resolveIppHosts() });
      if (p === "/api/printer/options" && req.method === "GET") return sendJson(req, res, 200, await printerOptions(url.searchParams.get("queue")));
      if (p === "/api/printer/jobs" && req.method === "GET") return sendJson(req, res, 200, await jobsFor(url.searchParams.get("queue")));
      if (p === "/api/diagnose" && req.method === "GET") return sendJson(req, res, 200, await diagnose(url.searchParams.get("host")));
      if (p === "/api/scanner/capabilities" && req.method === "GET") return sendJson(req, res, 200, await scannerCapabilities(url.searchParams.get("host")));
      if (p === "/api/scanner/status" && req.method === "GET") return sendJson(req, res, 200, await scannerStatus(url.searchParams.get("host")));

      if (p === "/api/scan" && req.method === "POST") {
        const body = JSON.parse((await readBody(req, 1 << 20)).toString("utf8") || "{}");
        return sendJson(req, res, 202, await startScan(body));
      }

      if (p.startsWith("/api/scan/") && req.method === "GET") {
        const parts = p.split("/").filter(Boolean); // api scan <id> [page N]
        const job = scanJobs.get(parts[2]);
        if (!job) throw new HttpError(404, "job_unknown", "Dieser Scan-Auftrag ist dem Helfer nicht bekannt.", "Scan neu starten (der Helfer wurde vermutlich zwischenzeitlich beendet).");
        if (parts[3] === "page") {
          const idx = Number(parts[4]);
          const page = job.pages[idx];
          if (!page) throw new HttpError(404, "page_unknown", `Seite ${idx + 1} existiert nicht.`);
          res.writeHead(200, { ...corsHeaders(req), "Content-Type": page.mime, "Cache-Control": "no-store", "Content-Length": page.buffer.length });
          return res.end(page.buffer);
        }
        return sendJson(req, res, 200, {
          id: job.id,
          state: job.state,
          error: job.error,
          host: job.host,
          settings: job.settings,
          elapsedMs: Date.now() - job.started,
          pages: job.pages.map((pg, i) => ({ index: i, mime: pg.mime, bytes: pg.buffer.length, url: `/api/scan/${job.id}/page/${i}` })),
        });
      }

      if (p === "/api/print" && req.method === "POST") {
        const data = await readBody(req);
        if (!data.length) throw new HttpError(400, "empty_upload", "Es kam keine Datei an.");
        const name = String(req.headers["x-roots-filename"] || "druck.bin").replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
        const tmp = path.join(os.tmpdir(), `roots-print-${Date.now()}-${name}`);
        fs.writeFileSync(tmp, data, { mode: 0o600 });
        try {
          const result = await printFile(tmp, {
            queue: url.searchParams.get("queue"),
            copies: url.searchParams.get("copies"),
            options: JSON.parse(url.searchParams.get("options") || "{}"),
          });
          return sendJson(req, res, 200, result);
        } finally {
          setTimeout(() => fs.existsSync(tmp) && fs.unlinkSync(tmp), 60000);
        }
      }

      throw new HttpError(404, "unknown_endpoint", `Unbekannter Endpunkt: ${p}`);
    }

    return serveStatic(req, res, p);
  } catch (e) {
    sendError(req, res, e);
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    [
      "ROOTS Print Bridge läuft.",
      `  Adresse   http://${HOST}:${PORT}`,
      `  Token     ${TOKEN}`,
      `  Datei     ${TOKEN_FILE}`,
      "",
    ].join("\n")
  );
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    process.stderr.write(`Port ${PORT} ist belegt. Läuft der Helfer schon? Anderer Port: ROOTS_PRINT_PORT=7332 node bridge/roots-print-bridge.js\n`);
    process.exit(2);
  }
  throw e;
});
