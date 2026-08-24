/**
 * ROOTS Print – frontend.
 *
 * Zwei Wege zum Gerät, gleiche Oberfläche:
 *   relay   Warteschlange in Supabase, abgearbeitet vom Agenten im Büro.
 *   bridge  Lokaler Helfer auf 127.0.0.1, nur auf dem eigenen Mac.
 *
 * Im Intranet läuft das Tool tokenlos im sandboxed iframe: Identität und alle
 * Datenzugriffe laufen über den Broker des Intranets.
 */
(function () {
  "use strict";

  const CFG = window.ROOTS_PRINT_CONFIG;
  const LS = { token: "roots-print-token", url: "roots-print-url", mode: "roots-print-mode" };

  /* --------------------------------------------------------------- storage --- */

  // Im sandboxed iframe wirft jeder localStorage-Zugriff SecurityError.
  const mem = new Map();
  const lsGet = (k) => {
    try {
      return window.localStorage.getItem(k);
    } catch (e) {
      return mem.has(k) ? mem.get(k) : null;
    }
  };
  const lsSet = (k, v) => {
    mem.set(k, v);
    try {
      window.localStorage.setItem(k, v);
    } catch (e) {
      /* nur für diese Sitzung */
    }
  };
  const lsDel = (k) => {
    mem.delete(k);
    try {
      window.localStorage.removeItem(k);
    } catch (e) {
      /* nichts zu löschen */
    }
  };

  const state = {
    mode: lsGet(LS.mode) || "auto",
    active: null,
    bridge: null,
    bridgeIssue: null,
    token: lsGet(LS.token) || "",
    url: lsGet(LS.url) || CFG.BRIDGE_ORIGINS[0],
    printers: [],
    agents: [],
    devices: [],
    caps: null,
    scanPages: [],
    scanJob: null,
    pollTimer: null,
    profile: null,
    file: null,
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
  const relay = () => window.RootsPrintRelay;
  const AGENT_STALE = 5 * 60 * 1000;

  /* ---------------------------------------------------------------- notice --- */

  function toast(message, kind = "info") {
    const el = document.createElement("div");
    el.className = "toast" + (kind === "err" ? " error" : kind === "ok" ? " success" : "");
    el.innerHTML = `<i class="ri-${kind === "err" ? "error-warning-line" : kind === "ok" ? "checkbox-circle-line" : "information-line"}"></i><span>${esc(message)}</span>`;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function note(target, kind, message, hint) {
    const el = typeof target === "string" ? $(target) : target;
    if (!el) return;
    const icon = kind === "err" ? "error-warning-line" : kind === "ok" ? "checkbox-circle-line" : "information-line";
    el.innerHTML = `<div class="note ${kind}"><i class="ri-${icon}"></i><div><strong>${esc(message)}</strong>${hint ? `<span class="sub">${hint}</span>` : ""}</div></div>`;
  }

  const clear = (sel) => {
    const el = $(sel);
    if (el) el.innerHTML = "";
  };
  const fail = (sel, e) => note(sel, "err", e.message || "Unbekannter Fehler", e.hint || null);

  /* ---------------------------------------------------------------- select --- */

  /**
   * Auswahlfeld im ROOTS-Design. Native <select> übernimmt das Aussehen des
   * Betriebssystems und passt damit nicht zum Rest der Oberfläche.
   */
  const selects = new Map();

  function makeSelect(id, { options = [], value = null, placeholder = "Bitte wählen", onChange, disabled = false } = {}) {
    const host = $("#" + id);
    if (!host) return null;
    const st = selects.get(id) || {};
    const current = value != null ? value : st.value;
    const chosen = options.find((o) => String(o.value) === String(current)) || options[0] || null;
    const entry = { id, options, value: chosen ? chosen.value : null, onChange: onChange || st.onChange, disabled };
    selects.set(id, entry);

    host.classList.add("select");
    host.innerHTML = `
      <button type="button" class="select-trigger" aria-haspopup="listbox" aria-expanded="false" ${disabled || !options.length ? "disabled" : ""}>
        <span class="sel-label">${esc(chosen ? chosen.label : placeholder)}</span>
        <i class="ri-arrow-down-s-line"></i>
      </button>
      <div class="select-menu" role="listbox">
        ${options.length
          ? options
              .map(
                (o) =>
                  `<button type="button" class="select-option" role="option" data-value="${esc(o.value)}" aria-selected="${String(o.value) === String(entry.value)}">${esc(o.label)}</button>`
              )
              .join("")
          : `<div class="select-empty">${esc(placeholder)}</div>`}
      </div>`;

    const trigger = $(".select-trigger", host);
    trigger.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const open = host.classList.contains("open");
      closeAllSelects();
      if (!open) {
        host.classList.add("open");
        trigger.setAttribute("aria-expanded", "true");
      }
    });
    $$(".select-option", host).forEach((opt) =>
      opt.addEventListener("click", () => {
        const val = opt.dataset.value;
        closeAllSelects();
        if (String(val) === String(entry.value)) return;
        entry.value = val;
        makeSelect(id, { options, value: val, placeholder, onChange: entry.onChange, disabled });
        entry.onChange?.(val);
      })
    );
    return entry;
  }

  function closeAllSelects() {
    $$(".select.open").forEach((s) => {
      s.classList.remove("open");
      $(".select-trigger", s)?.setAttribute("aria-expanded", "false");
    });
  }

  const selValue = (id) => selects.get(id)?.value ?? null;

  document.addEventListener("click", closeAllSelects);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeAllSelects();
      $("#modal").classList.add("hidden");
    }
  });

  /* ---------------------------------------------------------------- bridge --- */

  const NET_HINT = {
    offline: { message: "Der lokale Helfer antwortet nicht.", hint: "Auf dem eigenen Mac: <code>node bridge/roots-print-bridge.js</code>." },
    blocked: { message: "Dieser Browser lässt keinen Zugriff auf 127.0.0.1 zu.", hint: "Das Tool nutzt deshalb die Warteschlange." },
  };

  async function call(path, { method = "GET", body, headers = {}, raw = false, timeout = 200000 } = {}) {
    if (!state.token) throw { message: "Für den Helfer ist kein Token gesetzt.", hint: "Unter Status › Verbindung das Token aus <code>~/.roots-print/token</code> einsetzen." };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(state.url + path, { method, body, signal: ctrl.signal, headers: { Authorization: "Bearer " + state.token, ...headers } });
    } catch (err) {
      if (err.name === "AbortError") throw { message: "Der Helfer hat zu lange nicht geantwortet.", hint: "Erneut versuchen, bei Scans mit niedrigerer Auflösung." };
      throw NET_HINT[location.protocol === "https:" ? "blocked" : "offline"];
    } finally {
      clearTimeout(t);
    }
    if (raw) {
      if (!res.ok) throw (await res.json().catch(() => null))?.error || { message: `Helfer antwortete mit HTTP ${res.status}.` };
      return res;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw data.error || { message: `Helfer antwortete mit HTTP ${res.status}.` };
    return data;
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
        lsSet(LS.url, url);
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

  /* ----------------------------------------------------------------- pills --- */

  function setPill(id, kind, icon, text, title) {
    const el = $(id);
    if (!el) return;
    el.className = "pill" + (kind ? " " + kind : "");
    el.innerHTML = `<i class="ri-${icon}"></i><span class="pill-text">${esc(text)}</span>`;
    el.title = title || text;
  }

  function agentOnline(a) {
    return !!(a?.last_seen_at && Date.now() - Date.parse(a.last_seen_at) < AGENT_STALE);
  }

  function renderPills() {
    const printer = state.printers[0] || null;
    const live = state.agents.filter(agentOnline);

    if (state.active === "bridge") {
      const dev = state.devices[0] || null;
      if (printer) setPill("#pill-printer", dev ? "ok" : "warn", dev ? "printer-line" : "printer-line", printer.display_name || printer.queue, dev ? `Im Netz gemeldet: ${dev.host}` : "Warteschlange vorhanden, Gerät nicht im Netz gemeldet");
      else setPill("#pill-printer", "bad", "printer-off-line", "Kein Drucker");
      setPill("#pill-wifi", state.ssid ? "ok" : "warn", "wifi-line", state.ssid || "Netz unbekannt");
      setPill("#pill-route", "ok", "flashlight-line", "Lokaler Helfer");
      return;
    }

    if (!printer) {
      setPill("#pill-printer", "bad", "printer-off-line", "Kein Drucker gemeldet");
    } else if (printer.reachable === true) {
      setPill("#pill-printer", "ok", "printer-line", printer.display_name || printer.queue, `Im Netz gemeldet · Stand ${when(printer.checked_at)}`);
    } else {
      setPill("#pill-printer", "warn", "printer-line", printer.display_name || printer.queue, "Gerät schläft oder meldet sich nicht im Netz");
    }

    const ssid = state.agents.find((a) => a.ssid)?.ssid;
    setPill("#pill-wifi", ssid ? "ok" : "warn", "wifi-line", ssid || "Netz unbekannt", ssid ? `Netz des Agenten: ${ssid}` : "Der Agent hat kein Netz gemeldet");
    setPill("#pill-route", live.length ? "ok" : "bad", live.length ? "cloud-line" : "cloud-off-line", live.length ? "Warteschlange" : "Agent offline", live.length ? `Agent ${live[0].name}` : "Kein Agent hat sich in den letzten fünf Minuten gemeldet");
  }

  function when(iso) {
    if (!iso) return "unbekannt";
    const diff = Date.now() - Date.parse(iso);
    if (diff < 90000) return "gerade";
    if (diff < 3600000) return `vor ${Math.round(diff / 60000)} min`;
    return new Date(iso).toLocaleString("de-DE");
  }

  /* -------------------------------------------------------------- mode --- */

  async function pickMode() {
    if (TOKENLESS) {
      state.active = "relay";
      return;
    }
    if (state.mode === "relay") {
      state.active = "relay";
      return;
    }
    if (state.mode === "bridge") {
      state.active = "bridge";
      if (!(await detectBridge())) {
        if (state.bridgeIssue === "token") note("#banner", "err", "Der Helfer läuft, akzeptiert das Token aber nicht.", "Token unter Status › Verbindung einsetzen.");
        else note("#banner", "err", NET_HINT[location.protocol === "https:" ? "blocked" : "offline"].message, NET_HINT[location.protocol === "https:" ? "blocked" : "offline"].hint);
      }
      return;
    }
    state.agents = await relay().agentList();
    if (state.agents.some(agentOnline)) {
      state.active = "relay";
      clear("#banner");
      return;
    }
    if (await detectBridge()) {
      state.active = "bridge";
      note("#banner", "info", "Kein Agent im Büro gemeldet — es läuft über den lokalen Helfer.", "Aufträge gehen direkt an den Drucker in diesem Netz.");
      return;
    }
    state.active = "relay";
    note("#banner", "err", "Kein Agent im Büro und kein lokaler Helfer.", state.agents.length ? "Auf dem Büro-Rechner: <code>node bridge/roots-print-agent.js</code>. Aufträge warten bis dahin." : "Es ist kein Agent freigeschaltet — siehe Status › Agent freischalten.");
  }

  /* ------------------------------------------------------------- printers --- */

  const OPT_LABEL = { ColorModel: "Farbe", Duplex: "Beidseitig", PageSize: "Papierformat", InputSlot: "Papierquelle", MediaType: "Medium", Collate: "Sortieren", cupsPrintQuality: "Qualität", cupsFinishingTemplate: "Finishing" };
  const VAL_LABEL = { RGB: "Farbe", Gray: "Graustufen", Gray16: "Graustufen 16 bit", None: "Aus", DuplexNoTumble: "Lange Kante", DuplexTumble: "Kurze Kante", True: "Ja", False: "Nein", auto: "Automatisch", "by-pass-tray": "Mehrzweckfach", "tray-1": "Kassette 1", none: "Keins" };

  async function loadPrinters() {
    try {
      if (state.active === "bridge") {
        const data = await call("/api/printers");
        state.printers = data.printers.map((p) => ({ id: p.name, queue: p.name, display_name: p.name, state: p.state, state_text: p.stateText, is_default: p.isDefault, options: null }));
        state.agents = [];
      } else {
        state.agents = await relay().agentList();
        state.printers = await relay().printers();
      }
    } catch (e) {
      fail("#print-result", e);
      state.printers = [];
    }

    const options = state.printers.map((p) => ({ value: p.id, label: (p.display_name || p.queue) + (p.is_default ? " · Standard" : "") }));
    makeSelect("sel-printer", {
      options,
      value: (state.printers.find((p) => p.is_default) || state.printers[0])?.id,
      placeholder: "Kein Drucker gemeldet",
      onChange: () => {
        loadOptions();
        loadJobs();
      },
    });

    renderPills();
    renderDevices();

    if (!state.printers.length) {
      $("#print-options").innerHTML = "";
      note("#print-result", "err", state.active === "bridge" ? "Dieser Mac kennt keinen Drucker." : "In der Warteschlange ist kein Drucker gemeldet.", state.active === "bridge" ? "Systemeinstellungen › Drucker & Scanner." : "Der Agent im Büro muss laufen und freigeschaltet sein.");
      return;
    }
    clear("#print-result");
    await loadOptions();
    fillScanners();
  }

  const currentPrinter = () => state.printers.find((p) => String(p.id) === String(selValue("sel-printer"))) || null;

  async function loadOptions() {
    const printer = currentPrinter();
    const wrap = $("#print-options");
    if (!printer) return;
    let options = printer.options;
    if (state.active === "bridge") {
      wrap.innerHTML = `<div style="color:var(--muted);font-size:.85rem"><i class="ri-loader-4-line spin"></i> Optionen werden gelesen</div>`;
      try {
        options = (await call("/api/printer/options?queue=" + encodeURIComponent(printer.queue))).options;
        printer.options = options;
      } catch (e) {
        wrap.innerHTML = "";
        return fail("#print-result", e);
      }
    }
    const usable = (options || []).filter((o) => (o.values || []).length > 1);
    wrap.innerHTML = usable.map((o) => `<div><label class="field-label">${esc(OPT_LABEL[o.key] || o.label)}</label><div class="select" id="opt-${esc(o.key)}"></div></div>`).join("");
    usable.forEach((o) =>
      makeSelect("opt-" + o.key, {
        options: [...new Set(o.values)].map((v) => ({ value: v, label: VAL_LABEL[v] || v })),
        value: o.current || o.values[0],
      })
    );
  }

  function chosenOptions() {
    const out = {};
    for (const [id, entry] of selects) {
      if (id.startsWith("opt-")) out[id.slice(4)] = entry.value;
    }
    return out;
  }

  async function doPrint(file, filename) {
    const printer = currentPrinter();
    if (!printer) return note("#print-result", "err", "Kein Drucker gewählt.");
    const copies = $("#print-copies").value || "1";
    const btn = $("#print-go");
    btn.disabled = true;
    note("#print-result", "info", "Auftrag wird übergeben…");
    try {
      if (state.active === "bridge") {
        const qs = new URLSearchParams({ queue: printer.queue, copies, options: JSON.stringify(chosenOptions()) });
        const res = await call("/api/print?" + qs, { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream", "X-Roots-Filename": filename.replace(/[^\x20-\x7e]/g, "_") } });
        note("#print-result", "ok", `An ${printer.queue} übergeben.`, res.jobId ? `Auftrag <code>${esc(res.jobId)}</code>` : null);
      } else {
        const jobId = await relay().submitPrint(printer.id, file, filename, { copies: Number(copies), options: chosenOptions() });
        note("#print-result", "info", "In der Warteschlange. Der Agent übernimmt.");
        const done = await relay().waitFor(jobId, null, { timeoutMs: 180000 });
        if (done.status === "error") throw done.error || { message: "Der Auftrag ist fehlgeschlagen." };
        note("#print-result", "ok", `An ${printer.display_name || printer.queue} gedruckt.`, done.result?.jobId ? `Auftrag <code>${esc(done.result.jobId)}</code>` : null);
      }
      toast("Druckauftrag übergeben", "ok");
      loadJobs();
    } catch (e) {
      fail("#print-result", e);
      toast(e.message || "Druck fehlgeschlagen", "err");
    } finally {
      btn.disabled = false;
    }
  }

  /* --------------------------------------------------------------- devices --- */

  function renderDevices() {
    const body = $("#dev-table tbody");
    if (!body) return;
    if (state.active === "bridge") {
      const rows = state.devices.length
        ? state.devices.map((d) => {
            const can = [d.canScan ? "Scan" : null, d.canColor ? "Farbe" : null, d.canDuplex ? "Duplex" : null].filter(Boolean).join(" · ") || "—";
            return `<tr><td><strong>${esc(d.model || d.instance)}</strong></td><td>${esc(d.host || "—")}</td><td>${esc(can)}</td><td>Lokaler Helfer</td></tr>`;
          })
        : [];
      body.innerHTML = rows.length ? rows.join("") : `<tr><td colspan="4" class="empty">Kein Gerät im Netz gemeldet.</td></tr>`;
      return;
    }
    const rows = state.printers.map((p) => {
      const agent = state.agents.find((a) => a.id === p.agent_id);
      const can = [p.can_scan ? "Scan" : null, p.reachable === true ? "im Netz" : null].filter(Boolean).join(" · ") || "—";
      return `<tr><td><strong>${esc(p.display_name || p.queue)}</strong></td><td>${esc(p.scan_host || "—")}</td><td>${esc(can)}</td><td>${esc(agent?.name || "—")}${agent && !agentOnline(agent) ? " (offline)" : ""}</td></tr>`;
    });
    body.innerHTML = rows.length ? rows.join("") : `<tr><td colspan="4" class="empty">Kein Gerät gemeldet.</td></tr>`;
  }

  /* --------------------------------------------------------------- scanner --- */

  const COLOR = { RGB24: "Farbe", Grayscale8: "Graustufen", BlackAndWhite1: "Schwarzweiß" };
  const INTENT = { Document: "Dokument", Photo: "Foto", TextAndGraphic: "Text und Grafik", Preview: "Vorschau" };
  const FORMAT = { "application/pdf": "PDF", "image/jpeg": "JPEG", "image/png": "PNG" };
  const PAPER = { full: { label: "Ganze Fläche" }, a4: { label: "A4", w: 2480, h: 3508 }, a5: { label: "A5", w: 1748, h: 2480 }, letter: { label: "Letter", w: 2550, h: 3300 } };

  function scanners() {
    if (state.active === "relay") {
      return state.printers.filter((p) => p.can_scan && p.scan_host).map((p) => ({ id: p.id, label: p.display_name || p.queue, host: p.scan_host, caps: p.scan_caps, reachable: p.reachable }));
    }
    return state.devices.filter((d) => d.canScan && d.host).map((d) => ({ id: d.host, label: d.model || d.instance, host: d.host, caps: null, reachable: true }));
  }

  function fillScanners() {
    const list = scanners();
    makeSelect("sel-scanner", {
      options: list.map((s) => ({ value: s.id, label: s.label })),
      placeholder: "Kein Scanner gemeldet",
      onChange: loadCaps,
    });
    makeSelect("sel-duplex", { options: [{ value: "0", label: "Nein" }, { value: "1", label: "Ja" }], value: "0", disabled: true, onChange: renderScanOptions });
    if (!list.length) {
      note("#scan-result", "err", "Kein Gerät mit Scan-Funktion gemeldet.", state.active === "bridge" ? "Unter Status das Netz prüfen." : "Der Agent meldet die Scan-Fähigkeiten beim Start.");
      setPill("#scan-state", "bad", "scan-line", "Kein Scanner");
      return;
    }
    clear("#scan-result");
    loadCaps();
  }

  const currentScanner = () => scanners().find((s) => String(s.id) === String(selValue("sel-scanner"))) || null;

  function sourceCaps() {
    if (!state.caps) return null;
    const src = selValue("sel-source");
    if (src === "feeder") return (selValue("sel-duplex") === "1" && state.caps.sources.feederDuplex) || state.caps.sources.feeder;
    return state.caps.sources.platen;
  }

  async function loadCaps() {
    const s = currentScanner();
    if (!s) return;
    setPill("#scan-state", s.reachable === true ? "ok" : "warn", "scan-line", s.label, s.reachable === true ? "Im Netz gemeldet" : "Gerät schläft oder meldet sich nicht");
    try {
      state.caps = s.caps || (state.active === "bridge" ? await call("/api/scanner/capabilities?host=" + encodeURIComponent(s.host), { timeout: 30000 }) : null);
    } catch (e) {
      return fail("#scan-result", e);
    }
    if (!state.caps) {
      note("#scan-result", "err", "Für dieses Gerät sind keine Scan-Fähigkeiten gemeldet.", "Der Agent liest sie beim Start. Agent neu starten, dann neu laden.");
      return;
    }
    const src = state.caps.sources;
    makeSelect("sel-source", {
      options: [src.platen ? { value: "platen", label: "Flachbett" } : null, src.feeder ? { value: "feeder", label: "Einzug" } : null].filter(Boolean),
      onChange: () => {
        renderScanOptions();
      },
    });
    makeSelect("sel-duplex", { options: [{ value: "0", label: "Nein" }, { value: "1", label: "Ja" }], value: "0", disabled: !state.caps.supportsDuplex, onChange: renderScanOptions });
    renderScanOptions();
  }

  function renderScanOptions() {
    const caps = sourceCaps();
    if (!caps) return;
    const fill = (id, values, labels, fallback, suffix) =>
      makeSelect(id, {
        options: (values && values.length ? values : fallback).map((v) => ({ value: v, label: (labels && labels[v]) || v + (suffix || "") })),
        value: selValue(id),
      });
    fill("sel-color", caps.colorModes, COLOR, ["RGB24"]);
    fill("sel-res", (caps.resolutions || []).map(String), null, ["300"], " dpi");
    fill("sel-format", (caps.formats || []).filter((f) => f !== "application/octet-stream"), FORMAT, ["application/pdf"]);
    fill("sel-intent", caps.intents, INTENT, ["Document"]);
    makeSelect("sel-size", { options: Object.entries(PAPER).map(([k, v]) => ({ value: k, label: v.label })), value: selValue("sel-size") || "full" });
  }

  function scanSettings(scanner) {
    const size = PAPER[selValue("sel-size") || "full"];
    const s = {
      host: scanner.host,
      source: selValue("sel-source") || "platen",
      colorMode: selValue("sel-color") || "RGB24",
      resolution: Number(selValue("sel-res") || 300),
      format: selValue("sel-format") || "application/pdf",
      intent: selValue("sel-intent") || "Document",
      duplex: selValue("sel-duplex") === "1",
    };
    // eSCL zählt Scanbereiche in 1/300 Zoll, unabhängig von der Auflösung.
    if (size?.w) {
      s.width = size.w;
      s.height = size.h;
    }
    return s;
  }

  async function startScan() {
    const scanner = currentScanner();
    if (!scanner) return note("#scan-result", "err", "Kein Scanner gewählt.");
    const btn = $("#scan-go");
    btn.disabled = true;
    $("#scan-pages").innerHTML = "";
    $("#scan-actions").classList.add("hidden");
    state.scanPages = [];
    note("#scan-result", "info", "Scan läuft…", "Seiten erscheinen, sobald sie übertragen sind.");
    const settings = scanSettings(scanner);
    try {
      if (state.active === "bridge") {
        state.scanJob = await call("/api/scan", { method: "POST", body: JSON.stringify(settings), headers: { "Content-Type": "application/json" }, timeout: 60000 });
        pollScan();
        return;
      }
      const jobId = await relay().submitScan(scanner.id, settings);
      const done = await relay().waitFor(jobId, (st) => showRelayPages(st), { timeoutMs: 420000 });
      btn.disabled = false;
      if (done.status === "error") throw done.error || { message: "Der Scan ist fehlgeschlagen." };
      showRelayPages(done);
      const secs = Math.max(1, Math.round((Date.parse(done.finished_at) - Date.parse(done.created_at)) / 1000));
      note("#scan-result", "ok", `${done.pages.length} ${done.pages.length === 1 ? "Seite" : "Seiten"} gescannt.`, `${secs} s · ${settings.resolution} dpi · ${COLOR[settings.colorMode] || settings.colorMode}`);
      $("#scan-actions").classList.toggle("hidden", !done.pages.length);
      toast(`${done.pages.length} ${done.pages.length === 1 ? "Seite" : "Seiten"} gescannt`, "ok");
    } catch (e) {
      btn.disabled = false;
      fail("#scan-result", e);
      toast(e.message || "Scan fehlgeschlagen", "err");
    }
  }

  async function pollScan() {
    if (!state.scanJob) return;
    clearTimeout(state.pollTimer);
    try {
      const job = await call("/api/scan/" + encodeURIComponent(state.scanJob.id), { timeout: 30000 });
      showBridgePages(job);
      if (job.state === "running") {
        state.pollTimer = setTimeout(pollScan, 1500);
        return;
      }
      $("#scan-go").disabled = false;
      if (job.state === "error") {
        fail("#scan-result", job.error || { message: "Der Scan brach ab." });
        return;
      }
      note("#scan-result", "ok", `${job.pages.length} ${job.pages.length === 1 ? "Seite" : "Seiten"} gescannt.`, `${Math.round(job.elapsedMs / 1000)} s · ${job.settings.resolution} dpi · ${COLOR[job.settings.colorMode] || job.settings.colorMode}`);
      $("#scan-actions").classList.toggle("hidden", !job.pages.length);
      toast(`${job.pages.length} ${job.pages.length === 1 ? "Seite" : "Seiten"} gescannt`, "ok");
    } catch (e) {
      $("#scan-go").disabled = false;
      fail("#scan-result", e);
    }
  }

  /* ----------------------------------------------------------------- pages --- */

  const extOf = (mime) => (mime.includes("pdf") ? "pdf" : mime.includes("png") ? "png" : "jpg");

  function showBridgePages(job) {
    state.scanPages = job.pages.map((p, i) => ({ idx: i, mime: p.mime, bytes: p.bytes, url: state.url + p.url + "?token=" + encodeURIComponent(state.token) }));
    paintPages();
  }

  function showRelayPages(job) {
    state.scanPages = job.pages.map((p) => ({ idx: p.idx, mime: p.mime, bytes: p.bytes, page: p }));
    paintPages();
  }

  function paintPages() {
    const wrap = $("#scan-pages");
    wrap.innerHTML = state.scanPages
      .map((p, i) => {
        const thumb = p.url && p.mime.startsWith("image/") ? `<img src="${esc(p.url)}" alt="Seite ${i + 1}">` : `<i class="ri-${p.mime.includes("pdf") ? "file-pdf-line" : "image-line"}"></i>`;
        return `<div class="page">
          <div class="page-thumb" data-idx="${i}" role="button" tabindex="0">${thumb}</div>
          <div class="page-meta"><span>Seite ${i + 1} · ${kb(p.bytes)}</span><button class="btn-ghost" data-dl="${i}" title="Herunterladen"><i class="ri-download-2-line"></i></button></div>
        </div>`;
      })
      .join("");
    $$("#scan-pages .page-thumb").forEach((el) => {
      el.addEventListener("click", () => openPreview(Number(el.dataset.idx)));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") openPreview(Number(el.dataset.idx));
      });
    });
    $$("#scan-pages [data-dl]").forEach((el) => el.addEventListener("click", () => savePage(Number(el.dataset.dl))));
  }

  async function pageBlob(p) {
    if (p.blob) return p.blob;
    if (p.url) {
      const res = await call(p.url.replace(state.url, "").split("?")[0], { raw: true });
      p.blob = await res.blob();
    } else {
      p.blob = await relay().pageBlob(p.page);
    }
    return p.blob;
  }

  async function savePage(i) {
    const p = state.scanPages[i];
    if (!p) return;
    const name = `scan-${String(i + 1).padStart(2, "0")}.${extOf(p.mime)}`;
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
      toast(e.message || "Download fehlgeschlagen", "err");
    }
  }

  async function openPreview(i) {
    const p = state.scanPages[i];
    if (!p) return;
    $("#modal-title").textContent = `Seite ${i + 1}`;
    $("#modal-body").innerHTML = `<i class="ri-loader-4-line spin" style="font-size:1.8rem;color:var(--status-border)"></i>`;
    $("#modal").classList.remove("hidden");
    $("#modal-dl").onclick = () => savePage(i);
    $("#modal-print").onclick = () => printPage(i);
    try {
      const blob = await pageBlob(p);
      p.blobUrl = p.blobUrl || URL.createObjectURL(blob);
      $("#modal-body").innerHTML = p.mime.startsWith("image/") ? `<img src="${esc(p.blobUrl)}" alt="Seite ${i + 1}">` : `<iframe src="${esc(p.blobUrl)}" title="Seite ${i + 1}"></iframe>`;
    } catch (e) {
      $("#modal").classList.add("hidden");
      toast(e.message || "Vorschau fehlgeschlagen", "err");
    }
  }

  async function printPage(i) {
    const p = state.scanPages[i];
    if (!p) return;
    try {
      await doPrint(await pageBlob(p), "scan." + extOf(p.mime));
      switchView("print");
      $("#modal").classList.add("hidden");
    } catch (e) {
      toast(e.message || "Druck fehlgeschlagen", "err");
    }
  }

  /* ------------------------------------------------------------------ jobs --- */

  async function loadJobs() {
    const body = $("#jobs-table tbody");
    if (!body) return;
    try {
      if (state.active === "bridge") {
        const { jobs } = await call("/api/printer/jobs?queue=" + encodeURIComponent(currentPrinter()?.queue || ""));
        body.innerHTML = jobs.length ? jobs.map((j) => `<tr><td>${esc(j.id)}</td><td>${esc(j.user || "—")}</td><td>${j.size ? kb(j.size) : "—"}</td><td>im Drucker</td></tr>`).join("") : `<tr><td colspan="4" class="empty">Keine offenen Aufträge.</td></tr>`;
        return;
      }
      const jobs = await relay().jobs();
      const label = { queued: "wartet", claimed: "übernommen", running: "läuft", done: "fertig", error: "Fehler" };
      const kind = { queued: "warn", claimed: "warn", running: "busy", done: "ok", error: "bad" };
      body.innerHTML = jobs.length
        ? jobs
            .map(
              (j) => `<tr>
        <td><strong>${j.kind === "scan" ? "Scan" : "Druck"}</strong></td>
        <td>${esc(j.requested_email || "—")}</td>
        <td>${esc(j.filename || (j.settings?.resolution ? j.settings.resolution + " dpi" : "—"))}</td>
        <td><span class="pill ${kind[j.status] || ""}" style="height:28px"><i class="ri-${j.status === "done" ? "checkbox-circle-line" : j.status === "error" ? "error-warning-line" : "time-line"}"></i><span class="pill-text">${esc(label[j.status] || j.status)} · ${esc(when(j.created_at))}</span></span>${j.error?.message ? `<div style="color:var(--danger);font-size:.78rem;margin-top:.25rem">${esc(j.error.message)}</div>` : ""}</td></tr>`
            )
            .join("")
        : `<tr><td colspan="4" class="empty">Keine Aufträge in den letzten drei Tagen.</td></tr>`;
    } catch (e) {
      body.innerHTML = `<tr><td colspan="4" class="empty">${esc(e.message || "Aufträge konnten nicht geladen werden.")}</td></tr>`;
    }
  }

  /* ---------------------------------------------------------------- status --- */

  function renderChecks(list) {
    $("#checks").innerHTML = list
      .map(
        (c) => `<div class="check">
      <div class="check-ico ${c.ok === true ? "ok" : c.ok === false ? "bad" : "unknown"}"><i class="ri-${c.ok === true ? "checkbox-circle-line" : c.ok === false ? "close-circle-line" : "question-line"}"></i></div>
      <div class="check-body"><strong>${esc(c.label)}</strong>
        <div class="check-detail">${esc(c.detail)}</div>
        ${c.hint ? `<div class="check-fix"><i class="ri-tools-line"></i><span>${esc(c.hint)}</span></div>` : ""}
      </div></div>`
      )
      .join("");
  }

  async function loadStatus() {
    if (state.active === "relay") {
      state.agents = await relay().agentList();
      state.printers = await relay().printers();
      renderPills();
      renderDevices();
      const live = state.agents.filter(agentOnline);
      const printer = state.printers[0];
      const ssid = state.agents.find((a) => a.ssid)?.ssid;
      renderChecks([
        { ok: true, label: "Warteschlange", detail: "Supabase erreichbar" },
        { ok: state.agents.length > 0, label: "Agent freigeschaltet", detail: `${state.agents.length} eingetragen`, hint: state.agents.length ? null : "Agent starten und den angezeigten Hash unten eintragen." },
        { ok: live.length > 0, label: "Agent läuft", detail: live.length ? live.map((a) => `${a.name} · ${when(a.last_seen_at)}`).join(", ") : "keine Meldung in den letzten fünf Minuten", hint: live.length ? null : "Auf dem Büro-Rechner: node bridge/roots-print-agent.js" },
        { ok: ssid === "FRITZ!Box 4040 JI" ? true : ssid ? false : null, label: "Netz des Agenten", detail: ssid || "nicht gemeldet", hint: ssid && ssid !== "FRITZ!Box 4040 JI" ? "Der Agent hängt in einem anderen Netz als der Drucker." : null },
        { ok: printer ? printer.reachable === true : false, label: "Drucker im Netz", detail: printer ? `${printer.display_name || printer.queue}${printer.reachable === true ? " · gemeldet " + when(printer.checked_at) : " · keine Meldung"}` : "kein Drucker gemeldet", hint: printer && printer.reachable !== true ? "Das Gerät schläft. Es wacht beim ersten Auftrag von selbst auf." : null },
        { ok: printer ? !!printer.can_scan : false, label: "Scan-Funktion", detail: printer?.can_scan ? printer.scan_host : "nicht gemeldet", hint: printer?.can_scan ? null : "Der Agent liest die Fähigkeiten beim Start, solange das Gerät wach ist." },
      ]);
      return;
    }
    try {
      const d = await call("/api/diagnose?passive=1", { timeout: 60000 });
      state.ssid = d.ssid;
      state.devices = (await call("/api/discover", { timeout: 40000 })).devices;
      renderPills();
      renderDevices();
      renderChecks(d.checks.map((c) => ({ ok: c.ok, label: c.label, detail: c.detail, hint: c.hint })));
    } catch (e) {
      fail("#checks", e);
    }
  }

  async function deepCheck() {
    const btn = $("#deep-check");
    btn.disabled = true;
    note("#deep-result", "info", "Gerät wird angesprochen…");
    try {
      if (state.active === "bridge") {
        const host = currentScanner()?.host || state.devices[0]?.host || "";
        const d = await call("/api/diagnose?host=" + encodeURIComponent(host), { timeout: 60000 });
        renderChecks(d.checks);
        note("#deep-result", "ok", "Prüfung abgeschlossen.");
      } else {
        const scanner = currentScanner();
        if (!scanner) throw { message: "Kein Scanner gemeldet." };
        const jobId = await relay().submitScan(scanner.id, { host: scanner.host, source: "platen", colorMode: "Grayscale8", resolution: 300, format: "image/jpeg", intent: "Preview", width: 300, height: 300 });
        const done = await relay().waitFor(jobId, null, { timeoutMs: 180000 });
        if (done.status === "error") throw done.error || { message: "Das Gerät hat nicht geantwortet." };
        note("#deep-result", "ok", "Das Gerät hat geantwortet.", "Drucker und Scanner sind über den Agenten erreichbar.");
        loadStatus();
      }
    } catch (e) {
      fail("#deep-result", e);
    } finally {
      btn.disabled = false;
    }
  }

  /* ----------------------------------------------------------------- auth --- */

  let sb = null;
  const IN_IFRAME = window.parent !== window;
  const EMBEDDED = IN_IFRAME || new URLSearchParams(location.search).has("authBroker");
  const TOKENLESS = window.RootsUserBridge?.TOKENLESS_EMBED === true || window.ROOTS_TOKENLESS_EMBED === true;

  const domainAllowed = (email) => CFG.ALLOWED_EMAIL_DOMAINS.includes(String(email || "").split("@")[1]?.toLowerCase());

  async function bootAuth() {
    if (TOKENLESS) {
      $("#login-form").classList.add("hidden");
      note("#gate-msg", "info", "Anmeldung wird vom Intranet übernommen…");
      relay().useBroker();
      window.addEventListener("roots-broker-context-ready", (e) => applyBrokerContext(e.detail));
      window.addEventListener("roots-auth-signed-out", () => {
        booted = false;
        note("#gate-msg", "err", "Die Sitzung des Intranets ist beendet.", "Im Intranet neu anmelden.");
        showGate(true);
      });
      void requestBrokerContext();
      return;
    }

    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    window.__rootsSupabaseClient = sb;
    relay().use(sb);
    if (EMBEDDED) {
      $("#login-form").classList.add("hidden");
      note("#gate-msg", "info", "Anmeldung wird vom Intranet übernommen…");
      window.addEventListener("roots-auth-ready", (e) => applySession(e.detail?.session || null));
      setTimeout(() => window.RootsUserBridge?.syncAuthFromParentStorage?.(), 300);
    }
    const { data } = await sb.auth.getSession();
    applySession(data.session);
    sb.auth.onAuthStateChange((_e, session) => applySession(session));
  }

  /** Wie im Notes-Tool: den Kontext selbst anfragen statt auf ein Ereignis zu warten. */
  async function requestBrokerContext(attempt = 0) {
    if (!$("#app").classList.contains("hidden")) return;
    const request = window.RootsUserBridge?.request;
    if (request) {
      try {
        const context = await request("user-context", {}, 20000);
        if (context?.user?.id) return applyBrokerContext(context);
      } catch (e) {
        /* Intranet ist noch nicht bereit */
      }
    }
    if (attempt >= 6) {
      note("#gate-msg", "err", "Das Intranet hat keine Anmeldung übergeben.", request ? "Im Intranet neu laden und die Kachel erneut öffnen." : "<code>roots-user-bridge.js</code> ist nicht geladen.");
      return;
    }
    setTimeout(() => void requestBrokerContext(attempt + 1), 1500);
  }

  function applyBrokerContext(context) {
    const email = context?.user?.email || context?.profile?.email || "";
    if (!context?.user?.id) return;
    if (!domainAllowed(email)) {
      note("#gate-msg", "err", "Dieses Konto gehört nicht zu ROOTS.");
      return showGate(true);
    }
    state.profile = context.profile || null;
    if (window.RootsUser) {
      window.RootsUser._uid = context.user.id;
      window.RootsUser._p = context.profile || { id: context.user.id, email, app_role: "reader" };
    }
    unlock(email, context.profile?.app_role === "admin");
  }

  function applySession(session) {
    const email = session?.user?.email || "";
    if (!session) return showGate(EMBEDDED);
    if (!domainAllowed(email)) {
      note("#gate-msg", "err", "Dieses Konto gehört nicht zu ROOTS.");
      if (!EMBEDDED) sb.auth.signOut();
      return showGate(true);
    }
    if (window.RootsUser?._loadAndMount) {
      try {
        window.RootsUser._loadAndMount(sb);
      } catch (e) {
        /* die Brücke hängt sich selbst ein */
      }
    }
    unlock(email, false);
    void loadProfile();
  }

  async function loadProfile() {
    try {
      const uid = (await sb.auth.getUser()).data.user?.id;
      if (!uid) return;
      const { data } = await sb.from("profiles").select("id, app_role").eq("id", uid).maybeSingle();
      state.profile = data || null;
      $("#agent-admin").classList.toggle("hidden", data?.app_role !== "admin");
    } catch (e) {
      /* ohne Profil bleibt der Bereich verborgen */
    }
  }

  function unlock(email, isAdmin) {
    clear("#gate-msg");
    $("#gate").classList.add("hidden");
    $("#app").classList.remove("hidden");
    setPill("#pill-user", "", "user-line", email);
    $("#agent-admin").classList.toggle("hidden", !isAdmin);
    bootApp();
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
    makeSelect("sel-mode", {
      options: [
        { value: "auto", label: "Automatisch" },
        { value: "relay", label: "Nur Warteschlange" },
        { value: "bridge", label: "Nur lokaler Helfer" },
      ],
      value: TOKENLESS ? "relay" : state.mode,
      disabled: TOKENLESS,
      onChange: async (v) => {
        state.mode = v;
        lsSet(LS.mode, v);
        await reboot();
        toast(state.active === "bridge" ? "Läuft über den lokalen Helfer" : "Läuft über die Warteschlange", "ok");
      },
    });
    if (TOKENLESS) $("#conn-local").classList.add("hidden");

    await pickMode();
    if (state.active === "bridge") {
      state.devices = await call("/api/discover", { timeout: 40000 }).then((d) => d.devices).catch(() => []);
      state.ssid = await call("/api/diagnose?passive=1", { timeout: 30000 }).then((d) => d.ssid).catch(() => null);
    }
    await loadPrinters();
    loadJobs();
    loadStatus();
  }

  async function reboot() {
    booted = false;
    clear("#banner");
    await bootApp();
  }

  function switchView(view) {
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $$("section[data-panel]").forEach((s) => s.classList.toggle("hidden", s.dataset.panel !== view));
    if (view === "jobs") loadJobs();
    if (view === "status") loadStatus();
    if (view === "scan" && !state.caps) fillScanners();
  }

  function pickFile(file) {
    if (!file) return;
    state.file = file;
    $("#filedrop-name").textContent = file.name;
    $("#filedrop-meta").textContent = kb(file.size);
  }

  function wire() {
    $("#login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("#gate-email").value.trim();
      if (!domainAllowed(email)) return note("#gate-msg", "err", "Diese Adresse ist nicht freigegeben.");
      note("#gate-msg", "info", "Anmeldung läuft…");
      const { error } = await sb.auth.signInWithPassword({ email, password: $("#gate-pw").value });
      if (error) note("#gate-msg", "err", "Anmeldung fehlgeschlagen.", "E-Mail und Passwort sind dieselben wie im ROOTS Intranet.");
      else clear("#gate-msg");
    });

    $("#logout").addEventListener("click", () => (sb ? sb.auth.signOut().then(() => location.reload()) : location.reload()));
    $$(".nav-item").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

    const drop = $("#filedrop");
    drop.addEventListener("click", () => $("#print-file").click());
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      pickFile(e.dataTransfer.files[0]);
    });
    $("#print-file").addEventListener("change", (e) => pickFile(e.target.files[0]));

    $("#print-reload").addEventListener("click", () => loadPrinters());
    $("#print-go").addEventListener("click", () => {
      if (!state.file) return note("#print-result", "err", "Es ist keine Datei gewählt.");
      doPrint(state.file, state.file.name);
    });

    $("#scan-go").addEventListener("click", startScan);
    $("#scan-status").addEventListener("click", () => (state.active === "bridge" ? refreshBridgeScannerStatus() : loadStatus()));
    $("#scan-print").addEventListener("click", () => printPage(0));
    $("#scan-dl-all").addEventListener("click", async () => {
      for (let i = 0; i < state.scanPages.length; i++) await savePage(i);
    });

    $("#jobs-refresh").addEventListener("click", loadJobs);
    $("#status-refresh").addEventListener("click", loadStatus);
    $("#deep-check").addEventListener("click", deepCheck);

    $("#conn-save").addEventListener("click", async () => {
      state.url = $("#conn-url").value.trim().replace(/\/$/, "");
      state.token = $("#conn-token").value.trim();
      lsSet(LS.url, state.url);
      lsSet(LS.token, state.token);
      if (await detectBridge(true)) {
        note("#conn-out", "ok", `Verbunden mit ${state.url}.`);
        state.mode = "auto";
        lsSet(LS.mode, "auto");
        await reboot();
      } else if (state.bridgeIssue === "token") {
        note("#conn-out", "err", "Der Helfer läuft, akzeptiert dieses Token aber nicht.", "Aktuelles Token: <code>cat ~/.roots-print/token</code>");
      } else {
        note("#conn-out", "err", `Unter ${esc(state.url)} antwortet kein Helfer.`, NET_HINT[location.protocol === "https:" ? "blocked" : "offline"].hint);
      }
    });
    $("#conn-forget").addEventListener("click", () => {
      lsDel(LS.token);
      state.token = "";
      $("#conn-token").value = "";
      toast("Token gelöscht");
    });

    $("#agent-add").addEventListener("click", async () => {
      const hash = $("#agent-hash").value.trim();
      if (!/^[0-9a-f]{64}$/i.test(hash)) return note("#agent-out", "err", "Der Hash muss 64 Hex-Zeichen haben.", "Auf dem Büro-Rechner: <code>node bridge/roots-print-agent.js --hash</code>");
      try {
        await relay().registerAgent($("#agent-name").value.trim(), hash);
        note("#agent-out", "ok", "Agent freigeschaltet.", "Er meldet sich innerhalb einer Minute mit seinen Druckern.");
        $("#agent-hash").value = "";
        toast("Agent freigeschaltet", "ok");
        loadStatus();
      } catch (e) {
        fail("#agent-out", e);
      }
    });

    $("#modal-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
    $("#modal").addEventListener("click", (e) => {
      if (e.target.id === "modal") $("#modal").classList.add("hidden");
    });
  }

  async function refreshBridgeScannerStatus() {
    const s = currentScanner();
    if (!s) return;
    setPill("#scan-state", "busy", "loader-4-line spin", "Status wird geholt");
    try {
      const st = await call("/api/scanner/status?host=" + encodeURIComponent(s.host), { timeout: 15000 });
      setPill("#scan-state", st.state === "Idle" ? "ok" : "warn", "scan-line", `${st.state}${st.adfState ? " · Einzug " + (st.adfLoaded ? "belegt" : "leer") : ""}`);
    } catch (e) {
      setPill("#scan-state", "bad", "scan-line", "kein Status");
      fail("#scan-result", e);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    wire();
    bootAuth().catch(() => note("#gate-msg", "err", "Supabase ist nicht erreichbar.", "Netzverbindung prüfen und Seite neu laden."));
  });
})();
