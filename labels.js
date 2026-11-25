/**
 * ROOTS Print - Adressetiketten.
 *
 * Avery Zweckform 4782 (97 x 67,7 mm, 2 x 4 auf A4). Adressen liegen in
 * Supabase (print.label_addresses, nur Konten in print.label_access). Das PDF
 * entsteht im Browser und geht als normaler Druckauftrag an den Drucker.
 *
 * Druckstatus: "Alle drucken" druckt nur offene, fehlerfreie Adressen und
 * markiert sie danach als gedruckt. Die Testseite markiert nichts.
 * Internetmarken (print.label_stamps): die gewählten werden der Reihe nach auf
 * die Etiketten gesetzt. Echter Druck markiert sie als verbraucht, die Testseite
 * nicht. Jeder Druck landet pro Etikett in print.label_log.
 */
(function () {
  "use strict";

  const SHEET = { w: 210, h: 297, cols: 2, rows: 4, lw: 97, lh: 67.7 };
  SHEET.left = (SHEET.w - SHEET.cols * SHEET.lw) / 2;
  SHEET.top = (SHEET.h - SHEET.rows * SHEET.lh) / 2;
  const PER = SHEET.cols * SHEET.rows;
  const PAD = 9;
  const INSET = 5;
  const PT = 0.3528;

  const LIBS = {
    jspdf: { url: "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js", ready: () => window.jspdf },
    xlsx: { url: "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js", ready: () => window.XLSX },
    pdfjs: { url: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js", ready: () => window.pdfjsLib },
  };
  const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";

  const COUNTRY = {
    deutschland: "", germany: "", de: "", "": "",
    england: "GROSSBRITANNIEN", "united kingdom": "GROSSBRITANNIEN", uk: "GROSSBRITANNIEN", "großbritannien": "GROSSBRITANNIEN",
    belgium: "BELGIEN", belgien: "BELGIEN",
    "the netherlands": "NIEDERLANDE", netherlands: "NIEDERLANDE", niederlande: "NIEDERLANDE",
    frankreich: "FRANKREICH", france: "FRANKREICH",
    tschechien: "TSCHECHIEN", "czech republic": "TSCHECHIEN",
    schweiz: "SCHWEIZ", switzerland: "SCHWEIZ", "österreich": "ÖSTERREICH", austria: "ÖSTERREICH",
  };
  // Postleitzahl am Anfang der Ortszeile, je Land
  const ZIP = {
    "": /^\d{5}\s+\S/, BELGIEN: /^\d{4}\s+\S/, NIEDERLANDE: /^\d{4}\s?[A-Z]{2}\s+\S/i, FRANKREICH: /^\d{5}\s+\S/,
    TSCHECHIEN: /^\d{3}\s?\d{2}\s+\S/, SCHWEIZ: /^\d{4}\s+\S/, "ÖSTERREICH": /^\d{4}\s+\S/,
  };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const api = () => window.ROOTS_PRINT_API;
  const relay = () => window.RootsPrintRelay;

  const st = { sel: new Set(), lists: [], list: null, rows: [], stamps: [], status: "all", q: "", loaded: false, libs: {}, measure: null };

  function loadLib(name) {
    const lib = LIBS[name];
    if (lib.ready()) return Promise.resolve();
    if (st.libs[name]) return st.libs[name];
    st.libs[name] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = lib.url;
      s.onload = resolve;
      s.onerror = () => {
        delete st.libs[name];
        reject(new Error("Bibliothek konnte nicht geladen werden: " + name));
      };
      document.head.appendChild(s);
    });
    return st.libs[name];
  }

  const num = (id, def) => {
    const v = parseFloat(String($(id)?.value || "").replace(",", "."));
    return Number.isFinite(v) ? v : def;
  };

  function settings() {
    return {
      filter: api().selValue("lbl-filter") || "all",
      owner: api().selValue("lbl-owner") || "",
      start: Math.min(PER, Math.max(1, Math.round(num("#lbl-start", 1)))),
      fs: Math.min(14, Math.max(7, num("#lbl-fs", 10.5))),
      dx: num("#lbl-dx", 0),
      dy: num("#lbl-dy", 0),
      sw: Math.min(80, Math.max(0, num("#lbl-sw", 50))),
      sh: Math.min(50, Math.max(0, num("#lbl-sh", 30))),
    };
  }

  /* ----------------------------------------------------------- addresses --- */

  function country(c) {
    const k = String(c || "").trim().toLowerCase();
    return k in COUNTRY ? COUNTRY[k] : String(c).trim().toUpperCase();
  }

  function lines(r) {
    const out = [r.name];
    if (r.company && String(r.kind || "").toLowerCase() !== "privat") out.push(r.company);
    out.push(r.street, r.city);
    return { lines: out.filter(Boolean), country: country(r.country) };
  }

  /** Textbreite in mm bei Schriftgröße pt, ohne jsPDF. */
  function textMm(text, pt, bold) {
    if (!st.measure) st.measure = document.createElement("canvas").getContext("2d");
    st.measure.font = `${bold ? "bold " : ""}${pt}px Helvetica, Arial, sans-serif`;
    return st.measure.measureText(text).width * PT;
  }

  /** Prüft eine Adresse. errors blockieren den Druck, hints nicht. */
  function check(r, dupes) {
    const errors = [];
    const hints = [];
    if (!String(r.street || "").trim()) errors.push("Straße fehlt");
    if (!String(r.city || "").trim()) errors.push("PLZ/Ort fehlt");
    const c = country(r.country);
    if (r.city && ZIP[c] && !ZIP[c].test(String(r.city).trim())) errors.push("PLZ fehlt oder falsch");
    if (r.city && !ZIP[c] && !/\d/.test(r.city)) hints.push("Keine PLZ erkennbar");
    if (r.street && !/\d/.test(r.street) && !/postfach|p\.?o\.? box/i.test(r.street)) hints.push("Keine Hausnummer");
    const maxW = SHEET.lw - 2 * PAD;
    const l = lines(r);
    if (/\n/.test(String(r.name || "").trim())) errors.push("Mehrere Namen in einer Zelle");
    else if (l.lines.some((t) => textMm(t, 7, false) > maxW)) errors.push("Zeile zu lang");
    else if (l.lines.some((t) => textMm(t, settings().fs, false) > maxW)) hints.push("Wird verkleinert");
    if (dupes.get(String(r.name).trim().toLowerCase()) > 1) hints.push("Doppelt");
    return { errors, hints };
  }

  function evaluate() {
    const dupes = new Map();
    st.rows.forEach((r) => {
      const k = String(r.name).trim().toLowerCase();
      dupes.set(k, (dupes.get(k) || 0) + 1);
    });
    st.rows.forEach((r) => {
      const c = check(r, dupes);
      r._errors = c.errors;
      r._hints = c.hints;
      r._status = c.errors.length ? "error" : r.printed_at ? "printed" : "open";
    });
  }

  function inScope(r) {
    const s = settings();
    return (s.filter === "all" || r[s.filter]) && (!s.owner || r.owner === s.owner);
  }

  /** Was "Alle drucken" drucken würde. */
  function printable() {
    return st.rows.filter((r) => inScope(r) && r._status === "open");
  }

  /** Was die Testseite zeigt: die nächsten offenen, sonst irgendwelche fehlerfreien. */
  function testRows() {
    const open = printable();
    const pool = open.length ? open : st.rows.filter((r) => inScope(r) && r._status !== "error");
    return pool.slice(0, PER - settings().start + 1);
  }


  /* -------------------------------------------------------------- render --- */

  function renderAll() {
    evaluate();
    renderCounts();
    renderTable();
    renderInfo();
  }

  function animateNumber(el, to) {
    const from = Number(el.dataset.v || 0);
    el.dataset.v = to;
    if (from === to) return (el.textContent = to);
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 450);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderCounts() {
    const scope = st.rows.filter(inScope);
    const n = { all: scope.length, open: 0, printed: 0, error: 0 };
    scope.forEach((r) => n[r._status]++);
    Object.keys(n).forEach((k) => {
      const el = document.querySelector(`.lbl-chip[data-status="${k}"] b`);
      if (el) animateNumber(el, n[k]);
    });
    const done = n.all ? Math.round((n.printed / n.all) * 100) : 0;
    $("#lbl-progress-bar").style.width = done + "%";
    $("#lbl-progress-text").textContent = `${n.printed} von ${n.all} gedruckt`;
  }

  const COLS = [
    { key: "owner", label: "Owner", w: "64px" },
    { key: "name", label: "Name" },
    { key: "company", label: "Firma" },
    { key: "street", label: "Straße" },
    { key: "city", label: "PLZ Ort" },
    { key: "country", label: "Land", w: "120px" },
  ];
  const STATUS_LABEL = { open: "Offen", printed: "Gedruckt", error: "Fehlerhaft" };

  function renderTable() {
    const q = st.q.trim().toLowerCase();
    const rows = st.rows.filter(
      (r) => inScope(r) && (st.status === "all" || r._status === st.status) && (!q || COLS.some((c) => String(r[c.key] || "").toLowerCase().includes(q)))
    );
    const body = $("#lbl-table tbody");
    body.innerHTML = rows.length
      ? rows
          .map((r, i) => {
            const issues = r._errors.concat(r._hints);
            const date = r.printed_at ? new Date(r.printed_at).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) : "";
            return (
              `<tr data-id="${esc(r.id)}" class="st-${r._status}" style="animation-delay:${Math.min(i, 30) * 14}ms">` +
              `<td><button class="lbl-status st-${r._status}" data-info title="Verlauf">${STATUS_LABEL[r._status]}</button></td>` +
              COLS.map((c) => {
                const bad = (c.key === "street" && r._errors.includes("Straße fehlt")) || (c.key === "city" && r._errors.some((e) => /PLZ/.test(e)));
                return `<td class="ed${bad ? " bad" : ""}" data-k="${c.key}" contenteditable="plaintext-only" spellcheck="false">${esc(r[c.key] || "")}</td>`;
              }).join("") +
              `<td class="lbl-issues">${issues.map((t, k) => `<span class="${k < r._errors.length ? "e" : "h"}">${esc(t)}</span>`).join("")}</td>` +
              `<td class="lbl-printed"><label class="lbl-check"><input type="checkbox" ${r.printed_at ? "checked" : ""} ${r._errors.length && !r.printed_at ? "disabled" : ""}><span>${date}</span></label></td>` +
              `</tr>`
            );
          })
          .join("")
      : `<tr class="lbl-empty"><td colspan="${COLS.length + 3}">Keine Einträge</td></tr>`;
  }

  function renderInfo() {
    const s = settings();
    const ok = printable();
    const sheets = ok.length ? Math.ceil((ok.length + s.start - 1) / PER) : 0;
    $("#lbl-count").textContent = ok.length ? `${ok.length} offen · ${sheets} ${sheets === 1 ? "Bogen" : "Bögen"}` : "Nichts offen";
    $("#lbl-all").disabled = !ok.length;
    $("#lbl-test").disabled = !testRows().length;
    const free = st.stamps.filter((m) => !m.used_at).length;
    const sel = selectedStamps().length;
    $("#lbl-stamps-info").textContent = `${sel} gewählt · ${free} frei`;
    renderStamps();
    renderPreview(testRows(), s);
  }

  const fmtDate = (d) => new Date(d).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

  function renderStamps() {
    $("#lbl-stamp-list").innerHTML = st.stamps.length
      ? st.stamps
          .map((m) => {
            const who = m.used_for ? st.rows.find((r) => r.id === m.used_for)?.name : "";
            const on = st.sel.has(m.id);
            return (
              `<div class="lbl-stamp-item${m.used_at ? " used" : ""}${on ? " on" : ""}" data-stamp="${esc(m.id)}">` +
              `<label class="lbl-stamp-pick"><input type="checkbox" ${on ? "checked" : ""}></label>` +
              `<img src="${esc(m.image)}" alt="">` +
              `<div><strong>${esc(m.info || "Internetmarke")}</strong><span>${m.used_at ? "Gedruckt " + fmtDate(m.used_at) + (who ? " · " + esc(who) : "") : "Frei"}</span></div>` +
              `<button class="btn-ghost" data-log="${esc(m.id)}" title="Verlauf"><i class="ri-history-line"></i></button>` +
              `<button class="btn-ghost" data-del="${esc(m.id)}" title="Entfernen"><i class="ri-delete-bin-line"></i></button>` +
              `</div>`
            );
          })
          .join("")
      : `<div class="lbl-hint">Noch keine Marke</div>`;
  }

  /** Gewählte Marken in Listenreihenfolge. */
  const selectedStamps = () => st.stamps.filter((m) => st.sel.has(m.id));

  function renderPreview(rows, s) {
    const box = $("#lbl-preview");
    const scale = box.clientWidth / SHEET.w || 2.5;
    const items = Array(s.start - 1).fill(null).concat(rows);
    const stamps = selectedStamps();
    let used = 0;
    let html = "";
    for (let i = 0; i < PER; i++) {
      const x = SHEET.left + (i % SHEET.cols) * SHEET.lw;
      const y = SHEET.top + Math.floor(i / SHEET.cols) * SHEET.lh;
      const r = items[i];
      let inner = "";
      if (r) {
        const l = lines(r);
        const m = stamps[used++];
        const fit = m ? stampBox(m, s) : null;
        inner =
          (m
            ? `<img class="lbl-stamp-img" src="${esc(m.image)}" style="top:${INSET * scale}px;right:${INSET * scale}px;width:${fit.w * scale}px;height:${fit.h * scale}px">`
            : `<div class="lbl-stamp" style="top:${INSET * scale}px;right:${INSET * scale}px;width:${s.sw * scale}px;height:${s.sh * scale}px"></div>`) +
          `<div class="lbl-addr" style="left:${PAD * scale}px;right:${PAD * scale}px;bottom:${PAD * scale}px;font-size:${s.fs * PT * scale}px">` +
          l.lines.map((t) => `<div>${esc(t)}</div>`).join("") +
          (l.country ? `<div class="lbl-cty">${esc(l.country)}</div>` : "") +
          `</div>`;
      }
      html += `<div class="lbl-cell${r ? "" : " empty"}" style="left:${x * scale}px;top:${y * scale}px;width:${SHEET.lw * scale}px;height:${SHEET.lh * scale}px;animation-delay:${i * 40}ms">${inner}</div>`;
    }
    box.style.height = SHEET.h * scale + "px";
    box.innerHTML = html;
  }

  /** Marke in Originalgröße, verkleinert nur, wenn sie nicht ins Frankierfeld passt. */
  function stampBox(m, s) {
    const w = Number(m.w_mm);
    const h = Number(m.h_mm);
    const k = Math.min(1, (s.sw || w) / w, (s.sh || h) / h);
    return { w: w * k, h: h * k };
  }

  /* ----------------------------------------------------------------- pdf --- */

  async function buildPdf(rows, stamps) {
    await loadLib("jspdf");
    const { jsPDF } = window.jspdf;
    const s = settings();
    const items = Array(s.start - 1).fill(null).concat(rows);
    const placed = [];
    const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
    const lh = s.fs * PT * 1.3;
    const maxW = SHEET.lw - 2 * PAD;
    let si = 0;
    for (let p = 0; p < items.length; p += PER) {
      if (p) doc.addPage();
      for (let i = 0; i < PER && p + i < items.length; i++) {
        const r = items[p + i];
        if (!r) continue;
        const cx = SHEET.left + (i % SHEET.cols) * SHEET.lw + s.dx;
        const cy = SHEET.top + Math.floor(i / SHEET.cols) * SHEET.lh + s.dy;
        const m = (stamps || [])[si++] || null;
        if (m) {
          const fit = stampBox(m, s);
          doc.addImage(m.image, "PNG", cx + SHEET.lw - INSET - fit.w, cy + INSET, fit.w, fit.h, "stamp-" + m.id, "NONE");
        }
        placed.push({ row: r, stamp: m, sheet: p / PER + 1, position: i + 1 });
        const l = lines(r);
        const all = l.lines.map((t) => ({ t, b: false })).concat(l.country ? [{ t: l.country, b: true }] : []);
        const yBottom = cy + SHEET.lh - PAD;
        all.forEach((row, k) => {
          let size = s.fs;
          doc.setFont("helvetica", row.b ? "bold" : "normal");
          doc.setFontSize(size);
          while (doc.getTextWidth(row.t) > maxW && size > 7) doc.setFontSize((size -= 0.5));
          doc.text(row.t, cx + PAD, yBottom - (all.length - 1 - k) * lh, { baseline: "bottom" });
        });
      }
    }
    return { blob: doc.output("blob"), placed };
  }

  /**
   * kind: "test" (verbraucht nichts), "print" (offene Adressen), "reprint" (eine
   * bereits gedruckte Adresse erneut). Bereits gedruckte Marken bei echtem Druck
   * nur nach Bestätigung, vermerkt im Protokoll.
   */
  async function print(kind, only) {
    const test = kind === "test";
    const printerId = api().selValue("lbl-printer");
    const printer = api().printers().find((p) => String(p.id) === String(printerId));
    if (!printer) return api().note("#lbl-result", "err", "Kein Drucker gewählt.");
    if (printer.agentOnline === false) return api().note("#lbl-result", "err", "Der Druck-Agent ist offline.", "Auf dem Mac mit dem Drucker muss der Agent laufen. Status-Seite prüfen.");
    const rows = only ? only : test ? testRows() : printable();
    if (!rows.length) return api().note("#lbl-result", "err", "Keine Adressen zum Drucken.");
    const stamps = selectedStamps();
    const reused = stamps.slice(0, rows.length).filter((m) => m.used_at);
    let confirmed = false;
    if (!test && (reused.length || kind === "reprint")) {
      const parts = [];
      if (kind === "reprint") parts.push(`<p><strong>${esc(rows[0].name)}</strong> wurde bereits gedruckt${rows[0].printed_at ? " am " + fmtDate(rows[0].printed_at) : ""}.</p>`);
      if (reused.length)
        parts.push(
          `<p>${reused.length === 1 ? "Diese Marke wurde" : "Diese Marken wurden"} bereits gedruckt. Jede Internetmarke gilt nur einmal, eine doppelt verwendete Sendung kann nachentgeltet werden.</p><ul>` +
            reused.map((m) => `<li>${esc(m.info || "Internetmarke")} · ${fmtDate(m.used_at)}</li>`).join("") +
            "</ul>"
        );
      confirmed = await confirmBox(kind === "reprint" ? "Erneut drucken?" : "Gedruckte Marke erneut verwenden?", parts.join("") + "<p>Wird im Protokoll vermerkt.</p>", "Trotzdem drucken");
      if (!confirmed) return;
    }
    let pdf;
    try {
      pdf = await buildPdf(rows, stamps);
    } catch (e) {
      return api().note("#lbl-result", "err", e.message || "PDF konnte nicht erstellt werden.");
    }
    const options = { PageSize: "A4", Duplex: "None", "print-scaling": "none", "fit-to-page": "false" };
    const slot = api().selValue("lbl-slot");
    if (slot) options.InputSlot = slot;
    const name = (test ? "Etiketten_Test_" : kind === "reprint" ? "Etiketten_Nachdruck_" : "Etiketten_") + String(st.list || "Liste").replace(/[^A-Za-z0-9_-]+/g, "_") + ".pdf";
    const res = await api().print(pdf.blob, name, { printer, options, copies: "1", result: "#lbl-result", button: test ? "#lbl-test" : "#lbl-all" });
    if (!res?.ok) return;
    try {
      await relay().labelLogAdd(
        pdf.placed.map((p) => ({
          kind,
          job_id: res.jobId,
          printer: printer.display_name || printer.queue,
          list: st.list,
          sheet: p.sheet,
          position: p.position,
          address_id: p.row.id,
          address_name: p.row.name,
          address: { owner: p.row.owner, name: p.row.name, company: p.row.company, street: p.row.street, city: p.row.city, country: p.row.country },
          stamp_id: p.stamp?.id || null,
          stamp_info: p.stamp?.info || null,
          stamp_reused: !!p.stamp?.used_at,
          confirmed,
        }))
      );
      if (!test) {
        for (const p of pdf.placed) if (p.stamp && !p.stamp.used_at) await relay().labelStampUse(p.stamp.id, p.row.id);
        if (kind === "print") await relay().labelMarkPrinted(rows.map((r) => r.id), res.jobId);
      }
      await reload();
      api().note("#lbl-result", "ok", test ? "Testseite gedruckt." : `${rows.length} ${rows.length === 1 ? "Adresse" : "Adressen"} gedruckt und protokolliert.`);
    } catch (e) {
      api().note("#lbl-result", "err", "Gedruckt, aber Protokoll oder Status nicht gespeichert: " + (e.message || ""), "Im Zweifel Häkchen in der Tabelle setzen.");
    }
  }

  /* ---------------------------------------------------------- dialogs --- */

  function confirmBox(title, html, okLabel) {
    return new Promise((resolve) => {
      const o = document.createElement("div");
      o.className = "lbl-dialog";
      o.innerHTML =
        `<div class="lbl-dialog-box" role="dialog" aria-modal="true"><h2>${esc(title)}</h2><div class="lbl-dialog-body">${html}</div>` +
        `<div class="lbl-dialog-foot"><button class="btn-ghost" data-v="0">Abbrechen</button><button class="btn-primary btn-sm" data-v="1">${esc(okLabel)}</button></div></div>`;
      const done = (v) => {
        o.classList.add("out");
        setTimeout(() => o.remove(), 180);
        document.removeEventListener("keydown", key);
        resolve(v);
      };
      const key = (e) => e.key === "Escape" && done(false);
      o.addEventListener("click", (e) => {
        if (e.target === o) return done(false);
        const b = e.target.closest("[data-v]");
        if (b) done(b.dataset.v === "1");
      });
      document.addEventListener("keydown", key);
      document.body.appendChild(o);
      o.querySelector('[data-v="0"]').focus();
    });
  }

  /* ----------------------------------------------------------- drawer --- */

  const KIND = { test: "Test", print: "Druck", reprint: "Nachdruck" };

  async function openDrawer(o = {}) {
    const d = $("#lbl-drawer");
    const r = o.address ? st.rows.find((x) => x.id === o.address) : null;
    const m = o.stamp ? st.stamps.find((x) => x.id === o.stamp) : null;
    $("#lbl-drawer-title").textContent = r ? r.name : m ? m.info || "Internetmarke" : "Druckprotokoll";
    const head = $("#lbl-drawer-head");
    head.innerHTML = r
      ? `<div class="lbl-kv"><span>Adress-ID</span><code>${esc(r.id)}</code></div>` +
        `<div class="lbl-kv"><span>Status</span>${STATUS_LABEL[r._status]}${r.printed_at ? " · " + fmtDate(r.printed_at) : ""}</div>` +
        (r._errors.length || r._hints.length ? `<div class="lbl-kv"><span>Prüfung</span>${esc(r._errors.concat(r._hints).join(", "))}</div>` : "") +
        (r._status === "printed" ? `<button class="btn-secondary btn-sm" id="lbl-reprint" style="margin-top:.6rem"><i class="ri-printer-line"></i> Erneut drucken</button>` : "")
      : m
        ? `<img class="lbl-drawer-stamp" src="${esc(m.image)}" alt=""><div class="lbl-kv"><span>Marken-ID</span><code>${esc(m.id)}</code></div>` +
          `<div class="lbl-kv"><span>Datei</span>${esc(m.filename || "-")}</div>` +
          `<div class="lbl-kv"><span>Status</span>${m.used_at ? "Gedruckt " + fmtDate(m.used_at) : "Frei"}</div>`
        : "";
    $("#lbl-drawer-body").innerHTML = `<div class="lbl-hint"><i class="ri-loader-4-line spin"></i> Lädt</div>`;
    d.classList.add("open");
    $("#lbl-reprint")?.addEventListener("click", () => {
      closeDrawer();
      print("reprint", [r]);
    });
    try {
      const log = await relay().labelLog({ address: o.address, stamp: o.stamp });
      renderLog(log, !r);
    } catch (e) {
      $("#lbl-drawer-body").innerHTML = `<div class="lbl-hint">${esc(e.message || "Protokoll nicht geladen")}</div>`;
    }
  }

  function renderLog(log, showName) {
    if (!log.length) return ($("#lbl-drawer-body").innerHTML = `<div class="lbl-hint">Noch nichts gedruckt</div>`);
    const jobs = new Map();
    log.forEach((e) => {
      const k = e.job_id || e.id;
      if (!jobs.has(k)) jobs.set(k, []);
      jobs.get(k).push(e);
    });
    $("#lbl-drawer-body").innerHTML = [...jobs.values()]
      .map((list, gi) => {
        const e0 = list[0];
        return (
          `<div class="lbl-log-job" style="animation-delay:${Math.min(gi, 12) * 40}ms">` +
          `<div class="lbl-log-head"><span class="lbl-kind k-${esc(e0.kind)}">${KIND[e0.kind] || esc(e0.kind)}</span><strong>${fmtDate(e0.created_at)}</strong><span>${esc(e0.printer || "")}</span></div>` +
          `<div class="lbl-log-meta">${esc(e0.user_email || "")}${e0.job_id ? ` · Auftrag <code>${esc(e0.job_id)}</code>` : ""}</div>` +
          list
            .map(
              (e) =>
                `<div class="lbl-log-row">` +
                `<span class="lbl-log-pos">B${e.sheet ?? "-"}·E${e.position ?? "-"}</span>` +
                `<div>${showName ? `<strong>${esc(e.address_name || "")}</strong>` : ""}` +
                (e.stamp_id ? `<span>Marke ${esc(e.stamp_info || "")}${e.stamp_reused ? ' <em class="warn">erneut verwendet</em>' : ""}${e.confirmed ? ' <em>bestätigt</em>' : ""}</span>` : `<span>ohne Marke</span>`) +
                `<code>${e.address_id ? "Adresse " + esc(e.address_id) : ""}${e.stamp_id ? "<br>Marke " + esc(e.stamp_id) : ""}</code></div></div>`
            )
            .join("") +
          `</div>`
        );
      })
      .join("");
  }

  function closeDrawer() {
    $("#lbl-drawer").classList.remove("open");
  }

  async function download() {
    try {
      const { blob } = await buildPdf(printable(), selectedStamps());
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "Etiketten_" + String(st.list || "Liste").replace(/[^A-Za-z0-9_-]+/g, "_") + ".pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      api().note("#lbl-result", "err", e.message || "PDF konnte nicht erstellt werden.");
    }
  }

  /* -------------------------------------------------------------- stamps --- */

  /** Dunkle Pixel einer Graustufen-Fläche, Schnittmarken in den Ecken ausgenommen. */
  function contentBox(img, w, h, dpmm) {
    const dark = (x, y) => img[(y * w + x) * 4] < 128;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (dark(x, y)) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 < 0) return null;
    const r = 6 * dpmm;
    let a = w, b = h, c = -1, d = -1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!dark(x, y)) continue;
      const corner = (Math.abs(x - x0) < r || Math.abs(x - x1) < r) && (Math.abs(y - y0) < r || Math.abs(y - y1) < r);
      if (corner) continue;
      if (x < a) a = x;
      if (x > c) c = x;
      if (y < b) b = y;
      if (y > d) d = y;
    }
    return c < 0 ? { x0, y0, x1, y1 } : { x0: a, y0: b, x1: c, y1: d };
  }

  async function stampFromPdf(file) {
    await loadLib("pdfjs");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const page = await pdf.getPage(1);
    const text = (await page.getTextContent()).items.map((i) => i.str).join(" ");
    const info = (text.match(/IM\s+\d\d\.\d\d\.\d\d/) || [""])[0] + ((text.match(/\d+,\d\d/) || [""])[0] ? " · " + text.match(/\d+,\d\d/)[0] + " €" : "");
    // Grob suchen, dann nur den Ausschnitt fein rendern
    const coarse = await renderPage(page, 100);
    const cb = contentBox(coarse.data, coarse.w, coarse.h, coarse.dpmm);
    if (!cb) throw new Error("Auf der Seite ist keine Marke zu sehen.");
    const fine = await renderPage(page, 600, {
      x: cb.x0 / coarse.dpmm - 2, y: cb.y0 / coarse.dpmm - 2, w: (cb.x1 - cb.x0) / coarse.dpmm + 4, h: (cb.y1 - cb.y0) / coarse.dpmm + 4,
    });
    const fb = contentBox(fine.data, fine.w, fine.h, fine.dpmm);
    return { ...cropToPng(fine, fb), info: info.trim() || "Internetmarke" };
  }

  async function renderPage(page, dpi, clip) {
    const scale = dpi / 72;
    const vp = page.getViewport({ scale });
    const dpmm = dpi / 25.4;
    const c = document.createElement("canvas");
    const off = clip ? { x: Math.max(0, clip.x * dpmm), y: Math.max(0, clip.y * dpmm) } : { x: 0, y: 0 };
    c.width = Math.ceil(clip ? clip.w * dpmm : vp.width);
    c.height = Math.ceil(clip ? clip.h * dpmm : vp.height);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -off.x, -off.y] }).promise;
    return { canvas: c, data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height, dpmm };
  }

  function cropToPng(src, b) {
    const w = b.x1 - b.x0 + 1;
    const h = b.y1 - b.y0 + 1;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(src.canvas, b.x0, b.y0, w, h, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = img.data[i] < 128 ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return { image: c.toDataURL("image/png"), w: +(w / src.dpmm).toFixed(1), h: +(h / src.dpmm).toFixed(1) };
  }

  async function stampFromImage(file, mmWidth) {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("Bild konnte nicht gelesen werden."));
      i.src = url;
    });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    return { image: c.toDataURL("image/png"), w: mmWidth, h: +((mmWidth * img.naturalHeight) / img.naturalWidth).toFixed(1), info: "Internetmarke" };
  }

  async function addStamp(file) {
    if (!file) return;
    api().note("#lbl-result", "info", "Marke wird gelesen…");
    try {
      const m = /\.pdf$/i.test(file.name) || file.type === "application/pdf" ? await stampFromPdf(file) : await stampFromImage(file, 36);
      const id = await relay().labelStampAdd({ ...m, filename: file.name });
      st.stamps = await relay().labelStamps();
      if (id) st.sel.add(id);
      renderInfo();
      api().note("#lbl-result", "ok", `Marke gespeichert: ${esc(m.info)}`, `${m.w} × ${m.h} mm`);
    } catch (e) {
      api().note("#lbl-result", "err", e.message || "Marke konnte nicht gelesen werden.", e.hint || null);
    } finally {
      $("#lbl-stampfile").value = "";
    }
  }

  async function deleteStamp(id) {
    const m = st.stamps.find((x) => x.id === id);
    if (!m) return;
    const ok = await confirmBox("Marke entfernen?", m.used_at ? "<p>Die Marke verschwindet aus der Liste. Das Protokoll bleibt.</p>" : "<p>Die Marke ist noch frei und bezahlt. Danach ist sie nicht mehr im Tool.</p>", "Entfernen");
    if (!ok) return;
    await relay().labelStampDelete(id);
    st.stamps = await relay().labelStamps();
    renderInfo();
  }

  /* -------------------------------------------------------------- import --- */

  async function importFile(file) {
    if (!file) return;
    api().note("#lbl-result", "info", "Excel wird gelesen…");
    try {
      await loadLib("xlsx");
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheetName = wb.SheetNames.find((n) => /20\d\d/.test(n) && !/alt/i.test(n)) || wb.SheetNames[0];
      const grid = window.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: true });
      const hi = grid.findIndex((r) => r && r.some((c) => /^name$/i.test(String(c || "").trim())) && r.some((c) => /stra(ß|ss)e/i.test(String(c || ""))));
      if (hi < 0) throw new Error("Keine Kopfzeile mit „Name“ und „Straße“ gefunden.");
      const head = grid[hi].map((c) => String(c || "").trim().toLowerCase());
      const col = (re) => head.findIndex((h) => re.test(h));
      const C = { owner: col(/^owner$/), name: col(/^name$/), company: col(/^company|firma/), kalender: col(/^kalender|^box$/), karte: col(/^karte$/), street: col(/stra(ß|ss)e/), city: col(/^stadt|^ort/), country: col(/^land/), kind: col(/privat/) };
      const val = (r, k) => (C[k] >= 0 && r[C[k]] != null ? String(r[C[k]]).trim() : "");
      const rows = grid.slice(hi + 1).filter((r) => r && val(r, "name")).map((r) => ({
        owner: val(r, "owner"), name: val(r, "name"), company: val(r, "company"), street: val(r, "street"), city: val(r, "city"),
        country: val(r, "country"), kind: val(r, "kind"), kalender: !!val(r, "kalender") && val(r, "kalender") !== "0", karte: !!val(r, "karte") && val(r, "karte") !== "0",
      }));
      if (!rows.length) throw new Error("Unter der Kopfzeile stehen keine Namen.");
      const list = ($("#lbl-listname").value || "").trim() || "Xmas " + new Date().getFullYear();
      const n = await relay().labelReplace(list, rows);
      api().note("#lbl-result", "ok", `${n} Adressen in „${esc(list)}“ gespeichert.`, "Druckstatus gleichnamiger Einträge bleibt erhalten");
      st.list = list;
      await refreshLists();
    } catch (e) {
      api().note("#lbl-result", "err", e.message || "Import fehlgeschlagen.", e.hint || null);
    } finally {
      $("#lbl-file").value = "";
    }
  }

  /* ---------------------------------------------------------------- edit --- */

  async function saveCell(td) {
    const tr = td.closest("tr");
    const r = st.rows.find((x) => x.id === tr.dataset.id);
    const k = td.dataset.k;
    const v = td.textContent.replace(/\s+/g, " ").trim();
    if (!r || String(r[k] || "") === v) return;
    if (k === "name" && !v) {
      td.textContent = r.name;
      return;
    }
    tr.classList.add("saving");
    try {
      const row = await relay().labelUpdate(r.id, { [k]: v });
      Object.assign(r, row);
      renderAll();
      flash(r.id);
    } catch (e) {
      td.textContent = r[k] || "";
      tr.classList.remove("saving");
      api().note("#lbl-result", "err", e.message || "Speichern fehlgeschlagen.");
    }
  }

  async function togglePrinted(input) {
    const tr = input.closest("tr");
    const r = st.rows.find((x) => x.id === tr.dataset.id);
    if (!r) return;
    tr.classList.add("saving");
    try {
      Object.assign(r, await relay().labelUpdate(r.id, { printed: input.checked }));
      renderAll();
      flash(r.id);
    } catch (e) {
      input.checked = !input.checked;
      tr.classList.remove("saving");
      api().note("#lbl-result", "err", e.message || "Speichern fehlgeschlagen.");
    }
  }

  function flash(id) {
    const tr = document.querySelector(`#lbl-table tr[data-id="${id}"]`);
    if (!tr) return;
    tr.style.animation = "none";
    tr.classList.add("flash");
    setTimeout(() => tr.classList.remove("flash"), 1200);
  }

  /* ---------------------------------------------------------------- load --- */

  async function refreshLists() {
    st.lists = await relay().labelLists();
    if (!st.list || !st.lists.some((l) => l.list === st.list)) st.list = st.lists[0]?.list || null;
    api().makeSelect("lbl-list", {
      options: st.lists.map((l) => ({ value: l.list, label: `${l.list} · ${l.n}` })),
      value: st.list,
      placeholder: "Noch keine Liste",
      onChange: (v) => {
        st.list = v;
        reload();
      },
    });
    if (!$("#lbl-listname").value) $("#lbl-listname").value = st.list || "Xmas " + new Date().getFullYear();
    await reload();
  }

  async function reload() {
    const [rows, stamps] = await Promise.all([
      st.list ? relay().labelAddresses(st.list) : [],
      relay().labelStamps().catch((e) => {
        api().note("#lbl-result", "err", e.message || "Marken konnten nicht geladen werden.", e.hint || null);
        return [];
      }),
    ]);
    st.rows = rows;
    st.stamps = stamps;
    const owners = [...new Set(st.rows.map((r) => r.owner).filter(Boolean))].sort();
    const cur = api().selValue("lbl-owner") || "";
    api().makeSelect("lbl-owner", { options: [{ value: "", label: "Alle" }].concat(owners.map((o) => ({ value: o, label: o }))), value: owners.includes(cur) ? cur : "", onChange: renderAll });
    // Standard: alle freien Marken gewählt; nicht mehr vorhandene abwählen
    const ids = new Set(st.stamps.map((m) => m.id));
    [...st.sel].forEach((id) => !ids.has(id) && st.sel.delete(id));
    if (!st.selInit) {
      st.stamps.filter((m) => !m.used_at).forEach((m) => st.sel.add(m.id));
      st.selInit = true;
    }
    renderAll();
  }

  function fillPrinters() {
    const printers = api().printers();
    api().makeSelect("lbl-printer", {
      options: printers.map((p) => ({ value: p.id, label: (p.display_name || p.queue) + (p.is_default ? " · Standard" : "") })),
      value: api().selValue("lbl-printer") || rememberedPrinter(printers) || api().defaultPrinterId(),
      placeholder: "Kein Drucker gemeldet",
      onChange: (v) => {
        try {
          window.localStorage.setItem("roots-print-label-printer", String(v));
        } catch (e) {
          /* sandboxed iframe: nur für diese Sitzung */
        }
        fillSlots();
      },
    });
    fillSlots();
  }

  /** Zuletzt gewählter Drucker, sonst ein Canon (Etikettendrucker im Büro). */
  function rememberedPrinter(printers) {
    let id = null;
    try {
      id = window.localStorage.getItem("roots-print-label-printer");
    } catch (e) {
      id = null;
    }
    if (id && printers.some((p) => String(p.id) === id)) return id;
    return printers.find((p) => /canon/i.test(p.display_name || p.queue || ""))?.id || null;
  }

  function fillSlots() {
    const p = api().printers().find((x) => String(x.id) === String(api().selValue("lbl-printer")));
    const slot = (p?.options || []).find((o) => o.key === "InputSlot");
    const values = slot ? [...new Set(slot.values)] : [];
    const label = { auto: "Automatisch", "by-pass-tray": "Mehrzweckfach", "tray-1": "Kassette 1" };
    api().makeSelect("lbl-slot", {
      options: values.map((v) => ({ value: v, label: label[v] || v })),
      value: values.includes("by-pass-tray") ? "by-pass-tray" : slot?.current || values[0] || null,
      placeholder: "Standard",
      disabled: !values.length,
    });
  }

  let wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    api().makeSelect("lbl-filter", {
      options: [{ value: "all", label: "Alle" }, { value: "kalender", label: "Nur Kalender" }, { value: "karte", label: "Nur Karte" }],
      value: "all",
      onChange: renderAll,
    });
    ["#lbl-start", "#lbl-fs", "#lbl-dx", "#lbl-dy", "#lbl-sw", "#lbl-sh"].forEach((id) => $(id).addEventListener("input", renderAll));
    $("#lbl-test").addEventListener("click", () => print("test"));
    $("#lbl-all").addEventListener("click", () => print("print"));
    $("#lbl-log").addEventListener("click", () => openDrawer());
    $("#lbl-drawer-close").addEventListener("click", closeDrawer);
    $("#lbl-drawer").addEventListener("click", (e) => e.target.id === "lbl-drawer" && closeDrawer());
    document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());
    $("#lbl-pdf").addEventListener("click", download);
    $("#lbl-import").addEventListener("click", () => $("#lbl-file").click());
    $("#lbl-file").addEventListener("change", (e) => importFile(e.target.files[0]));
    $("#lbl-stampadd").addEventListener("click", () => $("#lbl-stampfile").click());
    $("#lbl-stampfile").addEventListener("change", (e) => addStamp(e.target.files[0]));
    $("#lbl-stamp-list").addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) return deleteStamp(del.dataset.del);
      const log = e.target.closest("[data-log]");
      if (log) return openDrawer({ stamp: log.dataset.log });
    });
    $("#lbl-stamp-list").addEventListener("change", (e) => {
      const item = e.target.closest("[data-stamp]");
      if (!item) return;
      e.target.checked ? st.sel.add(item.dataset.stamp) : st.sel.delete(item.dataset.stamp);
      renderInfo();
    });
    $("#lbl-search").addEventListener("input", (e) => {
      st.q = e.target.value;
      renderTable();
    });
    document.querySelectorAll(".lbl-chip").forEach((c) =>
      c.addEventListener("click", () => {
        st.status = c.dataset.status;
        document.querySelectorAll(".lbl-chip").forEach((x) => x.classList.toggle("active", x === c));
        renderTable();
      })
    );
    const tbody = $("#lbl-table tbody");
    tbody.addEventListener("focusout", (e) => e.target.matches("td.ed") && saveCell(e.target));
    tbody.addEventListener("keydown", (e) => {
      if (!e.target.matches("td.ed")) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.target.blur();
      }
      if (e.key === "Escape") {
        const r = st.rows.find((x) => x.id === e.target.closest("tr").dataset.id);
        e.target.textContent = r?.[e.target.dataset.k] || "";
        e.target.blur();
      }
    });
    tbody.addEventListener("change", (e) => e.target.matches(".lbl-check input") && togglePrinted(e.target));
    tbody.addEventListener("click", (e) => {
      const b = e.target.closest("[data-info]");
      if (b) openDrawer({ address: b.closest("tr").dataset.id });
    });
    window.addEventListener("resize", () => st.loaded && renderInfo());
  }

  async function open() {
    wire();
    fillPrinters();
    try {
      await refreshLists();
      st.loaded = true;
    } catch (e) {
      api().note("#lbl-result", "err", e.message || "Adressen konnten nicht geladen werden.", e.hint || null);
    }
  }

  /** Menüpunkt nur zeigen, wenn das Konto Etiketten darf. */
  async function probe() {
    try {
      await relay().labelLists();
      $("#nav-labels")?.classList.remove("hidden");
      $("#nav-device")?.classList.remove("hidden");
    } catch (e) {
      $("#nav-labels")?.classList.add("hidden");
      $("#nav-device")?.classList.add("hidden");
    }
  }

  window.ROOTS_LABELS = { open, probe };
})();
