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
const dev = require("./device-lib.js");
const { HttpError } = dev;
const { listPrinters, resolveIppHosts, printerOptions, jobsFor, scannerCapabilities, scannerStatus, printFile, diagnose } = dev;

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


/** dns-sd never exits on its own — run it for `ms` and keep what it printed. */





/* -------------------------------------------------------------- printers --- */





/* --------------------------------------------------------------- scanner --- */

const scanJobs = new Map(); // id -> { pages: [{buffer, mime}], state, error, started, settings }
let scanCounter = 0;




async function startScan(settings) {
  const started = await dev.startScanJob(settings);
  const id = `scan-${++scanCounter}-${Date.now().toString(36)}`;
  const job = { id, ...started, pages: [], state: "running", error: null, started: Date.now(), settings };
  scanJobs.set(id, job);
  collectPages(job);
  return { id, jobUrl: job.jobUrl, host: job.host };
}

async function collectPages(job) {
  try {
    for await (const page of dev.streamPages(job)) {
      job.pages.push(page);
    }
    if (!job.pages.length) {
      job.state = "error";
      job.error = { code: "no_pages", message: "Der Scanner hat keine Seite geliefert.", hint: "Vorlage einlegen und erneut starten. Bei Einzug: Papier gerade und Anschlag korrekt." };
      return;
    }
    job.state = "done";
  } catch (e) {
    job.state = "error";
    job.error = { code: e.code || "transfer_failed", message: e.message || "Übertragung abgebrochen.", hint: e.hint || "WLAN-Verbindung prüfen und Scan erneut starten." };
  }
}

/* ----------------------------------------------------------------- print --- */


/* ------------------------------------------------------------- diagnose --- */


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
      if (p === "/api/diagnose" && req.method === "GET") {
        return sendJson(req, res, 200, await diagnose(url.searchParams.get("host"), { passive: url.searchParams.get("passive") === "1" }));
      }
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
