/**
 * ROOTS Print - Druckereinstellungen.
 *
 * Der Browser erreicht die Weboberfläche des Druckers nicht (HTTPS-Seite, lokales
 * Netz). Deshalb läuft alles als Auftrag "device" über den Agenten, der sich im
 * Hintergrund an der Remote UI anmeldet. Zugang liegt im Supabase Vault.
 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const api = () => window.ROOTS_PRINT_API;
  const relay = () => window.RootsPrintRelay;

  const st = { paper: null, status: null, busy: false, wired: false };

  const printer = () => api().printers().find((p) => String(p.id) === String(api().selValue("dev-printer"))) || null;

  async function run(settings, label) {
    const p = printer();
    if (!p) throw new Error("Kein Drucker gewählt.");
    if (p.agentOnline === false) throw Object.assign(new Error("Der Druck-Agent ist offline."), { hint: "Auf dem Mac mit dem Drucker muss der Agent laufen." });
    api().note("#dev-result", "info", label + "…");
    const jobId = await relay().submitDevice(p.id, settings);
    const done = await relay().waitFor(jobId, null, { timeoutMs: 60000, everyMs: 1000 });
    if (done.status === "error") throw done.error || new Error("Der Drucker hat nicht geantwortet.");
    return done.result || {};
  }

  function setBusy(on) {
    st.busy = on;
    ["#dev-reload", "#dev-save"].forEach((id) => $(id) && ($(id).disabled = on));
    $("#dev-panel")?.classList.toggle("busy", on);
  }

  async function load() {
    if (st.busy) return;
    setBusy(true);
    try {
      const r = await run({ action: "paper" }, "Drucker wird abgefragt");
      st.paper = r.paper;
      st.status = r.status;
      render();
      api().note("#dev-result", "ok", "Stand vom Drucker gelesen.");
    } catch (e) {
      api().note("#dev-result", "err", e.message || "Abfrage fehlgeschlagen.", e.hint || null);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (st.busy || !st.paper) return;
    const values = {};
    const changes = [];
    st.paper.trays.forEach((t) => {
      const size = api().selValue("dev-size-" + t.id);
      const type = api().selValue("dev-type-" + t.id);
      values[t.id] = { size, type };
      if (size !== t.size) changes.push(`${t.label}: Format ${label(t.sizes, size)}`);
      if (type !== t.type) changes.push(`${t.label}: ${label(t.types, type)}`);
    });
    if (!changes.length) return api().note("#dev-result", "info", "Keine Änderung.");
    setBusy(true);
    try {
      const r = await run({ action: "paper_set", values }, "Einstellung wird übertragen");
      st.paper = r.paper;
      st.status = r.status;
      render();
      api().note("#dev-result", "ok", "Am Drucker gespeichert.", esc(changes.join(" · ")));
    } catch (e) {
      api().note("#dev-result", "err", e.message || "Speichern fehlgeschlagen.", e.hint || null);
    } finally {
      setBusy(false);
    }
  }

  const label = (list, v) => (list || []).find((o) => o.value === v)?.label || v;

  function render() {
    const s = st.status;
    $("#dev-state").innerHTML = s
      ? (s.devices || []).map((d) => `<div class="dev-kv"><span>${esc(d.name)}</span>${esc(d.state)}</div>`).join("") +
        `<div class="dev-kv"><span>Fehler</span>${s.errors?.length ? `<b class="dev-err">${esc(s.errors.join(", "))}</b>` : "Keine"}</div>` +
        `<div class="dev-kv"><span>Abgefragt</span>${new Date(s.checkedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}</div>`
      : "";
    const colors = { Cyan: "#06b6d4", Magenta: "#d946ef", Gelb: "#eab308", Schwarz: "#111827" };
    $("#dev-toner").innerHTML = (s?.toner || [])
      .map(
        (t, i) =>
          `<div class="dev-toner"><span>${esc(t.color)}</span><div class="dev-bar"><div style="width:${Math.max(0, Math.min(100, t.percent))}%;background:${colors[t.color] || "var(--brand)"};transition-delay:${i * 60}ms"></div></div><b>${t.percent} %</b></div>`
      )
      .join("");
    const level = new Map((s?.paper || []).map((p) => [p.source, p.level]));
    const trays = st.paper?.trays || [];
    $("#dev-trays").innerHTML = trays
      .map(
        (t) =>
          `<div class="dev-tray"><div class="dev-tray-head"><h3>${esc(t.label)}</h3><span class="lbl-count">${esc(level.get(t.label) === "Ohne" ? "Leer" : level.get(t.label) || "")}</span></div>` +
          `<div class="grid"><div><label class="field-label">Papiertyp</label><div class="select" id="dev-type-${esc(t.id)}"></div></div>` +
          `<div><label class="field-label">Format</label><div class="select" id="dev-size-${esc(t.id)}"></div></div></div></div>`
      )
      .join("");
    trays.forEach((t) => {
      api().makeSelect("dev-type-" + t.id, { options: t.types, value: t.type });
      api().makeSelect("dev-size-" + t.id, { options: t.sizes, value: t.size });
    });
    $("#dev-save").classList.toggle("hidden", !trays.length);
    requestAnimationFrame(() => document.querySelectorAll(".dev-bar div").forEach((b) => b.classList.add("in")));
  }

  function wire() {
    if (st.wired) return;
    st.wired = true;
    $("#dev-reload").addEventListener("click", load);
    $("#dev-save").addEventListener("click", save);
  }

  function open() {
    wire();
    const printers = api().printers();
    api().makeSelect("dev-printer", {
      options: printers.map((p) => ({ value: p.id, label: p.display_name || p.queue })),
      value: api().selValue("dev-printer") || api().defaultPrinterId(),
      placeholder: "Kein Drucker gemeldet",
      onChange: load,
    });
    if (!st.paper) load();
  }

  window.ROOTS_DEVICE = { open };
})();
