/**
 * Minimaler IPP-Client (RFC 8010/8011).
 *
 * Für den Agenten auf einer Cloud-Maschine: dort ist kein CUPS und kein
 * Canon-Treiber vorhanden, und `lpadmin -m everywhere` scheitert an der
 * Attributantwort dieses Geräts. Der Drucker nimmt laut eigener mDNS-Auskunft
 * PDF, JPEG und PWG-Raster direkt an — also sprechen wir IPP selbst.
 */

"use strict";

const http = require("http");

const TAG = {
  operation: 0x01,
  job: 0x02,
  end: 0x03,
  printer: 0x04,
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  octetString: 0x30,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
  nameWithoutLanguage: 0x42,
  textWithoutLanguage: 0x41,
  rangeOfInteger: 0x33,
  resolution: 0x32,
};

const OP = { printJob: 0x0002, getJobs: 0x000a, cancelJob: 0x0008, getPrinterAttributes: 0x000b };

function attr(tag, name, value) {
  const nameBuf = Buffer.from(name, "utf8");
  let valueBuf;
  if (tag === TAG.integer || tag === TAG.enum) {
    valueBuf = Buffer.alloc(4);
    valueBuf.writeInt32BE(Number(value), 0);
  } else if (tag === TAG.boolean) {
    valueBuf = Buffer.from([value ? 1 : 0]);
  } else {
    valueBuf = Buffer.from(String(value), "utf8");
  }
  const out = Buffer.alloc(1 + 2 + nameBuf.length + 2 + valueBuf.length);
  let o = 0;
  out.writeUInt8(tag, o++);
  out.writeUInt16BE(nameBuf.length, o);
  o += 2;
  nameBuf.copy(out, o);
  o += nameBuf.length;
  out.writeUInt16BE(valueBuf.length, o);
  o += 2;
  valueBuf.copy(out, o);
  return out;
}

/** Zusatzwert derselben Attributgruppe: Name der Länge 0. */
function additional(tag, value) {
  return attr(tag, "", value);
}

function request(op, requestId, groups, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt8(1, 0); // version-major
  head.writeUInt8(1, 1); // version-minor
  head.writeUInt16BE(op, 2);
  head.writeInt32BE(requestId, 4);
  return Buffer.concat([head, ...groups, Buffer.from([TAG.end]), payload || Buffer.alloc(0)]);
}

/** Antwort nur so weit lesen, wie es der Agent braucht: Status und job-id. */
function parseResponse(buf) {
  const statusCode = buf.readUInt16BE(2);
  const out = { statusCode, ok: statusCode < 0x0100, jobId: null, jobState: null, statusMessage: null };
  let o = 8;
  let name = "";
  while (o < buf.length) {
    const tag = buf.readUInt8(o++);
    if (tag === TAG.end) break;
    if (tag <= 0x05) continue; // Gruppenwechsel
    const nameLen = buf.readUInt16BE(o);
    o += 2;
    const thisName = buf.slice(o, o + nameLen).toString("utf8");
    o += nameLen;
    const valueLen = buf.readUInt16BE(o);
    o += 2;
    const value = buf.slice(o, o + valueLen);
    o += valueLen;
    if (nameLen) name = thisName;
    if (name === "job-id" && valueLen === 4) out.jobId = value.readInt32BE(0);
    if (name === "job-state" && valueLen === 4) out.jobState = value.readInt32BE(0);
    if (name === "status-message") out.statusMessage = value.toString("utf8");
  }
  return out;
}

function send(host, path, body, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const [hostname, port] = String(host).split(":");
    const req = http.request(
      { hostname, port: Number(port) || 631, path, method: "POST", timeout, headers: { "Content-Type": "application/ipp", "Content-Length": body.length } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode !== 200 || buf.length < 8) {
            reject(Object.assign(new Error(`Drucker antwortete mit HTTP ${res.statusCode}.`), { hint: "IPP-Adresse prüfen: http://<IP>:631/ipp/print" }));
            return;
          }
          resolve(parseResponse(buf));
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Der Drucker hat nicht geantwortet.")));
    req.on("error", (e) => reject(Object.assign(new Error(`Verbindung zum Drucker fehlgeschlagen: ${e.message}`), { hint: "Ist die Adresse erreichbar (im Tunnel: ping auf die IP)?" })));
    req.end(body);
  });
}

