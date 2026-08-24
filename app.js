/**
 * ROOTS Drucken – frontend.
 *
 * All device access goes through the local bridge (bridge/roots-print-bridge.js).
 * A page served over HTTPS cannot reach a printer on http://*.local directly, so
 * every printer/scanner call here is a call to 127.0.0.1 instead.
 */
(function () {
  "use strict";

  const CFG = window.ROOTS_PRINT_CONFIG;
  const LS_TOKEN = "roots-print-token";
  const LS_URL = "roots-print-url";

  const state = {
    bridge: null,
    token: localStorage.getItem(LS_TOKEN) || "",
    url: localStorage.getItem(LS_URL) || CFG.BRIDGE_ORIGINS[0],
    printers: [],
    devices: [],
    caps: null,
    scan: null,
    pollTimer: null,
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const bytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

  /* ------------------------------------------------------------- messages --- */

  /** Bridge errors arrive as {code,message,hint}; network failures do not. */
  const NETWORK_HINTS = {
    offline: {
      message: "Der Helfer auf diesem Mac antwortet nicht.",
      hint: "Terminal öffnen und <code>node bridge/roots-print-bridge.js</code> starten. Läuft er schon, unter „Verbindung“ Adresse und Token prüfen.",
    },
    blocked: {
      message: "Der Browser blockiert den Zugriff auf 127.0.0.1.",
      hint: "Safari erlaubt das von einer HTTPS-Seite nicht. Tool direkt über <code>http://127.0.0.1:7331</code> öffnen — der Helfer liefert dieselbe Oberfläche aus.",
    },
  };

  function msg(target, kind, message, hint) {
    const el = typeof target === "string" ? $(target) : target;
    if (!el) return;
    const icon = kind === "err" ? "fa-triangle-exclamation" : kind === "ok" ? "fa-circle-check" : "fa-circle-info";
    el.innerHTML = `<div class="msg ${kind}"><i class="fa-solid ${icon}"></i><div><strong>${esc(message)}</strong>${hint ? `<span class="hint">${hint}</span>` : ""}</div></div>`;
  }

  function clear(sel) {
    const el = $(sel);
    if (el) el.innerHTML = "";
  }

  function showError(sel, e) {
    msg(sel, "err", e.message || "Unbekannter Fehler", e.hint || null);
  }

  /* --------------------------------------------------------------- bridge --- */

  async function call(path, { method = "GET", body, headers = {}, raw = false, timeout = 200000 } = {}) {
    if (!state.token) throw { code: "no_token", message: "Es ist kein Token gesetzt.", hint: "Unter „Verbindung“ das Token aus <code>~/.roots-print/token</code> einsetzen." };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(state.url + path, {
        method,
        body,
        signal: ctrl.signal,
        headers: { Authorization: "Bearer " + state.token, ...headers },
      });
    } catch (err) {
      const kind = err.name === "AbortError" ? null : window.isSecureContext && location.protocol === "https:" ? "blocked" : "offline";
      if (err.name === "AbortError") throw { code: "timeout", message: "Der Helfer hat zu lange nicht geantwortet.", hint: "Gerät wach? Scan mit weniger Seiten oder niedrigerer Auflösung erneut versuchen." };
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

  /** `onlyGiven` keeps a manual entry under „Verbindung" from silently falling back. */
  async function detectBridge(onlyGiven) {
    const pill = $("#bridge-pill");
    state.bridgeIssue = null;
    const candidates = onlyGiven ? [state.url] : [state.url, ...CFG.BRIDGE_ORIGINS.filter((u) => u !== state.url)];
    for (const url of candidates) {
      try {
        const res = await fetch(url + "/api/health", { headers: state.token ? { Authorization: "Bearer " + state.token } : {} });
        if (!res.ok) continue;
        const info = await res.json();
        state.url = url;
        state.bridge = info;
        localStorage.setItem(LS_URL, url);
        if (!info.tokenValid) {
          state.bridgeIssue = "token";
          pill.className = "pill warn";
          pill.innerHTML = '<i class="fa-solid fa-key"></i> Token fehlt';
          msg("#banner", "err", "Der Helfer läuft, akzeptiert das Token aber nicht.", 'Token aus <code>~/.roots-print/token</code> unter „Verbindung“ einsetzen.');
          return false;
        }
        pill.className = "pill ok";
        pill.innerHTML = `<i class="fa-solid fa-circle-check"></i> Helfer ${esc(info.version)}`;
        clear("#banner");
        return true;
      } catch (e) {
        /* try next candidate */
      }
    }
    state.bridge = null;
    state.bridgeIssue = "offline";
    pill.className = "pill err";
    pill.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> Helfer offline';
    const kind = location.protocol === "https:" ? "blocked" : "offline";
    msg("#banner", "err", NETWORK_HINTS[kind].message, NETWORK_HINTS[kind].hint);
    if (kind === "blocked") {
      // Das Intranet lehnt roots-open-url für 127.0.0.1 ab, deshalb keine
      // Schaltfläche, sondern die Adresse zum Kopieren.
      $("#banner").insertAdjacentHTML(
        "beforeend",
        `<div class="row"><code class="mono">${esc(state.url)}/</code><button class="btn ghost sm" id="copy-local"><i class="fa-solid fa-copy"></i> Adresse kopieren</button></div>`
      );
      $("#copy-local").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(state.url + "/");
          $("#copy-local").innerHTML = '<i class="fa-solid fa-check"></i> Kopiert';
        } catch (e) {
          $("#copy-local").innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Adresse manuell eingeben';
        }
      });
    }
    return false;
  }

  /* -------------------------------------------------------------- printers --- */

  async function loadPrinters() {
    try {
      const data = await call("/api/printers");
      state.printers = data.printers;
      const sel = $("#print-queue");
      sel.innerHTML = data.printers.map((p) => `<option value="${esc(p.name)}"${p.isDefault ? " selected" : ""}>${esc(p.name)}${p.isDefault ? " (Standard)" : ""}</option>`).join("");
      if (!data.printers.length) {
        msg("#print-result", "err", "macOS kennt auf diesem Mac keinen Drucker.", "Systemeinstellungen › Drucker & Scanner › Drucker hinzufügen. Danach hier neu laden.");
        return;
      }
      renderQueueTable();
      await loadOptions();
    } catch (e) {
      showError("#print-result", e);
    }
  }

  function renderQueueTable() {
    const body = $("#queue-table tbody");
    if (!body) return;
    body.innerHTML = state.printers
      .map((p) => {
        const cls = p.state === "idle" ? "ok" : p.state === "disabled" ? "err" : "warn";
        return `<tr><td><strong>${esc(p.name)}</strong>${p.isDefault ? ' <span class="pill">Standard</span>' : ""}</td><td><span class="pill ${cls}">${esc(p.stateText)}</span></td><td class="mono">${esc(p.device || "—")}</td></tr>`;
      })
      .join("");
  }

  const OPTION_LABELS = {
    ColorModel: "Farbe",
    Duplex: "Beidseitig",
    PageSize: "Papierformat",
    InputSlot: "Papierquelle",
    MediaType: "Medium",
    Collate: "Sortieren",
    cupsPrintQuality: "Qualität",
    cupsFinishingTemplate: "Finishing",
  };
  const VALUE_LABELS = {
    RGB: "Farbe",
    Gray: "Graustufen",
    Gray16: "Graustufen (16 bit)",
    None: "Aus",
    DuplexNoTumble: "Ein (lange Kante)",
    DuplexTumble: "Ein (kurze Kante)",
    True: "Ja",
    False: "Nein",
    auto: "Automatisch",
    "by-pass-tray": "Mehrzweckfach",
    "tray-1": "Kassette 1",
    none: "Keins",
  };

  async function loadOptions() {
    const queue = $("#print-queue").value;
    const wrap = $("#print-options");
    if (!queue) return;
    wrap.innerHTML = '<div style="color:var(--muted);font-size:.84rem"><i class="fa-solid fa-circle-notch spin"></i> Optionen werden gelesen</div>';
    try {
      const { options } = await call("/api/printer/options?queue=" + encodeURIComponent(queue));
      wrap.innerHTML = options
        .filter((o) => o.values.length > 1)
        .map((o) => {
          const label = OPTION_LABELS[o.key] || o.label;
          const opts = [...new Set(o.values)].map((v) => `<option value="${esc(v)}"${v === o.current ? " selected" : ""}>${esc(VALUE_LABELS[v] || v)}</option>`).join("");
          return `<div><label for="opt-${esc(o.key)}">${esc(label)}</label><select id="opt-${esc(o.key)}" data-opt="${esc(o.key)}">${opts}</select></div>`;
        })
        .join("");
      if (!wrap.innerHTML) wrap.innerHTML = `<div style="color:var(--muted);font-size:.84rem">Dieser Treiber bietet keine wählbaren Optionen.</div>`;
    } catch (e) {
      showError("#print-result", e);
      wrap.innerHTML = "";
    }
  }

  async function doPrint(file, filename) {
    const queue = $("#print-queue").value;
    if (!queue) return msg("#print-result", "err", "Kein Drucker gewählt.", "Erst einen Drucker in der Liste auswählen.");
    const options = {};
    $$("#print-options select").forEach((s) => (options[s.dataset.opt] = s.value));
    const qs = new URLSearchParams({ queue, copies: $("#print-copies").value || "1", options: JSON.stringify(options) });
    msg("#print-result", "info", "Auftrag wird übergeben…");
    try {
      const res = await call("/api/print?" + qs.toString(), {
        method: "POST",
        body: file,
        headers: { "Content-Type": "application/octet-stream", "X-Roots-Filename": filename.replace(/[^\x20-\x7e]/g, "_") },
      });
      msg("#print-result", "ok", `An „${queue}“ übergeben.`, res.jobId ? `Auftrag <code>${esc(res.jobId)}</code>` : null);
      loadJobs();
    } catch (e) {
      showError("#print-result", e);
    }
  }

  /* --------------------------------------------------------------- devices --- */

  async function loadDevices() {
    const body = $("#dev-table tbody");
    body.innerHTML = `<tr><td colspan="4"><i class="fa-solid fa-circle-notch spin"></i> Netz wird durchsucht</td></tr>`;
    try {
      const { devices } = await call("/api/discover", { timeout: 40000 });
      state.devices = devices;
      body.innerHTML = devices.length
        ? devices
            .map((d) => {
              const can = [d.canScan ? "Scan" : null, d.canColor ? "Farbe" : null, d.canDuplex ? "Duplex" : null].filter(Boolean).join(" · ") || "—";
              const admin = d.adminUrl ? `<a href="${esc(d.adminUrl)}" target="_blank" rel="noopener">öffnen</a>` : "—";
              return `<tr><td><strong>${esc(d.model || d.instance)}</strong></td><td class="mono">${esc(d.host || "—")}</td><td>${esc(can)}</td><td>${admin}</td></tr>`;
            })
            .join("")
        : `<tr><td colspan="4">Kein AirPrint-Gerät geantwortet. Gerät wecken oder Netz prüfen (Diagnose).</td></tr>`;
      fillScanHosts();
    } catch (e) {
      body.innerHTML = "";
      showError("#banner", e);
    }
  }

  function fillScanHosts() {
    const sel = $("#scan-host");
    const scanners = state.devices.filter((d) => d.canScan && d.host);
    const prev = sel.value;
    sel.innerHTML = scanners.map((d) => `<option value="${esc(d.host)}">${esc(d.model || d.instance)} — ${esc(d.host)}</option>`).join("");
    if (!scanners.length) {
      sel.innerHTML = `<option value="">Kein Scanner gefunden</option>`;
      msg("#scan-result", "err", "Im Netz hat kein Gerät mit Scan-Funktion geantwortet.", "Unter „Geräte“ neu suchen. Bleibt es leer: Diagnose starten — meist ist der Drucker im Ruhezustand oder in einem anderen WLAN.");
      return;
    }
    if (prev && scanners.some((d) => d.host === prev)) sel.value = prev;
    loadCaps();
  }

  /* --------------------------------------------------------------- scanner --- */

  const COLOR_LABELS = { RGB24: "Farbe", Grayscale8: "Graustufen", BlackAndWhite1: "Schwarzweiß" };
  const INTENT_LABELS = { Document: "Dokument", Photo: "Foto", TextAndGraphic: "Text & Grafik", Preview: "Vorschau" };
  const FORMAT_LABELS = { "application/pdf": "PDF", "image/jpeg": "JPEG", "image/png": "PNG", "application/octet-stream": "Rohdaten" };
  const PAPER = {
    "": "Ganze Fläche",
    a4: { label: "A4", w: 2480, h: 3508 },
    letter: { label: "Letter", w: 2550, h: 3300 },
    a5: { label: "A5", w: 1748, h: 2480 },
  };

  function sourceCaps() {
    if (!state.caps) return null;
    const src = $("#scan-source").value;
    if (src === "feeder") return $("#scan-duplex").value === "1" ? state.caps.sources.feederDuplex || state.caps.sources.feeder : state.caps.sources.feeder;
    return state.caps.sources.platen;
  }

  async function loadCaps() {
    const host = $("#scan-host").value;
    if (!host) return;
    clear("#scan-result");
    try {
      state.caps = await call("/api/scanner/capabilities?host=" + encodeURIComponent(host), { timeout: 30000 });
      const s = state.caps.sources;
      const sel = $("#scan-source");
      sel.innerHTML = [s.platen ? '<option value="platen">Flachbett</option>' : "", s.feeder ? '<option value="feeder">Einzug</option>' : ""].join("");
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
    fill("#scan-res", caps.resolutions.map(String), null, ["300"]);
    fill(
      "#scan-format",
      caps.formats.filter((f) => f !== "application/octet-stream"),
      FORMAT_LABELS,
      ["application/pdf"]
    );
    fill("#scan-intent", caps.intents, INTENT_LABELS, ["Document"]);
    $("#scan-size").innerHTML = Object.entries(PAPER)
      .map(([k, v]) => `<option value="${k}">${esc(typeof v === "string" ? v : v.label)}</option>`)
      .join("");
    $("#scan-res").insertAdjacentHTML("beforeend", "");
    $$("#scan-res option").forEach((o) => (o.textContent = o.value + " dpi"));
  }

  async function refreshScannerStatus() {
    const host = $("#scan-host").value;
    const pill = $("#scan-adf");
    if (!host) return;
    pill.className = "pill";
    pill.innerHTML = '<i class="fa-solid fa-circle-notch spin"></i> Status';
    try {
      const st = await call("/api/scanner/status?host=" + encodeURIComponent(host), { timeout: 15000 });
      const loaded = st.adfLoaded;
      pill.className = "pill " + (st.state === "Idle" ? (loaded ? "ok" : "") : "warn");
      pill.innerHTML = `<i class="fa-solid fa-${st.state === "Idle" ? "circle-check" : "hourglass-half"}"></i> ${esc(st.state || "?")}${st.adfState ? " · Einzug " + (loaded ? "belegt" : "leer") : ""}`;
    } catch (e) {
      pill.className = "pill err";
      pill.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> kein Status';
      showError("#scan-result", e);
    }
  }

  async function startScan() {
    const host = $("#scan-host").value;
    if (!host) return msg("#scan-result", "err", "Kein Scanner gewählt.", "Unter „Geräte“ das Netz durchsuchen.");
    const size = PAPER[$("#scan-size").value];
    const body = {
      host,
      source: $("#scan-source").value,
      colorMode: $("#scan-color").value,
      resolution: Number($("#scan-res").value),
      format: $("#scan-format").value,
      intent: $("#scan-intent").value,
      duplex: $("#scan-duplex").value === "1",
    };
    // eSCL scan regions are counted in 1/300 inch, independent of resolution.
    if (size && typeof size !== "string") {
      body.width = size.w;
      body.height = size.h;
    }
    $("#scan-go").disabled = true;
    $("#scan-pages").innerHTML = "";
    $("#scan-actions").classList.add("hidden");
    msg("#scan-result", "info", "Scan läuft…", "Der Auftrag wird am Gerät ausgeführt. Seiten erscheinen, sobald sie übertragen sind.");
    try {
      const job = await call("/api/scan", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, timeout: 60000 });
      state.scan = job;
      pollScan();
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
      renderPages(job);
      if (job.state === "running") {
        state.pollTimer = setTimeout(pollScan, 1500);
        return;
      }
      $("#scan-go").disabled = false;
      if (job.state === "error") {
        showError("#scan-result", job.error || { message: "Der Scan brach ab." });
        return;
      }
      msg("#scan-result", "ok", `${job.pages.length} ${job.pages.length === 1 ? "Seite" : "Seiten"} gescannt.`, `${Math.round(job.elapsedMs / 1000)} s · ${job.settings.resolution} dpi · ${COLOR_LABELS[job.settings.colorMode] || job.settings.colorMode}`);
      $("#scan-actions").classList.toggle("hidden", !job.pages.length);
    } catch (e) {
      $("#scan-go").disabled = false;
      showError("#scan-result", e);
    }
  }

  function pageUrl(page) {
    return state.url + page.url + "?token=" + encodeURIComponent(state.token);
  }

  function renderPages(job) {
    const wrap = $("#scan-pages");
    wrap.innerHTML = job.pages
      .map((p, i) => {
        const url = pageUrl(p);
        const ext = p.mime.includes("pdf") ? "pdf" : p.mime.includes("png") ? "png" : "jpg";
        const thumb = p.mime.startsWith("image/") ? `<img src="${esc(url)}" alt="Seite ${i + 1}">` : `<i class="fa-solid fa-file-pdf"></i>`;
        return `<div class="page">
          <div class="thumb" data-preview="${i}" data-mime="${esc(p.mime)}">${thumb}</div>
          <div class="meta"><span>Seite ${i + 1} · ${bytes(p.bytes)}</span><a href="${esc(url)}" download="scan-${String(i + 1).padStart(2, "0")}.${ext}">Laden</a></div>
        </div>`;
      })
      .join("");
    $$("#scan-pages .meta a").forEach((el, i) =>
      el.addEventListener("click", (ev) => {
        if (!window.RootsUserBridge?.downloadBlob) return;
        ev.preventDefault();
        savePage(job.pages[i], i);
      })
    );
    $$("#scan-pages .thumb").forEach((el) =>
      el.addEventListener("click", () => {
        const idx = Number(el.dataset.preview);
        openPreview(job.pages[idx], idx);
      })
    );
    state.scanPages = job.pages;
  }

  /** In the intranet iframe a plain <a download> is inert, so hand the blob over. */
  async function savePage(page, idx) {
    const name = `scan-${String(idx + 1).padStart(2, "0")}.${page.mime.includes("pdf") ? "pdf" : page.mime.includes("png") ? "png" : "jpg"}`;
    if (window.RootsUserBridge?.downloadBlob) {
      try {
        const res = await call(page.url, { raw: true });
        window.RootsUserBridge.downloadBlob(await res.blob(), name);
        return;
      } catch (e) {
        showError("#scan-result", e);
        return;
      }
    }
    const a = document.createElement("a");
    a.href = pageUrl(page);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function openPreview(page, idx) {
    const url = pageUrl(page);
    const ext = page.mime.includes("pdf") ? "pdf" : page.mime.includes("png") ? "png" : "jpg";
    $("#modal-title").textContent = `Seite ${idx + 1}`;
    $("#modal-content").innerHTML = page.mime.startsWith("image/") ? `<img src="${esc(url)}" alt="Seite ${idx + 1}">` : `<iframe src="${esc(url)}" style="height:80vh" title="Seite ${idx + 1}"></iframe>`;
    const dl = $("#modal-dl");
    dl.href = url;
    dl.download = `scan-${String(idx + 1).padStart(2, "0")}.${ext}`;
    $("#modal").classList.remove("hidden");
  }

  async function printScan() {
    const pages = state.scanPages || [];
    if (!pages.length) return;
    msg("#scan-result", "info", "Scan wird an den Drucker übergeben…");
    try {
      const res = await call(pages[0].url, { raw: true });
      const blob = await res.blob();
      await doPrint(blob, "scan.pdf");
      msg("#scan-result", "ok", "Erste Seite an den Drucker übergeben.", pages.length > 1 ? "Weitere Seiten einzeln über „Drucken“ übergeben." : null);
    } catch (e) {
      showError("#scan-result", e);
    }
  }

  /* ---------------------------------------------------------------- jobs --- */

  async function loadJobs() {
    const body = $("#jobs-table tbody");
    if (!body) return;
    try {
      const queue = $("#print-queue").value || "";
      const { jobs } = await call("/api/printer/jobs?queue=" + encodeURIComponent(queue));
      body.innerHTML = jobs.length ? jobs.map((j) => `<tr><td class="mono">${esc(j.id)}</td><td>${esc(j.user || "—")}</td><td>${j.size ? bytes(j.size) : "—"}</td></tr>`).join("") : `<tr><td colspan="3">Keine offenen Aufträge.</td></tr>`;
    } catch (e) {
      body.innerHTML = "";
      showError("#banner", e);
    }
  }

  /* ------------------------------------------------------------- diagnose --- */

  async function runDiagnose() {
    const out = $("#diag-out");
    out.innerHTML = '<i class="fa-solid fa-circle-notch spin"></i> Prüfung läuft';
    const host = $("#scan-host").value || (state.devices[0] && state.devices[0].host) || "";
    try {
      const d = await call("/api/diagnose?host=" + encodeURIComponent(host), { timeout: 60000 });
      $("#dev-ssid").innerHTML = `<i class="fa-solid fa-wifi"></i> ${esc(d.ssid || "kein WLAN")}`;
      out.innerHTML = d.checks
        .map(
          (c) => `<div class="check">
            <div class="ico ${c.ok ? "ok" : "bad"}"><i class="fa-solid fa-${c.ok ? "circle-check" : "circle-xmark"}"></i></div>
            <div class="body"><strong>${esc(c.label)}</strong>
              <div class="detail mono">${esc(c.detail)}</div>
              ${c.hint ? `<div class="fix"><i class="fa-solid fa-wrench"></i> ${esc(c.hint)}</div>` : ""}
            </div></div>`
        )
        .join("");
    } catch (e) {
      out.innerHTML = "";
      showError("#diag-out", e);
    }
  }

  /* ----------------------------------------------------------------- auth --- */

  let sb = null;
  const IN_IFRAME = window.parent !== window;
  const EMBEDDED = IN_IFRAME || new URLSearchParams(location.search).has("authBroker");

  function domainAllowed(email) {
    const dom = String(email || "").split("@")[1] || "";
    return CFG.ALLOWED_EMAIL_DOMAINS.includes(dom.toLowerCase());
  }

  async function bootAuth() {
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    // roots-user-bridge.js picks the client up here and installs the session
    // the intranet hands over, exactly as in the other ROOTS tools.
    window.__rootsSupabaseClient = sb;

    if (EMBEDDED) {
      $("#login-form").classList.add("hidden");
      msg("#gate-msg", "info", "Anmeldung wird vom Intranet übernommen…");
      window.addEventListener("roots-auth-ready", (e) => applySession(e.detail?.session || null));
      window.addEventListener("roots-auth-signed-out", () => {
        booted = false;
        msg("#gate-msg", "err", "Die Sitzung des Intranets ist beendet.", "Im Intranet neu anmelden, danach das Tool erneut öffnen.");
        showGate(true);
      });
      // The bridge repeats the hand-off while the frame starts; ask once itself
      // in case this frame was loaded before the parent was ready.
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
        /* bridge mounts itself when ready */
      }
    }
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
    const ok = await detectBridge();
    if (!ok) return;
    await loadPrinters();
    await loadDevices();
    loadJobs();
  }

  function switchView(view) {
    $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $$("section[data-panel]").forEach((s) => s.classList.toggle("hidden", s.dataset.panel !== view));
    if (view === "jobs") loadJobs();
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

    $("#print-queue").addEventListener("change", loadOptions);
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
      for (const [i, p] of (state.scanPages || []).entries()) {
        await savePage(p, i);
      }
    });

    $("#dev-refresh").addEventListener("click", loadDevices);
    $("#jobs-refresh").addEventListener("click", loadJobs);
    $("#diag-run").addEventListener("click", runDiagnose);

    $("#conn-save").addEventListener("click", async () => {
      state.url = $("#conn-url").value.trim().replace(/\/$/, "");
      state.token = $("#conn-token").value.trim();
      localStorage.setItem(LS_URL, state.url);
      localStorage.setItem(LS_TOKEN, state.token);
      const ok = await detectBridge(true);
      if (ok) {
        msg("#conn-out", "ok", `Verbunden mit ${state.url}.`);
        booted = false;
        await bootApp();
      } else if (state.bridgeIssue === "token") {
        msg("#conn-out", "err", "Der Helfer läuft, akzeptiert dieses Token aber nicht.", 'Aktuelles Token anzeigen: <code>cat ~/.roots-print/token</code>');
      } else {
        const kind = location.protocol === "https:" ? "blocked" : "offline";
        msg("#conn-out", "err", `Unter ${esc(state.url)} antwortet kein Helfer.`, NETWORK_HINTS[kind].hint);
      }
    });
    $("#conn-forget").addEventListener("click", () => {
      localStorage.removeItem(LS_TOKEN);
      state.token = "";
      $("#conn-token").value = "";
      msg("#conn-out", "info", "Token gelöscht.");
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
    bootAuth().catch((e) => msg("#gate-msg", "err", "Supabase ist nicht erreichbar.", "Netzverbindung prüfen und Seite neu laden."));
  });
})();
