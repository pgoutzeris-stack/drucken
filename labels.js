/**
 * ROOTS Print - Adressetiketten.
 *
 * Avery Zweckform 4782 (97 x 67,7 mm, 2 x 4 auf A4). Adressen liegen in
 * Supabase (print.label_addresses, nur Konten in print.label_access). Das PDF
 * entsteht im Browser und geht als normaler Druckauftrag an den Drucker.
 * Oben rechts bleibt auf jedem Etikett ein Feld für die Online-Frankierung frei.
 */
(function () {
  "use strict";

  const SHEET = { w: 210, h: 297, cols: 2, rows: 4, lw: 97, lh: 67.7 };
  SHEET.left = (SHEET.w - SHEET.cols * SHEET.lw) / 2;
  SHEET.top = (SHEET.h - SHEET.rows * SHEET.lh) / 2;
  const PER = SHEET.cols * SHEET.rows;
  const PAD = 9; // mm Abstand der Adresse zum Etikettenrand
  const STAMP_INSET = 5;

  const LIBS = {
    jspdf: "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
    xlsx: "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
  };

  const COUNTRY = {
    deutschland: "", germany: "", de: "", "": "",
    england: "GROSSBRITANNIEN", "united kingdom": "GROSSBRITANNIEN", uk: "GROSSBRITANNIEN", "großbritannien": "GROSSBRITANNIEN",
    belgium: "BELGIEN", belgien: "BELGIEN",
    "the netherlands": "NIEDERLANDE", netherlands: "NIEDERLANDE", niederlande: "NIEDERLANDE",
    frankreich: "FRANKREICH", france: "FRANKREICH",
    tschechien: "TSCHECHIEN", "czech republic": "TSCHECHIEN",
    schweiz: "SCHWEIZ", switzerland: "SCHWEIZ", "österreich": "ÖSTERREICH", austria: "ÖSTERREICH",
  };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const api = () => window.ROOTS_PRINT_API;
  const relay = () => window.RootsPrintRelay;

  const st = { lists: [], list: null, rows: [], loaded: false, libs: {} };

  function loadLib(name) {
    if (st.libs[name]) return st.libs[name];
    if ((name === "jspdf" && window.jspdf) || (name === "xlsx" && window.XLSX)) return (st.libs[name] = Promise.resolve());
    st.libs[name] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = LIBS[name];
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

  function country(c) {
    const k = String(c || "").trim().toLowerCase();
    return k in COUNTRY ? COUNTRY[k] : String(c).trim().toUpperCase();
  }

  function lines(r) {
    const out = [r.name];
    if (r.company && String(r.kind || "").toLowerCase() !== "privat") out.push(r.company);
    out.push(r.street, r.city);
    const c = country(r.country);
    return { lines: out.filter(Boolean), country: c };
  }

  function selection() {
    const s = settings();
    const pick = st.rows.filter((r) => (s.filter === "all" || r[s.filter]) && (!s.owner || r.owner === s.owner));
    return {
      s,
      ok: pick.filter((r) => r.street && r.city),
      missing: pick.filter((r) => !r.street || !r.city),
    };
  }

  /* -------------------------------------------------------------- render --- */

  function renderInfo() {
    const { s, ok, missing } = selection();
    const sheets = ok.length ? Math.ceil((ok.length + s.start - 1) / PER) : 0;
    $("#lbl-count").textContent = ok.length ? `${ok.length} Etiketten · ${sheets} ${sheets === 1 ? "Bogen" : "Bögen"}` : "Keine Adressen";
    $("#lbl-missing").innerHTML = missing.length ? `<strong>Ohne Straße oder Ort:</strong> ${missing.map((r) => esc(r.name)).join(", ")}` : "";
    $("#lbl-missing").classList.toggle("hidden", !missing.length);
    $("#lbl-test").disabled = $("#lbl-all").disabled = !ok.length;
    renderPreview(ok.slice(0, PER - s.start + 1), s);
  }

  function renderPreview(rows, s) {
    const scale = $("#lbl-preview").clientWidth / SHEET.w || 2.5;
    const items = Array(s.start - 1).fill(null).concat(rows);
    let html = "";
    for (let i = 0; i < PER; i++) {
      const x = SHEET.left + (i % SHEET.cols) * SHEET.lw;
      const y = SHEET.top + Math.floor(i / SHEET.cols) * SHEET.lh;
      const r = items[i];
      let inner = "";
      if (r) {
        const l = lines(r);
        inner =
          `<div class="lbl-stamp" style="top:${STAMP_INSET * scale}px;right:${STAMP_INSET * scale}px;width:${s.sw * scale}px;height:${s.sh * scale}px"></div>` +
          `<div class="lbl-addr" style="left:${PAD * scale}px;right:${PAD * scale}px;bottom:${PAD * scale}px;font-size:${s.fs * 0.3528 * scale}px">` +
          l.lines.map((t) => `<div>${esc(t)}</div>`).join("") +
          (l.country ? `<div class="lbl-cty">${esc(l.country)}</div>` : "") +
          `</div>`;
      }
      html += `<div class="lbl-cell${r ? "" : " empty"}" style="left:${x * scale}px;top:${y * scale}px;width:${SHEET.lw * scale}px;height:${SHEET.lh * scale}px">${inner}</div>`;
    }
    $("#lbl-preview").style.height = SHEET.h * scale + "px";
    $("#lbl-preview").innerHTML = html;
  }

  /* ----------------------------------------------------------------- pdf --- */

  async function buildPdf(testOnly) {
    await loadLib("jspdf");
    const { jsPDF } = window.jspdf;
    const { s, ok } = selection();
    let items = Array(s.start - 1).fill(null).concat(ok);
    if (testOnly) items = items.slice(0, PER);
    const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
    doc.setFont("helvetica", "normal");
    const lh = s.fs * 0.3528 * 1.3;
    const maxW = SHEET.lw - 2 * PAD;
    for (let p = 0; p < items.length; p += PER) {
      if (p) doc.addPage();
      for (let i = 0; i < PER && p + i < items.length; i++) {
        const r = items[p + i];
        if (!r) continue;
        const x = SHEET.left + (i % SHEET.cols) * SHEET.lw + s.dx + PAD;
        const yBottom = SHEET.top + Math.floor(i / SHEET.cols) * SHEET.lh + s.dy + SHEET.lh - PAD;
        const l = lines(r);
        const all = l.lines.map((t) => ({ t, b: false })).concat(l.country ? [{ t: l.country, b: true }] : []);
        all.forEach((row, k) => {
          let size = s.fs;
          doc.setFont("helvetica", row.b ? "bold" : "normal");
          doc.setFontSize(size);
          while (doc.getTextWidth(row.t) > maxW && size > 7) doc.setFontSize((size -= 0.5));
          const y = yBottom - (all.length - 1 - k) * lh;
          doc.text(row.t, x, y, { baseline: "bottom" });
        });
      }
    }
    return doc.output("blob");
  }

  async function print(testOnly) {
    const printerId = api().selValue("lbl-printer");
    const printer = api().printers().find((p) => String(p.id) === String(printerId));
    if (!printer) return api().note("#lbl-result", "err", "Kein Drucker gewählt.");
    let blob;
    try {
      blob = await buildPdf(testOnly);
    } catch (e) {
      return api().note("#lbl-result", "err", e.message || "PDF konnte nicht erstellt werden.");
    }
    const options = { PageSize: "A4", Duplex: "None", "print-scaling": "none", "fit-to-page": "false" };
    const slot = api().selValue("lbl-slot");
    if (slot) options.InputSlot = slot;
    const name = (testOnly ? "Etiketten_Test_" : "Etiketten_") + String(st.list || "Liste").replace(/[^A-Za-z0-9_-]+/g, "_") + ".pdf";
    await api().print(blob, name, { printer, options, copies: "1", result: "#lbl-result", button: testOnly ? "#lbl-test" : "#lbl-all" });
  }

  async function download() {
    try {
      const blob = await buildPdf(false);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "Etiketten_" + String(st.list || "Liste").replace(/[^A-Za-z0-9_-]+/g, "_") + ".pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      api().note("#lbl-result", "err", e.message || "PDF konnte nicht erstellt werden.");
    }
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
      api().note("#lbl-result", "ok", `${n} Adressen in „${esc(list)}“ gespeichert.`, `Blatt ${esc(sheetName)}`);
      st.list = list;
      await refreshLists();
    } catch (e) {
      api().note("#lbl-result", "err", e.message || "Import fehlgeschlagen.", e.hint || null);
    } finally {
      $("#lbl-file").value = "";
    }
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
        loadRows();
      },
    });
    if (!$("#lbl-listname").value) $("#lbl-listname").value = st.list || "Xmas " + new Date().getFullYear();
    await loadRows();
  }

  async function loadRows() {
    st.rows = st.list ? await relay().labelAddresses(st.list) : [];
    const owners = [...new Set(st.rows.map((r) => r.owner).filter(Boolean))].sort();
    api().makeSelect("lbl-owner", { options: [{ value: "", label: "Alle" }].concat(owners.map((o) => ({ value: o, label: o }))), value: "", onChange: renderInfo });
    renderInfo();
  }

  function fillPrinters() {
    const printers = api().printers();
    api().makeSelect("lbl-printer", {
      options: printers.map((p) => ({ value: p.id, label: (p.display_name || p.queue) + (p.is_default ? " · Standard" : "") })),
      value: api().defaultPrinterId(),
      placeholder: "Kein Drucker gemeldet",
      onChange: fillSlots,
    });
    fillSlots();
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
      onChange: renderInfo,
    });
    ["#lbl-start", "#lbl-fs", "#lbl-dx", "#lbl-dy", "#lbl-sw", "#lbl-sh"].forEach((id) => $(id).addEventListener("input", renderInfo));
    $("#lbl-test").addEventListener("click", () => print(true));
    $("#lbl-all").addEventListener("click", () => print(false));
    $("#lbl-pdf").addEventListener("click", download);
    $("#lbl-import").addEventListener("click", () => $("#lbl-file").click());
    $("#lbl-file").addEventListener("change", (e) => importFile(e.target.files[0]));
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
    } catch (e) {
      $("#nav-labels")?.classList.add("hidden");
    }
  }

  window.ROOTS_LABELS = { open, probe };
})();
