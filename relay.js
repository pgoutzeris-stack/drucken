/**
 * Relay-Client: dieselben Aufgaben wie der lokale Helfer, nur über Supabase.
 *
 * Der Browser legt Aufträge in der Warteschlange ab; der Agent im Büro arbeitet
 * sie ab und schreibt Ergebnisseiten zurück. Damit funktioniert das Tool auch
 * dort, wo der Browser 127.0.0.1 nicht erreichen darf — Safari, die Mac-App,
 * das Handy, von zuhause.
 */
window.RootsPrintRelay = (function () {
  "use strict";

  let sb = null;
  let brokered = false;

  const AGENT_STALE_MS = 5 * 60 * 1000;

  /** Mit Sitzung: direkte Aufrufe. Tokenlos im iframe: ueber den Intranet-Broker. */
  function use(client) {
    sb = client;
    brokered = false;
  }

  function useBroker() {
    sb = null;
    brokered = true;
  }

  async function broker(payload) {
    const request = window.RootsUserBridge?.request;
    if (!request) throw fail("Die Intranet-Brücke ist nicht geladen.", "Seite im Intranet neu laden.");
    try {
      return await request("print", payload);
    } catch (e) {
      throw translate(e);
    }
  }

  function fail(message, hint) {
    const e = new Error(message);
    e.hint = hint || null;
    return e;
  }

  /** PostgREST-Fehler in Text übersetzen, den ein Mensch lesen kann. */
  function translate(error) {
    const raw = String(error?.message || error || "");
    if (/Kein ROOTS-Profil/i.test(raw)) return fail("Dieses Konto hat kein Profil im Intranet.", "Ein Admin muss das Konto im Intranet anlegen.");
    if (/Drucker unbekannt|Scanner unbekannt/i.test(raw)) return fail("Dieser Drucker ist nicht mehr gemeldet.", "Liste neu laden. Läuft der Agent im Büro noch?");
    if (/groesser als|größer als/i.test(raw)) return fail("Die Datei ist größer als 25 MB.", "Über den Relay sind 25 MB die Grenze. Größere Dateien direkt am Helfer drucken.");
    if (/Nur Admins/i.test(raw)) return fail("Nur Admins dürfen Agenten freischalten.");
    if (/Bruecke ist nicht geladen|Brücke ist nicht geladen/i.test(raw)) return fail("Die Intranet-Brücke ist nicht geladen.", "Seite im Intranet neu laden.");
    if (/zu lange gedauert/i.test(raw)) return fail("Das Intranet hat nicht rechtzeitig geantwortet.", "Erneut versuchen. Bei Scans mit vielen Seiten kann es dauern.");
    if (/Tool-Session ist veraltet|Identitaet|Identität/i.test(raw)) return fail("Die Sitzung des Intranets ist veraltet.", "Im Intranet neu laden, danach das Tool erneut öffnen.");
    if (/Nicht angemeldet/i.test(raw)) return fail("Das Intranet meldet keine Anmeldung.", "Im Intranet neu anmelden.");
    if (/Failed to fetch|NetworkError/i.test(raw)) return fail("Supabase ist nicht erreichbar.", "Netzverbindung prüfen und erneut versuchen.");
    return fail(raw || "Unbekannter Fehler in der Warteschlange.");
  }

  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw translate(error);
    return data;
  }

  async function printers() {
    let data;
    if (brokered) {
      data = (await broker({ op: "printers" })).printers;
    } else {
      const res = await sb.from("print_printers").select("*").order("display_name");
      if (res.error) throw translate(res.error);
      data = res.data;
    }
    const agents = await agentList();
    const fresh = new Map(agents.map((a) => [a.id, a]));
    return (data || []).map((p) => {
      const agent = fresh.get(p.agent_id) || null;
      const seen = agent?.last_seen_at ? Date.parse(agent.last_seen_at) : 0;
      return { ...p, agent, agentOnline: !!seen && Date.now() - seen < AGENT_STALE_MS };
    });
  }

  async function agentList() {
    try {
      if (brokered) return (await broker({ op: "agents" })).agents || [];
      return (await rpc("print_list_agents", {})) || [];
    } catch (e) {
      return [];
    }
  }

  async function submitPrint(printerId, file, filename, settings) {
    const data = await blobToBase64(file);
    if (brokered) return (await broker({ op: "submit_print", printerId, filename, data, settings: settings || {} })).jobId;
    return rpc("print_submit_print_job", { p_printer_id: printerId, p_filename: filename, p_data: data, p_settings: settings || {} });
  }

  async function submitScan(printerId, settings) {
    if (brokered) return (await broker({ op: "submit_scan", printerId, settings: settings || {} })).jobId;
    return rpc("print_submit_scan_job", { p_printer_id: printerId, p_settings: settings || {} });
  }

  async function jobs() {
    if (brokered) return (await broker({ op: "jobs" })).jobs || [];
    const { data, error } = await sb.from("print_jobs").select("*").order("created_at", { ascending: false }).limit(25);
    if (error) throw translate(error);
    return data || [];
  }

  async function job(jobId) {
    if (brokered) return (await broker({ op: "job", jobId })).job;
    const { data, error } = await sb.from("print_jobs").select("*").eq("id", jobId).maybeSingle();
    if (error) throw translate(error);
    if (!data) throw fail("Dieser Auftrag ist nicht mehr da.", "Aufträge werden nach drei Tagen gelöscht.");
    const { data: pages, error: pe } = await sb.from("print_job_pages").select("*").eq("job_id", jobId).order("idx");
    if (pe) throw translate(pe);
    return { ...data, pages: pages || [] };
  }

  /** Wartet auf das Ende eines Auftrags und meldet jede neue Seite. */
  async function waitFor(jobId, onProgress, { timeoutMs = 300000, everyMs = 1500 } = {}) {
    const started = Date.now();
    let seen = -1;
    for (;;) {
      const state = await job(jobId);
      if (state.pages.length !== seen) {
        seen = state.pages.length;
        onProgress?.(state);
      }
      if (state.status === "done" || state.status === "error") return state;
      if (Date.now() - started > timeoutMs) {
        throw fail("Der Auftrag ist nicht fertig geworden.", "Am Gerät nachsehen. Der Agent im Büro könnte beendet sein.");
      }
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }

  async function pageBlob(page) {
    const b64 = brokered ? (await broker({ op: "page", pageId: page.id })).data : await rpc("print_job_page", { p_page_id: page.id });
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: page.mime });
  }

  async function registerAgent(name, tokenHash) {
    const hash = String(tokenHash || "").trim().toLowerCase();
    if (brokered) return (await broker({ op: "register_agent", name, tokenHash: hash })).agentId;
    return rpc("print_register_agent", { p_name: name, p_token_hash: hash });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(fail("Die Datei konnte nicht gelesen werden."));
      reader.readAsDataURL(blob);
    });
  }

  return { use, useBroker, printers, agentList, submitPrint, submitScan, jobs, job, waitFor, pageBlob, registerAgent, AGENT_STALE_MS };
})();
