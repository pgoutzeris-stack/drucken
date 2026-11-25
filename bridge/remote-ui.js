/**
 * Canon Remote UI (i-SENSYS MF7xx) - Lesen und Schreiben über die Weboberfläche.
 *
 * Der Drucker meldet per IPP nur media-type "auto"; Papiertyp und Status gibt es
 * nur über seine Weboberfläche. Der Agent meldet sich dort im allgemeinen
 * Anwendermodus an (ohne PIN) oder, falls im Vault eine PIN steht, als
 * Systemmanager. Ohne Abhängigkeiten, nur node:http.
 *
 * Zugangsdaten kommen pro Auftrag aus dem Supabase Vault (print_device_<queue>),
 * nie aus dem Repo.
 */
"use strict";

const http = require("http");

const TIMEOUT_MS = 15000;

// Papierfelder auf p_paper_edit.html: Fach -> Feldnamen
const TRAYS = [
  { id: "mp", label: "Mehrzweckfach", size: "i0100", type: "i0101" },
  { id: "c1", label: "Kassette 1", size: "i0102", type: "i0103" },
];

function decode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
const text = (html) => decode(String(html || "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

class RemoteUi {
  constructor(device) {
    const url = new URL(String(device?.url || ""));
    if (url.protocol !== "http:") throw new Error("Remote UI: nur http:// im lokalen Netz.");
    this.host = url.hostname;
    this.port = Number(url.port || 80);
    this.pin = String(device?.pin || "");
    this.cookies = new Map();
  }

  request(method, path, { body, referer } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { "User-Agent": "ROOTS-Print-Agent", Accept: "text/html" };
      if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      if (referer) headers.Referer = `http://${this.host}${referer}`;
      if (body != null) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        headers["Content-Length"] = Buffer.byteLength(body);
      }
      const req = http.request({ host: this.host, port: this.port, path, method, headers, timeout: TIMEOUT_MS }, (res) => {
        for (const c of res.headers["set-cookie"] || []) {
          const [pair] = c.split(";");
          const i = pair.indexOf("=");
          if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        }
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location || "", body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("timeout", () => req.destroy(new Error("Drucker antwortet nicht (Zeitüberschreitung).")));
      req.on("error", (e) => reject(Object.assign(new Error(`Drucker nicht erreichbar: ${e.message}`), { hint: "Ist der Mac mit dem Agenten im selben Netz wie der Drucker?" })));
      if (body != null) req.write(body);
      req.end();
    });
  }

  async login() {
    await this.request("GET", "/");
    const form = this.pin ? `i0012=1&i2101=${encodeURIComponent(this.pin)}` : "i0017=2&i0019=";
    const res = await this.request("POST", "/checkLogin.cgi", { body: form, referer: "/" });
    if (res.status !== 302 || !/portal_top/.test(res.location)) {
      throw Object.assign(new Error("Anmeldung an der Remote UI fehlgeschlagen."), { hint: "Zugang im Supabase Vault prüfen (print_device_<Warteschlange>)." });
    }
    await this.request("GET", "/portal_top.html", { referer: "/" });
  }

  async get(path, referer) {
    const res = await this.request("GET", path, { referer });
    if (/t_sessError|checkLogin|loginFrm/.test(res.location + res.body.slice(0, 4000)) && !/fCommonEdit|deviceStatusModule|PaperSource/.test(res.body)) {
      throw new Error("Remote UI hat die Sitzung abgewiesen.");
    }
    return res.body;
  }

  /* -------------------------------------------------------------- status --- */

  async status() {
    const html = await this.get("/portal_top.html", "/");
    const rows = (block) => [...String(block || "").matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => text(c[1])));
    const section = (id) => (html.match(new RegExp(`id="${id}"[\\s\\S]*?(?=<div id="[a-zA-Z]+Module"|<div id="linkInformationModule")`)) || [""])[0];

    const devices = rows(section("deviceStatusModule").replace(/<!--[\s\S]*?-->/g, ""))
      .filter((r) => r.length >= 2 && r[0])
      .map(([name, state]) => ({ name: name.replace(/:$/, ""), state }));
    const errBlock = section("deviceErrorInfoModule");
    const errors = text(errBlock.replace(/<h5>[\s\S]*?<\/h5>/, ""));
    const paper = rows(section("paperInfomationModule").replace(/<!--[\s\S]*?-->/g, "").replace(/<thead>[\s\S]*?<\/thead>/, ""))
      .filter((r) => r.length >= 4 && r[0])
      .map(([source, level, size, type]) => ({ source, level, size, type }));
    const toner = rows(section("tonerInfomationModule").replace(/<thead>[\s\S]*?<\/thead>/, ""))
      .filter((r) => r.length >= 3 && r[0])
      .map((r) => ({ color: r[0], percent: parseInt(r[r.length - 1], 10) }))
      .filter((t) => Number.isFinite(t.percent));
    return { devices, errors: /keine fehler/i.test(errors) ? [] : errors ? [errors] : [], paper, toner, checkedAt: new Date().toISOString() };
  }

  /* --------------------------------------------------------------- paper --- */

  async paperForm() {
    await this.get("/p_paper.html", "/portal_top.html");
    const html = await this.get("/p_paper_edit.html", "/p_paper.html");
    const form = (html.match(/<form[^>]*name="fCommonEdit"[\s\S]*?<\/form>/) || [""])[0];
    if (!form) throw new Error("Papierformular nicht gefunden.");
    const action = (form.match(/action="([^"]+)"/) || [])[1] || "/cgi/p_paper_edit.cgi";
    const token = (form.match(/name="iToken" value="([^"]*)"/) || [])[1] || "";
    const selects = {};
    for (const m of form.matchAll(/<select[^>]*name="(i\d+)"[^>]*>([\s\S]*?)<\/select>/g)) {
      const options = [...m[2].matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)/g)].map((o) => ({ value: o[1], label: decode(o[3]).trim(), selected: /selected/.test(o[2]) }));
      selects[m[1]] = { options, value: (options.find((o) => o.selected) || {}).value ?? null };
    }
    const askOnLoad = !/name="i0011" id="i0011B" value="0"[^>]*checked/.test(form) ? false : true;
    return { action, token, selects, askOnLoad };
  }

  async paper() {
    const f = await this.paperForm();
    return {
      trays: TRAYS.map((t) => ({
        id: t.id,
        label: t.label,
        size: f.selects[t.size]?.value ?? null,
        type: f.selects[t.type]?.value ?? null,
        sizes: (f.selects[t.size]?.options || []).filter((o) => o.label && o.value !== "0").map(({ value, label }) => ({ value, label })),
        types: (f.selects[t.type]?.options || []).map(({ value, label }) => ({ value, label })),
      })),
      checkedAt: new Date().toISOString(),
    };
  }

  /** values: { mp: { size, type }, c1: { size, type } } - nur Format und Papiertyp. */
  async paperSet(values) {
    const f = await this.paperForm();
    const fields = { iToken: f.token, i0011: "1" };
    for (const t of TRAYS) {
      const want = (values || {})[t.id] || {};
      for (const key of ["size", "type"]) {
        const name = t[key];
        const sel = f.selects[name];
        if (!sel) continue;
        const v = want[key] != null ? String(want[key]) : sel.value;
        if (!sel.options.some((o) => o.value === v)) throw new Error(`Unbekannter Wert für ${t.label}: ${v}`);
        fields[name] = v;
      }
    }
    const body = Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const res = await this.request("POST", f.action, { body, referer: "/p_paper_edit.html" });
    if (res.status !== 302 || !/p_paper\.html/.test(res.location)) {
      throw Object.assign(new Error("Der Drucker hat die Einstellung nicht übernommen."), { hint: text(res.body).slice(0, 200) || null });
    }
    return this.paper();
  }
}

async function runDeviceAction(device, settings) {
  if (!device || device.type !== "canon-remote-ui") {
    throw Object.assign(new Error("Für diesen Drucker ist keine Weboberfläche hinterlegt."), { hint: "Im Supabase Vault einen Eintrag print_device_<Warteschlange> anlegen." });
  }
  const ui = new RemoteUi(device);
  await ui.login();
  switch (settings?.action) {
    case "status":
      return { status: await ui.status() };
    case "paper":
      return { paper: await ui.paper(), status: await ui.status() };
    case "paper_set":
      return { paper: await ui.paperSet(settings.values), status: await ui.status() };
    default:
      throw new Error("Unbekannte Geräteaktion.");
  }
}

module.exports = { RemoteUi, runDeviceAction };
