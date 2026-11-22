// Builds downloadable files from what the AI writes. Everything runs in the browser: nothing is executed or uploaded.
(function (root) {
  "use strict";
  const MAX_BYTES = 1500000;
  const enc = new TextEncoder();
  const u8 = (s) => enc.encode(s);
  const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  /* ---- names */
  function safeName(raw) {
    let n = String(raw || "").split("\n")[0].replace(/^\s*(file(name)?\s*:)\s*/i, "").replace(/[`"'*]/g, "").trim();
    n = n.replace(/\\/g, "/").split("/").filter((p) => p && p !== "." && p !== "..").map((p) => p.replace(/[<>:"|?*\u0000-\u001F]/g, "_").slice(0, 80)).join("/");
    if (!n) n = "file.txt";
    if (!/\.[A-Za-z0-9]{1,8}$/.test(n)) n += ".txt";
    return n.slice(0, 120);
  }
  const extOf = (n) => (n.match(/\.([A-Za-z0-9]+)$/) || [, ""])[1].toLowerCase();

  /* ---- zip (store method) */
  const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zipBytes(entries) { // entries: [{name, data: Uint8Array}]
    const now = new Date(), dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF, dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    const parts = [], central = []; let offset = 0;
    const w16 = (v, n) => { v.push(n & 255, (n >>> 8) & 255); }, w32 = (v, n) => { v.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255); };
    entries.forEach((e) => {
      const name = u8(e.name), crc = crc32(e.data), h = [];
      w32(h, 0x04034b50); w16(h, 20); w16(h, 0x0800); w16(h, 0); w16(h, dt); w16(h, dd); w32(h, crc); w32(h, e.data.length); w32(h, e.data.length); w16(h, name.length); w16(h, 0);
      parts.push(Uint8Array.from(h), name, e.data);
      const c = [];
      w32(c, 0x02014b50); w16(c, 20); w16(c, 20); w16(c, 0x0800); w16(c, 0); w16(c, dt); w16(c, dd); w32(c, crc); w32(c, e.data.length); w32(c, e.data.length); w16(c, name.length); w16(c, 0); w16(c, 0); w16(c, 0); w16(c, 0); w32(c, 0); w32(c, offset);
      central.push(Uint8Array.from(c), name);
      offset += h.length + name.length + e.data.length;
    });
    let csize = 0; central.forEach((p) => (csize += p.length));
    const end = []; w32(end, 0x06054b50); w16(end, 0); w16(end, 0); w16(end, entries.length); w16(end, entries.length); w32(end, csize); w32(end, offset); w16(end, 0);
    const all = parts.concat(central, [Uint8Array.from(end)]); let total = 0; all.forEach((p) => (total += p.length));
    const out = new Uint8Array(total); let o = 0; all.forEach((p) => { out.set(p, o); o += p.length; }); return out;
  }

  /* ---- docx */
  function runs(text) { // **bold** support
    return String(text).split(/(\*\*[^*]+\*\*)/).filter((x) => x !== "").map((x) => /^\*\*[^*]+\*\*$/.test(x) ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEsc(x.slice(2, -2))}</w:t></w:r>` : `<w:r><w:t xml:space="preserve">${xmlEsc(x)}</w:t></w:r>`).join("");
  }
  function docxBytes(text) {
    const paras = String(text).replace(/\r/g, "").split("\n").map((line) => {
      let m;
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) return `<w:p><w:pPr><w:pStyle w:val="Heading${m[1].length}"/></w:pPr>${runs(m[2])}</w:p>`;
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) return `<w:p><w:pPr><w:ind w:left="540" w:hanging="270"/></w:pPr>${runs("• " + m[1])}</w:p>`;
      if (!line.trim()) return `<w:p/>`;
      return `<w:p>${runs(line)}</w:p>`;
    }).join("");
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"', H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const heading = (id, sz) => `<w:style w:type="paragraph" w:styleId="Heading${id}"><w:name w:val="heading ${id}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`;
    return zipBytes([
      { name: "[Content_Types].xml", data: u8(`${H}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`) },
      { name: "_rels/.rels", data: u8(`${H}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`) },
      { name: "word/_rels/document.xml.rels", data: u8(`${H}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
      { name: "word/styles.xml", data: u8(`${H}<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${heading(1, 36)}${heading(2, 30)}${heading(3, 26)}</w:styles>`) },
      { name: "word/document.xml", data: u8(`${H}<w:document ${NS}><w:body>${paras}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`) },
    ]);
  }

  /* ---- xlsx (from CSV text) */
  function parseCsv(text) {
    const rows = []; let row = [], cell = "", q = false; const s = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"' && cell === "") q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c !== ""));
  }
  const colName = (i) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  function xlsxBytes(text) {
    const rows = parseCsv(text).slice(0, 5000);
    const sheet = rows.map((r, ri) => `<row r="${ri + 1}">${r.slice(0, 200).map((v, ci) => {
      const ref = colName(ci) + (ri + 1), t = String(v).trim();
      if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(t)) return `<c r="${ref}"><v>${t}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join("")}</row>`).join("");
    const H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    return zipBytes([
      { name: "[Content_Types].xml", data: u8(`${H}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`) },
      { name: "_rels/.rels", data: u8(`${H}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
      { name: "xl/workbook.xml", data: u8(`${H}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
      { name: "xl/_rels/workbook.xml.rels", data: u8(`${H}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`) },
      { name: "xl/worksheets/sheet1.xml", data: u8(`${H}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`) },
    ]);
  }

  /* ---- pdf (plain text, standard Helvetica) */
  const WIN = { "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "…": 0x85, "€": 0x80 };
  function pdfStr(s) {
    let o = "";
    for (const ch of String(s).normalize("NFC")) {
      let c = ch.codePointAt(0);
      if (c >= 0x300 && c <= 0x36f) continue; // leftover accent marks
      if (WIN[ch]) c = WIN[ch];
      else if (c > 255) { const d = ch.normalize("NFD").replace(/[̀-ͯ]/g, ""); c = d.length === 1 && d.charCodeAt(0) < 256 ? d.charCodeAt(0) : 63; }
      if (c === 40 || c === 41 || c === 92) o += "\\" + String.fromCharCode(c);
      else if (c < 32) o += " ";
      else if (c > 126) o += "\\" + c.toString(8).padStart(3, "0");
      else o += String.fromCharCode(c);
    }
    return o;
  }
  function pdfBytes(text) {
    const lines = []; // {t, size, bold}
    String(text).replace(/\r/g, "").split("\n").forEach((line) => {
      let m, size = 11, bold = false, t = line.replace(/\*\*/g, "");
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { size = [0, 18, 15, 13][m[1].length]; bold = true; t = m[2].replace(/\*\*/g, ""); }
      else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) t = "• " + m[1].replace(/\*\*/g, "");
      const max = Math.max(20, Math.floor(495 / (size * 0.52)));
      if (!t.trim()) { lines.push({ t: "", size, bold }); return; }
      let cur = ""; t.split(/\s+/).forEach((w) => { while (w.length > max) { if (cur) { lines.push({ t: cur, size, bold }); cur = ""; } lines.push({ t: w.slice(0, max), size, bold }); w = w.slice(max); } if ((cur + " " + w).trim().length > max) { lines.push({ t: cur, size, bold }); cur = w; } else cur = (cur + " " + w).trim(); });
      if (cur) lines.push({ t: cur, size, bold });
    });
    const pages = []; let page = [], y = 792;
    lines.forEach((l) => { const lead = l.size + 4; if (y - lead < 50) { pages.push(page); page = []; y = 792; } y -= lead; page.push({ ...l, y }); });
    pages.push(page);
    const objs = []; const add = (s) => { objs.push(s); return objs.length; };
    const cat = add(""), pagesObj = add(""), f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"), f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids = [];
    pages.forEach((p) => {
      const stream = p.map((l) => l.t ? `BT /${l.bold ? "F2" : "F1"} ${l.size} Tf 50 ${l.y} Td (${pdfStr(l.t)}) Tj ET` : "").join("\n");
      const c = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    });
    objs[cat - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => k + " 0 R").join(" ")}] >>`;
    let out = "%PDF-1.4\n", offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const x = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("") + `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${x}\n%%EOF`;
    return u8(out); // every character is ASCII, so string length equals byte length
  }

  /* ---- public API */
  const TEXT_MIME = { html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", json: "application/json", csv: "text/csv", svg: "image/svg+xml", xml: "application/xml", md: "text/markdown", txt: "text/plain" };
  const KIND = { docx: "Word document", xlsx: "Excel sheet", pdf: "PDF", csv: "CSV", zip: "Zip" };
  function bytesFor(name, content) {
    const ext = extOf(name), text = String(content);
    if (ext === "docx") return { data: docxBytes(text), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    if (ext === "xlsx") return { data: xlsxBytes(text), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    if (ext === "pdf") return { data: pdfBytes(text), mime: "application/pdf" };
    const bom = ext === "csv" ? "﻿" : ""; // so Excel reads accents correctly
    return { data: u8(bom + text), mime: (TEXT_MIME[ext] || "text/plain") + ";charset=utf-8" };
  }
  function build(name, content) {
    const n = safeName(name); if (String(content).length > MAX_BYTES) throw new Error("That file is too large to build here.");
    const b = bytesFor(n, content); return { name: n, data: b.data, mime: b.mime };
  }
  function zipFiles(files) { // files: [{name, content}]
    const seen = {}; const entries = files.map((f) => { let b = build(f.name, f.content), nm = b.name, k = 1; while (seen[nm]) nm = b.name.replace(/(\.[^./]+)?$/, (m) => "-" + (++k) + m); seen[nm] = 1; return { name: nm, data: b.data }; });
    return zipBytes(entries);
  }
  const api = { safeName, build, zipFiles, zipBytes, crc32, parseCsv, kind: (n) => KIND[extOf(n)] || (extOf(n) ? extOf(n).toUpperCase() + " file" : "File") };
  root.vyraFiles = api;
  if (typeof module !== "undefined") module.exports = api;

  /* ---- download buttons inside chat messages */
  if (typeof document !== "undefined") {
    const save = (data, mime, name) => { const url = URL.createObjectURL(new Blob([data], { type: mime })), a = document.createElement("a"); a.href = url; a.download = name.split("/").pop(); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); };
    const notify = (m) => { try { window.toast(m, "error"); } catch (e) { alert(m); } };
    const read = (card) => ({ name: card.dataset.fname, content: card.querySelector(".file-src code").textContent });
    document.addEventListener("click", (e) => {
      const one = e.target.closest("[data-dl-file]"), all = e.target.closest("[data-dl-all]");
      try {
        if (one) { const f = read(one.closest(".file-card")), b = build(f.name, f.content); save(b.data, b.mime, b.name); }
        else if (all) { const cards = [...all.closest(".msg-body").querySelectorAll('.file-card[data-closed="1"]')]; if (!cards.length) return; save(zipFiles(cards.map(read)), "application/zip", "vyra-files.zip"); }
      } catch (err) { notify(err.message || "Could not build that file."); }
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
