/**
 * ROOTS Print – frontend.
 *
 * Zwei Wege zum Gerät, gleiche Oberfläche:
 *
 *   bridge  Der lokale Helfer auf 127.0.0.1. Schnell, ohne Cloud, aber nur auf
 *           dem eigenen Mac und nur in Browsern, die den Zugriff erlauben.
 *   relay   Warteschlange in Supabase. Der Agent im Büro arbeitet sie ab. Läuft
 *           überall — Safari, Mac-App, Handy, von zuhause.
 *
 * Der Helfer hat Vorrang, wenn er antwortet; sonst übernimmt der Relay.
 */
(function () {
  "use strict";

  const CFG = window.ROOTS_PRINT_CONFIG;
  const LS_TOKEN = "roots-print-token";
  const LS_URL = "roots-print-url";
  const LS_MODE = "roots-print-mode";

  /**
   * In einem sandboxed iframe (so hängt die Kachel im Intranet) wirft jeder
   * Zugriff auf localStorage eine SecurityError-Ausnahme. Ohne diese Kapselung
   * bricht das Skript beim Start ab — sichtbar als Anmeldemaske, die nie
   * verschwindet.
   */
  const memoryStore = new Map();
  function lsGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return memoryStore.has(key) ? memoryStore.get(key) : null;
    }
  }
  function lsSet(key, value) {
    memoryStore.set(key, value);
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* Sandbox: der Wert lebt nur in dieser Sitzung */
    }
  }
  function lsDel(key) {
    memoryStore.delete(key);
    try {
      window.localStorage.removeItem(key);
    } catch (e) {
      /* Sandbox: es gab nichts zu löschen */
    }
  }

  const state = {
    mode: lsGet(LS_MODE) || "auto",
    active: null, // 'bridge' | 'relay'
    bridge: null,
    bridgeIssue: null,
    token: lsGet(LS_TOKEN) || "",
    url: lsGet(LS_URL) || CFG.BRIDGE_ORIGINS[0],
    printers: [],
    devices: [],
    caps: null,
    scan: null,
    scanPages: [],
    pollTimer: null,
    profile: null,
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const bytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
  const relay = () => window.RootsPrintRelay;

  /* ------------------------------------------------------------- messages --- */

  const NETWORK_HINTS = {
    offline: {
      message: "Der Helfer auf diesem Mac antwortet nicht.",
      hint: "Ohne Helfer läuft alles über die Warteschlange in Supabase. Direkt drucken: <code>node bridge/roots-print-bridge.js</code>.",
    },
    blocked: {
      message: "Der Browser blockiert den Zugriff auf 127.0.0.1.",
      hint: "Safari erlaubt das von einer HTTPS-Seite nicht. Das Tool nutzt deshalb die Warteschlange in Supabase.",
    },
  };

  function msg(target, kind, message, hint) {
    const el = typeof target === "string" ? $(target) : target;
    if (!el) return;
    const icon = kind === "err" ? "fa-triangle-exclamation" : kind === "ok" ? "fa-circle-check" : "fa-circle-info";
    el.innerHTML = `<div class="msg ${kind}"><i class="fa-solid ${icon}"></i><div><strong>${esc(message)}</strong>${hint ? `<span class="hint">${hint}</span>` : ""}</div></div>`;
  }

  const clear = (sel) => {
    const el = $(sel);
    if (el) el.innerHTML = "";
  };
  const showError = (sel, e) => msg(sel, "err", e.message || "Unbekannter Fehler", e.hint || null);

  /* --------------------------------------------------------------- bridge --- */

  async function call(path, { method = "GET", body, headers = {}, raw = false, timeout = 200000 } = {}) {
    if (!state.token) throw { code: "no_token", message: "Es ist kein Token für den Helfer gesetzt.", hint: "Unter „Verbindung“ das Token aus <code>~/.roots-print/token</code> einsetzen." };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(state.url + path, { method, body, signal: ctrl.signal, headers: { Authorization: "Bearer " + state.token, ...headers } });
    } catch (err) {
      if (err.name === "AbortError") throw { code: "timeout", message: "Der Helfer hat zu lange nicht geantwortet.", hint: "Gerät wach? Scan mit weniger Seiten oder niedrigerer Auflösung erneut versuchen." };
      const kind = location.protocol === "https:" ? "blocked" : "offline";
      throw { code: kind, ...NETWORK_HINTS[kind] };
    } finally {
      clearTimeout(t);
    }
    if (raw) {
      if (!res.ok) throw await asError(res);
      return res;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw data.error || { code: "http_" + res.status, message: `Helfer antwortete mit HTTP ${res.status}.` };
    return data;
  }

  async function asError(res) {
    const data = await res.json().catch(() => null);
    return data?.error || { code: "http_" + res.status, message: `HTTP ${res.status}` };
  }

  async function detectBridge(onlyGiven) {
    state.bridgeIssue = null;
    const candidates = onlyGiven ? [state.url] : [state.url, ...CFG.BRIDGE_ORIGINS.filter((u) => u !== state.url)];
    for (const url of candidates) {
      try {
        const res = await fetch(url + "/api/health", { headers: state.token ? { Authorization: "Bearer " + state.token } : {} });
        if (!res.ok) continue;
        const info = await res.json();
        state.url = url;
        state.bridge = info;
        lsSet(LS_URL, url);
        if (!info.tokenValid) {
          state.bridgeIssue = "token";
          return false;
        }
        return true;
      } catch (e) {
        /* nächster Kandidat */
      }
    }
    state.bridge = null;
    state.bridgeIssue = "offline";
    return false;
  }

  function renderModePill() {
    const pill = $("#bridge-pill");
    if (state.active === "bridge") {
      pill.className = "pill ok";
      pill.innerHTML = `<i class="fa-solid fa-bolt"></i> Helfer ${esc(state.bridge?.version || "")}`;
      return;
    }
    const online = state.printers.some((p) => p.agentOnline);
    pill.className = "pill " + (online ? "ok" : "warn");
    pill.innerHTML = `<i class="fa-solid fa-cloud"></i> Warteschlange${online ? "" : " · Agent offline"}`;
  }

  /**
   * Reihenfolge im Automatikmodus: erst die Warteschlange, denn dort läuft der
   * Agent im Büro und alle bekommen dasselbe Verhalten. Nur wenn dort kein Agent
   * antwortet, greift der lokale Helfer als Rückfall.
   */
  async function pickMode() {
    if (TOKENLESS) {
      // Im sandboxed iframe ist 127.0.0.1 ohnehin nicht erreichbar.
      state.active = "relay";
      return;
    }
    if (state.mode === "relay") {
      state.active = "relay";
      return;
    }
    if (state.mode === "bridge") {
      state.active = "bridge";
      const ok = await detectBridge();
      if (!ok) {
        if (state.bridgeIssue === "token") msg("#banner", "err", "Der Helfer läuft, akzeptiert das Token aber nicht.", 'Token aus <code>~/.roots-print/token</code> unter „Verbindung“ einsetzen.');
        else {
          const kind = location.protocol === "https:" ? "blocked" : "offline";
          msg("#banner", "err", NETWORK_HINTS[kind].message, NETWORK_HINTS[kind].hint);
        }
      }
      return;
    }

    const agents = await relay().agentList();
    const live = agents.some((a) => a.last_seen_at && Date.now() - Date.parse(a.last_seen_at) < relay().AGENT_STALE_MS);
    if (live) {
      state.active = "relay";
      clear("#banner");
      return;
    }
    const ok = await detectBridge();
    if (ok) {
      state.active = "bridge";
      msg("#banner", "info", "Der Agent im Büro meldet sich nicht — es läuft über den lokalen Helfer.", "Aufträge gehen direkt an den Drucker in diesem Netz, nicht über die Warteschlange.");
      return;
    }
    state.active = "relay";
    msg("#banner", "err", "Weder der Agent im Büro noch ein lokaler Helfer antwortet.", agents.length ? "Auf dem Büro-Rechner: <code>node bridge/roots-print-agent.js</code>. Aufträge bleiben bis dahin in der Warteschlange." : "Es ist kein Agent freigeschaltet — siehe „Verbindung“.");
  }

  /* ------------------------------------------------------------- printers --- */

  const OPTION_LABELS = { ColorModel: "Farbe", Duplex: "Beidseitig", PageSize: "Papierformat", InputSlot: "Papierquelle", MediaType: "Medium", Collate: "Sortieren", cupsPrintQuality: "Qualität", cupsFinishingTemplate: "Finishing" };
  const VALUE_LABELS = { RGB: "Farbe", Gray: "Graustufen", Gray16: "Graustufen (16 bit)", None: "Aus", DuplexNoTumble: "Ein (lange Kante)", DuplexTumble: "Ein (kurze Kante)", True: "Ja", False: "Nein", auto: "Automatisch", "by-pass-tray": "Mehrzweckfach", "tray-1": "Kassette 1", none: "Keins" };

  async function loadPrinters() {
    try {
      if (state.active === "bridge") {
        const data = await call("/api/printers");
        state.printers = data.printers.map((p) => ({ id: p.name, queue: p.name, display_name: p.name, state: p.state, state_text: p.stateText, is_default: p.isDefault, device: p.device, options: null, agentOnline: true }));
      } else {
        state.printers = (await relay().printers()).map((p) => ({ ...p, device: null }));
      }
      renderModePill();
      const sel = $("#print-queue");
      sel.innerHTML = state.printers
        .map((p) => `<option value="${esc(p.id)}"${p.is_default ? " selected" : ""}>${esc(p.display_name || p.queue)}${p.is_default ? " (Standard)" : ""}${p.agentOnline ? "" : " — Agent offline"}</option>`)
        .join("");
      renderQueueTable();
      if (!state.printers.length) {
        msg("#print-result", "err", state.active === "bridge" ? "macOS kennt auf diesem Mac keinen Drucker." : "In der Warteschlange ist kein Drucker gemeldet.", state.active === "bridge" ? "Systemeinstellungen › Drucker & Scanner › Drucker hinzufügen." : "Der Agent im Büro muss laufen und freigeschaltet sein — siehe „Verbindung“.");
        $("#print-options").innerHTML = "";
        return;
      }
      const offline = state.printers.every((p) => !p.agentOnline);
      if (state.active === "relay" && offline) {
        msg("#banner", "err", "Der Agent im Büro hat sich zuletzt vor über fünf Minuten gemeldet.", "Aufträge bleiben in der Warteschlange, bis er wieder läuft.");
      }
      await loadOptions();
      fillScanHosts();
    } catch (e) {
      showError("#print-result", e);
    }
  }

  function currentPrinter() {
    const id = $("#print-queue").value;
    return state.printers.find((p) => String(p.id) === id) || null;
  }

  function renderQueueTable() {
    const body = $("#queue-table tbody");
    if (!body) return;
    body.innerHTML = state.printers
      .map((p) => {
        const cls = p.state === "idle" ? "ok" : p.state === "disabled" ? "err" : "warn";
        const via = state.active === "bridge" ? "Helfer" : `${esc(p.agent?.name || "Agent")}${p.agentOnline ? "" : " (offline)"}`;
        return `<tr><td><strong>${esc(p.display_name || p.queue)}</strong>${p.is_default ? ' <span class="pill">Standard</span>' : ""}</td><td><span class="pill ${cls}">${esc(p.state_text || p.state || "?")}</span></td><td>${via}</td></tr>`;
      })
      .join("");
  }

  async function loadOptions() {
    const printer = currentPrinter();
    const wrap = $("#print-options");
    if (!printer) return;
    let options = printer.options;
    if (state.active === "bridge") {
      wrap.innerHTML = '<div style="color:var(--muted);font-size:.84rem"><i class="fa-solid fa-circle-notch spin"></i> Optionen werden gelesen</div>';
      try {
        options = (await call("/api/printer/options?queue=" + encodeURIComponent(printer.queue))).options;
        printer.options = options;
      } catch (e) {
        wrap.innerHTML = "";
        return showError("#print-result", e);
      }
    }
    const usable = (options || []).filter((o) => (o.values || []).length > 1);
    wrap.innerHTML = usable.length
      ? usable
          .map((o) => {
            const label = OPTION_LABELS[o.key] || o.label;
            const opts = [...new Set(o.values)].map((v) => `<option value="${esc(v)}"${v === o.current ? " selected" : ""}>${esc(VALUE_LABELS[v] || v)}</option>`).join("");
            return `<div><label for="opt-${esc(o.key)}">${esc(label)}</label><select id="opt-${esc(o.key)}" data-opt="${esc(o.key)}">${opts}</select></div>`;
          })
          .join("")
      : `<div style="color:var(--muted);font-size:.84rem">Für diesen Drucker sind keine Optionen gemeldet.</div>`;
  }

  async function doPrint(file, filename) {
    const printer = currentPrinter();
    if (!printer) return msg("#print-result", "err", "Kein Drucker gewählt.", "Erst einen Drucker in der Liste auswählen.");
    const options = {};
    $$("#print-options select").forEach((s) => (options[s.dataset.opt] = s.value));
    const copies = $("#print-copies").value || "1";
    msg("#print-result", "info", "Auftrag wird übergeben…");
    try {
      if (state.active === "bridge") {
        const qs = new URLSearchParams({ queue: printer.queue, copies, options: JSON.stringify(options) });
        const res = await call("/api/print?" + qs.toString(), {
          method: "POST",
          body: file,
          headers: { "Content-Type": "application/octet-stream", "X-Roots-Filename": filename.replace(/[^\x20-\x7e]/g, "_") },
        });
        msg("#print-result", "ok", `An „${printer.queue}“ übergeben.`, res.jobId ? `Auftrag <code>${esc(res.jobId)}</code>` : null);
        loadJobs();
        return;
      }
      const jobId = await relay().submitPrint(printer.id, file, filename, { copies: Number(copies), options });
      msg("#print-result", "info", "In der Warteschlange. Warte auf den Agenten…");
      const done = await relay().waitFor(jobId, null, { timeoutMs: 180000 });
      if (done.status === "error") return showError("#print-result", done.error || { message: "Der Auftrag ist fehlgeschlagen." });
      msg("#print-result", "ok", `An „${printer.display_name || printer.queue}“ gedruckt.`, done.result?.jobId ? `Auftrag <code>${esc(done.result.jobId)}</code>` : null);
      loadJobs();
    } catch (e) {
      showError("#print-result", e);
    }
  }

  /* --------------------------------------------------------------- devices --- */

  async function loadDevices() {
    const body = $("#dev-table tbody");
    if (state.active === "relay") {
      const agents = await relay().agentList();
      body.innerHTML = agents.length
        ? agents
            .map((a) => {
              const seen = a.last_seen_at ? Date.parse(a.last_seen_at) : 0;
              const online = seen && Date.now() - seen < relay().AGENT_STALE_MS;
              return `<tr><td><strong>${esc(a.name)}</strong></td><td class="mono">${esc(a.hostname || "—")}</td><td>${esc(a.version || "—")}</td><td><span class="pill ${online ? "ok" : "err"}">${online ? "läuft" : "offline"}</span> ${a.last_seen_at ? new Date(a.last_seen_at).toLocaleString("de-DE") : ""}</td></tr>`;
            })
            .join("")
        : `<tr><td colspan="4">Kein Agent freigeschaltet. Siehe „Verbindung“.</td></tr>`;
      $("#dev-ssid").innerHTML = '<i class="fa-solid fa-cloud"></i> über Warteschlange';
      $("#dev-head").textContent = "Agenten";
      return;
    }
    $("#dev-head").textContent = "AirPrint im Netz";
    body.innerHTML = `<tr><td colspan="4"><i class="fa-solid fa-circle-notch spin"></i> Netz wird durchsucht</td></tr>`;
    try {
      const { devices } = await call("/api/discover", { timeout: 40000 });
      state.devices = devices;
      body.innerHTML = devices.length
        ? devices
            .map((d) => {
              const can = [d.canScan ? "Scan" : null, d.canColor ? "Farbe" : null, d.canDuplex ? "Duplex" : null].filter(Boolean).join(" · ") || "—";
              return `<tr><td><strong>${esc(d.model || d.instance)}</strong></td><td class="mono">${esc(d.host || "—")}</td><td>${esc(can)}</td><td>${d.adminUrl ? `<code class="mono">${esc(d.adminUrl)}</code>` : "—"}</td></tr>`;
            })
            .join("")
        : `<tr><td colspan="4">Kein AirPrint-Gerät geantwortet. Gerät wecken oder Diagnose starten.</td></tr>`;
      fillScanHosts();
    } catch (e) {
      body.innerHTML = "";
      showError("#banner", e);
    }
  }

  /* --------------------------------------------------------------- scanner --- */

  const COLOR_LABELS = { RGB24: "Farbe", Grayscale8: "Graustufen", BlackAndWhite1: "Schwarzweiß" };
  const INTENT_LABELS = { Document: "Dokument", Photo: "Foto", TextAndGraphic: "Text & Grafik", Preview: "Vorschau" };
  const FORMAT_LABELS = { "application/pdf": "PDF", "image/jpeg": "JPEG", "image/png": "PNG" };
  const PAPER = { "": "Ganze Fläche", a4: { label: "A4", w: 2480, h: 3508 }, letter: { label: "Letter", w: 2550, h: 3300 }, a5: { label: "A5", w: 1748, h: 2480 } };

  function scanners() {
    if (state.active === "relay") return state.printers.filter((p) => p.can_scan && p.scan_host).map((p) => ({ id: p.id, label: p.display_name || p.queue, host: p.scan_host, caps: p.scan_caps, online: p.agentOnline }));
    return state.devices.filter((d) => d.canScan && d.host).map((d) => ({ id: d.host, label: d.model || d.instance, host: d.host, caps: null, online: true }));
  }

  function fillScanHosts() {
    const sel = $("#scan-host");
    const list = scanners();
    const prev = sel.value;
    sel.innerHTML = list.map((s) => `<option value="${esc(s.id)}">${esc(s.label)} — ${esc(s.host)}${s.online ? "" : " (Agent offline)"}</option>`).join("");
    if (!list.length) {
      sel.innerHTML = `<option value="">Kein Scanner gemeldet</option>`;
      msg("#scan-result", "err", "Es ist kein Gerät mit Scan-Funktion gemeldet.", state.active === "bridge" ? "Unter „Geräte“ das Netz durchsuchen. Bleibt es leer: Diagnose starten." : "Der Agent im Büro muss laufen; er meldet die Scan-Fähigkeiten mit.");
      return;
    }
    if (prev && list.some((s) => String(s.id) === prev)) sel.value = prev;
    loadCaps();
  }

  function currentScanner() {
    const id = $("#scan-host").value;
    return scanners().find((s) => String(s.id) === id) || null;
  }

  function sourceCaps() {
    if (!state.caps) return null;
    const src = $("#scan-source").value;
    if (src === "feeder") return ($("#scan-duplex").value === "1" && state.caps.sources.feederDuplex) || state.caps.sources.feeder;
    return state.caps.sources.platen;
  }

  async function loadCaps() {
    const s = currentScanner();
    if (!s) return;
    clear("#scan-result");
    try {
      state.caps = s.caps || (state.active === "bridge" ? await call("/api/scanner/capabilities?host=" + encodeURIComponent(s.host), { timeout: 30000 }) : null);
      if (!state.caps) {
        msg("#scan-result", "err", "Für dieses Gerät sind keine Scan-Fähigkeiten gemeldet.", "Der Agent liest sie beim Start. Agent neu starten, danach Liste neu laden.");
        return;
      }
      const src = state.caps.sources;
      $("#scan-source").innerHTML = [src.platen ? '<option value="platen">Flachbett</option>' : "", src.feeder ? '<option value="feeder">Einzug</option>' : ""].join("");
      $("#scan-duplex").disabled = !state.caps.supportsDuplex;
      if (!state.caps.supportsDuplex) $("#scan-duplex").value = "0";
      renderScanOptions();
      refreshScannerStatus();
    } catch (e) {
      showError("#scan-result", e);
    }
  }

  function renderScanOptions() {
    const caps = sourceCaps();
    if (!caps) return;
    const fill = (sel, values, labels, fallback) => {
      const el = $(sel);
      const prev = el.value;
      const list = values && values.length ? values : fallback;
      el.innerHTML = list.map((v) => `<option value="${esc(v)}">${esc((labels && labels[v]) || v)}</option>`).join("");
      if (prev && list.includes(prev)) el.value = prev;
    };
    fill("#scan-color", caps.colorModes, COLOR_LABELS, ["RGB24"]);
    fill("#scan-res", (caps.resolutions || []).map(String), null, ["300"]);
    fill("#scan-format", (caps.formats || []).filter((f) => f !== "application/octet-stream"), FORMAT_LABELS, ["application/pdf"]);
    fill("#scan-intent", caps.intents, INTENT_LABELS, ["Document"]);
    $("#scan-size").innerHTML = Object.entries(PAPER).map(([k, v]) => `<option value="${k}">${esc(typeof v === "string" ? v : v.label)}</option>`).join("");
    $$("#scan-res option").forEach((o) => (o.textContent = o.value + " dpi"));
  }

  async function refreshScannerStatus() {
    const s = currentScanner();
    const pill = $("#scan-adf");
    if (!s) return;
    if (state.active === "relay") {
      pill.className = "pill " + (s.online ? "ok" : "err");
      pill.innerHTML = `<i class="fa-solid fa-${s.online ? "circle-check" : "circle-xmark"}"></i> Agent ${s.online ? "läuft" : "offline"}`;
      return;
    }
    pill.className = "pill";
    pill.innerHTML = '<i class="fa-solid fa-circle-notch spin"></i> Status';
    try {
      const st = await call("/api/scanner/status?host=" + encodeURIComponent(s.host), { timeout: 15000 });
      pill.className = "pill " + (st.state === "Idle" ? (st.adfLoaded ? "ok" : "") : "warn");
      pill.innerHTML = `<i class="fa-solid fa-${st.state === "Idle" ? "circle-check" : "hourglass-half"}"></i> ${esc(st.state || "?")}${st.adfState ? " · Einzug " + (st.adfLoaded ? "belegt" : "leer") : ""}`;
    } catch (e) {
      pill.className = "pill err";
      pill.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> kein Status';
      showError("#scan-result", e);
    }
  }

  function scanSettings(scanner) {
    const size = PAPER[$("#scan-size").value];
    const s = {
      host: scanner.host,
      source: $("#scan-source").value,
      colorMode: $("#scan-color").value,
      resolution: Number($("#scan-res").value),
      format: $("#scan-format").value,
      intent: $("#scan-intent").value,
      duplex: $("#scan-duplex").value === "1",
    };
    // eSCL zählt Scanbereiche in 1/300 Zoll, unabhängig von der Auflösung.
    if (size && typeof size !== "string") {
      s.width = size.w;
      s.height = size.h;
    }
    return s;
  }

  async function startScan() {
    const scanner = currentScanner();
    if (!scanner) return msg("#scan-result", "err", "Kein Scanner gewählt.", "Unter „Geräte“ nachsehen, welche Geräte gemeldet sind.");
    $("#scan-go").disabled = true;
    $("#scan-pages").innerHTML = "";
    $("#scan-actions").classList.add("hidden");
    state.scanPages = [];
    msg("#scan-result", "info", "Scan läuft…", "Seiten erscheinen, sobald sie übertragen sind.");
    const settings = scanSettings(scanner);
    try {
      if (state.active === "bridge") {
        state.scan = await call("/api/scan", { method: "POST", body: JSON.stringify(settings), headers: { "Content-Type": "application/json" }, timeout: 60000 });
        pollScan();
        return;
      }
      const jobId = await relay().submitScan(scanner.id, settings);
      const done = await relay().waitFor(jobId, (st) => renderRelayPages(st), { timeoutMs: 420000 });
      $("#scan-go").disabled = false;
      if (done.status === "error") return showError("#scan-result", done.error || { message: "Der Scan ist fehlgeschlagen." });
      renderRelayPages(done);
      const secs = Math.round((Date.parse(done.finished_at) - Date.parse(done.created_at)) / 1000);
      msg("#scan-result", "ok", `${done.pages.length} ${done.pages.length === 1 ? "Seite" : "Seiten"} gescannt.`, `${secs} s · ${settings.resolution} dpi · ${COLOR_LABELS[settings.colorMode] || settings.colorMode}`);
      $("#scan-actions").classList.toggle("hidden", !done.pages.length);
    } catch (e) {
      $("#scan-go").disabled = false;
      showError("#scan-result", e);
    }
  }

  async function pollScan() {
    if (!state.scan) return;
    clearTimeout(state.pollTimer);
    try {
      const job = await call("/api/scan/" + encodeURIComponent(state.scan.id), { timeout: 30000 });
      renderBridgePages(job);
      if (job.state === "running") {
        state.pollTimer = setTimeout(pollScan, 1500);
        return;
      }
      $("#scan-go").disabled = false;
      if (job.state === "error") return showError("#scan-result", job.error || { message: "Der Scan brach ab." });
      msg("#scan-result", "ok", `${job.pages.length} ${job.pages.length === 1 ? "Seite" : "Seiten"} gescannt.`, `${Math.round(job.elapsedMs / 1000)} s · ${job.settings.resolution} dpi · ${COLOR_LABELS[job.settings.colorMode] || job.settings.colorMode}`);
      $("#scan-actions").classList.toggle("hidden", !job.pages.length);
    } catch (e) {
      $("#scan-go").disabled = false;
      showError("#scan-result", e);
    }
  }

  /* ----------------------------------------------------------------- pages --- */

  function ext(mime) {
    return mime.includes("pdf") ? "pdf" : mime.includes("png") ? "png" : "jpg";
  }

  function renderBridgePages(job) {
    state.scanPages = job.pages.map((p, i) => ({ idx: i, mime: p.mime, bytes: p.bytes, url: state.url + p.url + "?token=" + encodeURIComponent(state.token) }));
    paintPages();
  }

  function renderRelayPages(job) {
    state.scanPages = job.pages.map((p) => ({ idx: p.idx, mime: p.mime, bytes: p.bytes, page: p }));
    paintPages();
  }

  function paintPages() {
    const wrap = $("#scan-pages");
    wrap.innerHTML = state.scanPages
      .map((p, i) => {
        const thumb = p.url && p.mime.startsWith("image/") ? `<img src="${esc(p.url)}" alt="Seite ${i + 1}">` : `<i class="fa-solid fa-${p.mime.includes("pdf") ? "file-pdf" : "image"}"></i>`;
        return `<div class="page">
          <div class="thumb" data-idx="${i}">${thumb}</div>
          <div class="meta"><span>Seite ${i + 1} · ${bytes(p.bytes)}</span><a href="#" data-dl="${i}">Laden</a></div>
        </div>`;
      })
      .join("");
    $$("#scan-pages .thumb").forEach((el) => el.addEventListener("click", () => openPreview(Number(el.dataset.idx))));
    $$("#scan-pages [data-dl]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        savePage(Number(el.dataset.dl));
      })
    );
  }

  /** Blob-URL für Vorschau und Download; im Relay kommen die Bytes per RPC. */
  async function pageObjectUrl(p) {
    if (p.url) return p.url;
    const blob = await relay().pageBlob(p.page);
    p.blobUrl = p.blobUrl || URL.createObjectURL(blob);
    p.blob = blob;
    return p.blobUrl;
  }

  async function pageBlob(p) {
    if (p.blob) return p.blob;
    if (p.url) {
      const res = await call(p.url.replace(state.url, "").split("?")[0], { raw: true });
      p.blob = await res.blob();
      return p.blob;
    }
    await pageObjectUrl(p);
    return p.blob;
  }

  async function savePage(i) {
    const p = state.scanPages[i];
    if (!p) return;
    const name = `scan-${String(i + 1).padStart(2, "0")}.${ext(p.mime)}`;
    try {
      const blob = await pageBlob(p);
      if (window.RootsUserBridge?.downloadBlob) {
        window.RootsUserBridge.downloadBlob(blob, name);
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      showError("#scan-result", e);
    }
  }

  async function openPreview(i) {
    const p = state.scanPages[i];
    if (!p) return;
    $("#modal-title").textContent = `Seite ${i + 1}`;
    $("#modal-content").innerHTML = '<i class="fa-solid fa-circle-notch spin" style="font-size:1.6rem;color:#94a3b8"></i>';
    $("#modal").classList.remove("hidden");
    try {
      const url = await pageObjectUrl(p);
      $("#modal-content").innerHTML = p.mime.startsWith("image/") ? `<img src="${esc(url)}" alt="Seite ${i + 1}">` : `<iframe src="${esc(url)}" style="height:80vh" title="Seite ${i + 1}"></iframe>`;
      const dl = $("#modal-dl");
      dl.onclick = (ev) => {
        ev.preventDefault();
        savePage(i);
      };
    } catch (e) {
      $("#modal-content").innerHTML = "";
      showError("#scan-result", e);
      $("#modal").classList.add("hidden");
    }
  }

  async function printScan() {
    const p = state.scanPages[0];
    if (!p) return;
    msg("#scan-result", "info", "Scan wird an den Drucker übergeben…");
    try {
      await doPrint(await pageBlob(p), "scan." + ext(p.mime));
    } catch (e) {
      showError("#scan-result", e);
    }
  }

  /* ------------------------------------------------------------------ jobs --- */

  async function loadJobs() {
    const body = $("#jobs-table tbody");
    if (!body) return;
    try {
      if (state.active === "bridge") {
        const { jobs } = await call("/api/printer/jobs?queue=" + encodeURIComponent(currentPrinter()?.queue || ""));
        body.innerHTML = jobs.length ? jobs.map((j) => `<tr><td class="mono">${esc(j.id)}</td><td>${esc(j.user || "—")}</td><td>${j.size ? bytes(j.size) : "—"}</td><td>im Drucker</td></tr>`).join("") : `<tr><td colspan="4">Keine offenen Aufträge.</td></tr>`;
        return;
      }
      const data = await relay().jobs();
      const label = { queued: "wartet", claimed: "übernommen", running: "läuft", done: "fertig", error: "Fehler" };
      const cls = { queued: "warn", claimed: "warn", running: "warn", done: "ok", error: "err" };
      body.innerHTML = (data || []).length
        ? data
            .map((j) => `<tr><td class="mono">${esc(j.kind)} · ${esc(j.id.slice(0, 8))}</td><td>${esc(j.requested_email || "—")}</td><td>${esc(j.filename || (j.settings?.resolution ? j.settings.resolution + " dpi" : "—"))}</td><td><span class="pill ${cls[j.status] || ""}">${esc(label[j.status] || j.status)}</span> ${new Date(j.created_at).toLocaleString("de-DE")}${j.error?.message ? `<div style="color:var(--err);font-size:.78rem">${esc(j.error.message)}</div>` : ""}</td></tr>`)
            .join("")
        : `<tr><td colspan="4">Keine Aufträge in den letzten drei Tagen.</td></tr>`;
    } catch (e) {
      body.innerHTML = "";
      showError("#banner", e.hint ? e : { message: e.message || "Aufträge konnten nicht geladen werden." });
    }
  }

  /* -------------------------------------------------------------- diagnose --- */

  async function runDiagnose() {
    const out = $("#diag-out");
    if (state.active !== "bridge") {
      const agents = await relay().agentList();
      const online = agents.filter((a) => a.last_seen_at && Date.now() - Date.parse(a.last_seen_at) < relay().AGENT_STALE_MS);
      const checks = [
        { ok: true, label: "Warteschlange", detail: "Supabase erreichbar", hint: null },
        { ok: agents.length > 0, label: "Agent freigeschaltet", detail: `${agents.length} eingetragen`, hint: agents.length ? null : "Agent im Büro starten und den angezeigten Hash unter „Verbindung“ eintragen." },
        { ok: online.length > 0, label: "Agent läuft", detail: online.length ? online.map((a) => a.name).join(", ") : "keine Meldung in den letzten fünf Minuten", hint: online.length ? null : "Auf dem Büro-Rechner: `node bridge/roots-print-agent.js`." },
        { ok: state.printers.length > 0, label: "Drucker gemeldet", detail: state.printers.map((p) => p.display_name || p.queue).join(", ") || "keine", hint: state.printers.length ? null : "Der Agent meldet Drucker beim Start; Agent neu starten." },
      ];
      out.innerHTML = renderChecks(checks);
      out.insertAdjacentHTML(
        "beforeend",
        '<div class="msg info" style="margin-top:14px"><i class="fa-solid fa-circle-info"></i><div><strong>Die Netzprüfung am Gerät läuft nur über den lokalen Helfer.</strong><span class="hint">Die Warteschlange sieht den Drucker nicht selbst — sie kennt nur, was der Agent meldet.</span></div></div>'
      );
      return;
    }
    out.innerHTML = '<i class="fa-solid fa-circle-notch spin"></i> Prüfung läuft';
    try {
      const host = currentScanner()?.host || "";
      const d = await call("/api/diagnose?host=" + encodeURIComponent(host), { timeout: 60000 });
      $("#dev-ssid").innerHTML = `<i class="fa-solid fa-wifi"></i> ${esc(d.ssid || "kein WLAN")}`;
      out.innerHTML = renderChecks(d.checks);
    } catch (e) {
      out.innerHTML = "";
      showError("#diag-out", e);
    }
  }

  function renderChecks(checks) {
    return checks
      .map(
        (c) => `<div class="check">
          <div class="ico ${c.ok ? "ok" : "bad"}"><i class="fa-solid fa-${c.ok ? "circle-check" : "circle-xmark"}"></i></div>
          <div class="body"><strong>${esc(c.label)}</strong>
            <div class="detail mono">${esc(c.detail)}</div>
            ${c.hint ? `<div class="fix"><i class="fa-solid fa-wrench"></i> ${esc(c.hint)}</div>` : ""}
          </div></div>`
      )
      .join("");
  }

  /* ----------------------------------------------------------------- auth --- */

  let sb = null;
  const IN_IFRAME = window.parent !== window;
  const EMBEDDED = IN_IFRAME || new URLSearchParams(location.search).has("authBroker");
  // Sandboxed iframes bekommen vom Intranet keine Sitzung. Dann laufen alle
  // Anfragen ueber den Broker, genau wie bei Team-Kalender, Notes und SOP-Tool.
  const TOKENLESS = window.ROOTS_TOKENLESS_EMBED === true;

  function domainAllowed(email) {
    const dom = String(email || "").split("@")[1] || "";
    return CFG.ALLOWED_EMAIL_DOMAINS.includes(dom.toLowerCase());
  }

  async function bootAuth() {
    if (TOKENLESS) {
      $("#login-form").classList.add("hidden");
      msg("#gate-msg", "info", "Anmeldung wird vom Intranet übernommen…");
      relay().useBroker();
      // Das Intranet meldet die Identität, sobald die Brücke sie bestätigt hat.
      window.addEventListener("roots-broker-context-ready", (e) => applyBrokerContext(e.detail));
      window.addEventListener("roots-auth-signed-out", () => {
        booted = false;
        msg("#gate-msg", "err", "Die Sitzung des Intranets ist beendet.", "Im Intranet neu anmelden, danach das Tool erneut öffnen.");
        showGate(true);
      });
      setTimeout(() => {
        if (!$("#app").classList.contains("hidden")) return;
        msg("#gate-msg", "err", "Das Intranet hat keine Anmeldung übergeben.", "Im Intranet neu laden. Bleibt es dabei, ist <code>roots-user-bridge.js</code> nicht geladen.");
      }, 9000);
      return;
    }

    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    // roots-user-bridge.js greift den Client hier ab und setzt die Sitzung, die
    // das Intranet übergibt — wie in den anderen ROOTS-Tools.
    window.__rootsSupabaseClient = sb;
    relay().use(sb);

    if (EMBEDDED) {
      $("#login-form").classList.add("hidden");
      msg("#gate-msg", "info", "Anmeldung wird vom Intranet übernommen…");
      window.addEventListener("roots-auth-ready", (e) => applySession(e.detail?.session || null));
      window.addEventListener("roots-auth-signed-out", () => {
        booted = false;
        msg("#gate-msg", "err", "Die Sitzung des Intranets ist beendet.", "Im Intranet neu anmelden, danach das Tool erneut öffnen.");
        showGate(true);
      });
      setTimeout(() => window.RootsUserBridge?.syncAuthFromParentStorage?.(), 300);
      setTimeout(() => {
        if (!$("#app").classList.contains("hidden")) return;
        msg("#gate-msg", "err", "Das Intranet hat keine Sitzung übergeben.", "Im Intranet abmelden und neu anmelden. Bleibt es dabei, ist <code>roots-user-bridge.js</code> nicht geladen.");
      }, 8000);
    }

    const { data } = await sb.auth.getSession();
    applySession(data.session);
    sb.auth.onAuthStateChange((_e, session) => applySession(session));
  }

  function applySession(session) {
    const email = session?.user?.email || "";
    if (!session) return showGate(EMBEDDED);
    if (!domainAllowed(email)) {
      msg("#gate-msg", "err", "Dieses Konto gehört nicht zu ROOTS.", "Drucken und Scannen sind auf Adressen der ROOTS-Domänen beschränkt.");
      if (!EMBEDDED) sb.auth.signOut();
      return showGate(true);
    }
    $("#gate").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#user-pill").innerHTML = `<i class="fa-solid fa-user"></i> ${esc(email)}`;
    if (window.RootsUser && window.RootsUser._loadAndMount) {
      try {
        window.RootsUser._loadAndMount(sb);
      } catch (e) {
        /* die Bridge hängt sich selbst ein, sobald sie bereit ist */
      }
    }
    void loadProfile();
    bootApp();
  }

  /** Tokenloser Weg: Identität und Rolle kommen aus der Broker-Antwort. */
  function applyBrokerContext(context) {
    const email = context?.user?.email || context?.profile?.email || "";
    if (!context?.user?.id) {
      msg("#gate-msg", "err", "Das Intranet hat keine Anmeldung übergeben.", "Im Intranet neu anmelden.");
      return showGate(true);
    }
    if (!domainAllowed(email)) {
      msg("#gate-msg", "err", "Dieses Konto gehört nicht zu ROOTS.", "Drucken und Scannen sind auf Adressen der ROOTS-Domänen beschränkt.");
      return showGate(true);
    }
    state.profile = context.profile || null;
    clear("#gate-msg");
    $("#gate").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#user-pill").innerHTML = `<i class="fa-solid fa-user"></i> ${esc(email)}`;
    $("#agent-admin").classList.toggle("hidden", context.profile?.app_role !== "admin");
    bootApp();
  }

  async function loadProfile() {
    try {
      const { data } = await sb.from("profiles").select("id, app_role").eq("id", (await sb.auth.getUser()).data.user.id).maybeSingle();
      state.profile = data || null;
      $("#agent-admin").classList.toggle("hidden", data?.app_role !== "admin");
    } catch (e) {
      /* ohne Profil bleibt der Agent-Bereich verborgen */
    }
  }

  function showGate(keepMsg) {
    $("#app").classList.add("hidden");
    $("#gate").classList.remove("hidden");
    if (!keepMsg) clear("#gate-msg");
  }

  /* ------------------------------------------------------------------ app --- */

  let booted = false;
  async function bootApp() {
    if (booted) return;
    booted = true;
    $("#conn-url").value = state.url;
    $("#conn-token").value = state.token;
    $("#conn-mode").value = state.mode;
    if (TOKENLESS) {
      $("#conn-mode").value = "relay";
      $("#conn-mode").disabled = true;
      $("#conn-local").classList.add("hidden");
    }
    await pickMode();
    renderModePill();
    await loadPrinters();
    loadDevices();
    loadJobs();
  }

  async function rebootApp() {
    booted = false;
    clear("#banner");
    await bootApp();
  }

  function switchView(view) {
    $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $$("section[data-panel]").forEach((s) => s.classList.toggle("hidden", s.dataset.panel !== view));
    if (view === "jobs") loadJobs();
    if (view === "devices") loadDevices();
    if (view === "scan" && !state.caps) fillScanHosts();
  }

  function wire() {
    $("#login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("#gate-email").value.trim();
      const password = $("#gate-pw").value;
      if (!domainAllowed(email)) return msg("#gate-msg", "err", "Diese Adresse ist nicht freigegeben.", "Nur ROOTS-Adressen können drucken und scannen.");
      msg("#gate-msg", "info", "Anmeldung läuft…");
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) msg("#gate-msg", "err", "Anmeldung fehlgeschlagen.", "E-Mail und Passwort sind dieselben wie im ROOTS Intranet.");
      else clear("#gate-msg");
    });

    $("#logout").addEventListener("click", () => sb.auth.signOut().then(() => location.reload()));
    $$("nav button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

    $("#print-queue").addEventListener("change", () => {
      loadOptions();
      loadJobs();
    });
    $("#print-reload").addEventListener("click", loadPrinters);
    $("#print-go").addEventListener("click", () => {
      const f = $("#print-file").files[0];
      if (!f) return msg("#print-result", "err", "Es ist keine Datei gewählt.", "PDF, JPEG, PNG oder TXT wählen.");
      doPrint(f, f.name);
    });

    $("#scan-host").addEventListener("change", loadCaps);
    $("#scan-source").addEventListener("change", () => {
      renderScanOptions();
      refreshScannerStatus();
    });
    $("#scan-duplex").addEventListener("change", renderScanOptions);
    $("#scan-go").addEventListener("click", startScan);
    $("#scan-status").addEventListener("click", refreshScannerStatus);
    $("#scan-print").addEventListener("click", printScan);
    $("#scan-dl-all").addEventListener("click", async () => {
      for (let i = 0; i < state.scanPages.length; i++) await savePage(i);
    });

    $("#dev-refresh").addEventListener("click", loadDevices);
    $("#jobs-refresh").addEventListener("click", loadJobs);
    $("#diag-run").addEventListener("click", runDiagnose);

    $("#conn-mode").addEventListener("change", async () => {
      state.mode = $("#conn-mode").value;
      lsSet(LS_MODE, state.mode);
      await rebootApp();
      msg("#conn-out", "ok", state.active === "bridge" ? "Läuft über den lokalen Helfer." : "Läuft über die Warteschlange.");
    });

    $("#conn-save").addEventListener("click", async () => {
      state.url = $("#conn-url").value.trim().replace(/\/$/, "");
      state.token = $("#conn-token").value.trim();
      lsSet(LS_URL, state.url);
      lsSet(LS_TOKEN, state.token);
      const ok = await detectBridge(true);
      if (ok) {
        msg("#conn-out", "ok", `Verbunden mit ${state.url}.`);
        state.mode = "auto";
        lsSet(LS_MODE, "auto");
        await rebootApp();
      } else if (state.bridgeIssue === "token") {
        msg("#conn-out", "err", "Der Helfer läuft, akzeptiert dieses Token aber nicht.", "Aktuelles Token anzeigen: <code>cat ~/.roots-print/token</code>");
      } else {
        const kind = location.protocol === "https:" ? "blocked" : "offline";
        msg("#conn-out", "err", `Unter ${esc(state.url)} antwortet kein Helfer.`, NETWORK_HINTS[kind].hint);
      }
    });
    $("#conn-forget").addEventListener("click", () => {
      lsDel(LS_TOKEN);
      state.token = "";
      $("#conn-token").value = "";
      msg("#conn-out", "info", "Token gelöscht.");
    });

    $("#agent-add").addEventListener("click", async () => {
      const name = $("#agent-name").value.trim();
      const hash = $("#agent-hash").value.trim();
      if (!/^[0-9a-f]{64}$/i.test(hash)) return msg("#agent-out", "err", "Der Hash muss 64 Hex-Zeichen haben.", "Auf dem Büro-Rechner anzeigen: <code>node bridge/roots-print-agent.js --hash</code>");
      try {
        await relay().registerAgent(name, hash);
        msg("#agent-out", "ok", "Agent freigeschaltet.", "Er meldet sich innerhalb einer Minute mit seinen Druckern.");
        $("#agent-hash").value = "";
        loadDevices();
      } catch (e) {
        showError("#agent-out", e);
      }
    });

    $("#modal-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
    $("#modal").addEventListener("click", (e) => {
      if (e.target.id === "modal") $("#modal").classList.add("hidden");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") $("#modal").classList.add("hidden");
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    wire();
    bootAuth().catch(() => msg("#gate-msg", "err", "Supabase ist nicht erreichbar.", "Netzverbindung prüfen und Seite neu laden."));
  });
})();