const IPP_COLOR = { RGB: "color", Gray: "monochrome", Gray16: "monochrome", color: "color", monochrome: "monochrome" };
const IPP_SIDES = { None: "one-sided", DuplexNoTumble: "two-sided-long-edge", DuplexTumble: "two-sided-short-edge" };
const IPP_MEDIA = { A4: "iso_a4_210x297mm", A5: "iso_a5_148x210mm", Letter: "na_letter_8.5x11in", Legal: "na_legal_8.5x14in", B5: "iso_b5_176x250mm" };

let requestId = 1;

/**
 * Schickt eine Datei direkt an den Drucker. `mime` muss das Gerät können —
 * application/pdf, image/jpeg und image/pwg-raster melden diese Canon-Geräte.
 */
async function printJob(host, { data, mime = "application/pdf", jobName = "ROOTS Print", copies = 1, options = {}, user = "roots-print", hold = false }) {
  const groups = [
    Buffer.concat([
      Buffer.from([TAG.operation]),
      attr(TAG.charset, "attributes-charset", "utf-8"),
      attr(TAG.naturalLanguage, "attributes-natural-language", "de"),
      attr(TAG.uri, "printer-uri", `ipp://${host}/ipp/print`),
      attr(TAG.nameWithoutLanguage, "requesting-user-name", user),
      attr(TAG.nameWithoutLanguage, "job-name", jobName),
      attr(TAG.mimeMediaType, "document-format", mime),
    ]),
  ];

  const job = [Buffer.from([TAG.job]), attr(TAG.integer, "copies", Math.max(1, Math.min(99, Number(copies) || 1)))];
  const color = IPP_COLOR[options.ColorModel];
  if (color) job.push(attr(TAG.keyword, "print-color-mode", color));
  const sides = IPP_SIDES[options.Duplex];
  if (sides) job.push(attr(TAG.keyword, "sides", sides));
  const media = IPP_MEDIA[options.PageSize];
  if (media) job.push(attr(TAG.keyword, "media", media));
  if (options.InputSlot && options.InputSlot !== "auto") job.push(attr(TAG.keyword, "media-source", options.InputSlot));
  if (options.Collate) job.push(attr(TAG.boolean, "multiple-document-handling", false));
  if (hold) job.push(attr(TAG.keyword, "job-hold-until", "indefinite"));
  groups.push(Buffer.concat(job));

  const res = await send(host, "/ipp/print", request(OP.printJob, requestId++, groups, data));
  if (!res.ok) {
    throw Object.assign(new Error(`Der Drucker lehnte den Auftrag ab (IPP 0x${res.statusCode.toString(16)}${res.statusMessage ? ": " + res.statusMessage : ""}).`), {
      hint: "Format prüfen — sicher sind PDF und JPEG. Bei 0x400 ff. meldet das Gerät ein Problem im Display.",
    });
  }
  return { jobId: res.jobId, statusCode: res.statusCode };
}

async function cancelJob(host, jobId, user = "roots-print") {
  const groups = [
    Buffer.concat([
      Buffer.from([TAG.operation]),
      attr(TAG.charset, "attributes-charset", "utf-8"),
      attr(TAG.naturalLanguage, "attributes-natural-language", "de"),
      attr(TAG.uri, "printer-uri", `ipp://${host}/ipp/print`),
      attr(TAG.integer, "job-id", jobId),
      attr(TAG.nameWithoutLanguage, "requesting-user-name", user),
    ]),
  ];
  const res = await send(host, "/ipp/print", request(OP.cancelJob, requestId++, groups));
  return { ok: res.ok, statusCode: res.statusCode };
}

module.exports = { printJob, cancelJob, additional };
