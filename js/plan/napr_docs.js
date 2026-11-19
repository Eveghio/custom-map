// napr_docs.js - საჯარო რეესტრის დოკუმენტები საკადასტრო კოდით: ამონაწერები და საკადასტრო გეგმები.
// ES module. მუშაობს ექსთენშენის გვერდზე (host_permissions-ით), service worker-ში და Node 18+-ზე.
// გარე ბიბლიოთეკა არ სჭირდება: DecompressionStream + საკუთარი MD5/RC4.
//
// PDF-ის წამკითხავი დაფუძნებულია plan_reader.mjs-ზე (მეორე ჩატი) შემდეგი გასწორებებით (2026-11-13, ცოცხალ ფაილებზე):
//  - ნაკადის ბოლოს დარჩენილი "\r\n" DecompressionStream-ს ბოლო ნაწილს აკარგვინებდა (461 KB-დან 128 KB) -> /Length + ხელახლა ცდა
//  - ობიექტების ძებნის regex ხელმოწერის ციფრების გრძელ მწკრივებზე 1.5 წმ-ს ხარჯავდა -> (?<!\d)
//  - /ID ჩვეულებრივი სტრიქონითაც (…) - დაშიფრული ამონაწერები ამის გამო არ იკითხებოდა
//  - "/O (" ჰარით; სურათები და ფონტის ფაილები არ იხსნება; Info object stream-ში; ASCII85
//  - ფაილი ერთხელ იკითხება (ტექსტი + ტიპი + თარიღები)

export const ABSTRACT_PAGE = "https://abstract.reestri.gov.ge/abstract/cad_amo.php?cad_code=";
export const TYPE_EXTRACT = "ამონაწერი", TYPE_MAP = "საკადასტრო რუკა";
export const CADASTRAL_CODE_RE = /(?<![\d.])\d{1,2}(?:\.\d{1,3}){2,9}[ა-ჰ]?(?![\d.])/;

// ======================= ამონაწერების გვერდი =======================
function decodeEntities(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
const cellText = (h) => decodeEntities(h.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

// [{ url, type, listDate, listDateText, regNo, appNo, row }] - სიის რიგით (განცხადების შეტანის თარიღით, უახლესი ზემოთ)
export function parseAbstractPage(html) {
  const out = []; let m, row = 0;
  const rowRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
  while ((m = rowRe.exec(html))) {
    const link = m[1].match(/onclick\s*=\s*"[^"]*openWindow\('([^']+)'\)/i);
    if (!link) continue;
    const cells = [...m[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cellText(c[1]));
    if (cells.length < 4) continue;
    const d = cells[1].match(/(\d{2})\/(\d{2})\/(\d{4})/);
    out.push({ url: decodeEntities(link[1]), type: cells[cells.length - 1],
      listDate: d ? new Date(+d[3], +d[2] - 1, +d[1]) : null, listDateText: d ? d[0] : "",
      regNo: (cells[0].match(/(\d{6,})/) || [])[1] || "", appNo: (cells[2].match(/(\d+)/) || [])[1] || "", row: row++ });
  }
  return out.filter((r) => /^https:\/\/bs\.napr\.gov\.ge\/GetBlob/i.test(r.url));
}

// მოთხოვნა, რომელიც "არ ეკიდება": თუ სერვერი timeoutMs-ში არ უპასუხებს, წყდება გასაგები შეცდომით
export const LIST_TIMEOUT_MS = 20000; // რეესტრის სიის გვერდი
export const PDF_TIMEOUT_MS = 30000;  // ერთი PDF ფაილი
async function fetchOrTimeout(fetchImpl, url, options, timeoutMs, what) {
  try {
    return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) throw new Error(`${what}: სერვერმა ${timeoutMs / 1000} წამში არ უპასუხა`);
    throw e;
  }
}

export async function readList(cadCode, fetchImpl = fetch) {
  const r = await fetchOrTimeout(fetchImpl, ABSTRACT_PAGE + encodeURIComponent(cadCode.trim()), { cache: "no-store" }, LIST_TIMEOUT_MS, "რეესტრის სია");
  if (!r.ok) throw new Error(`ამონაწერების გვერდი: HTTP ${r.status}`);
  return parseAbstractPage(await r.text());
}

export async function fetchBytes(url, fetchImpl = fetch) {
  const r = await fetchOrTimeout(fetchImpl, url, {}, PDF_TIMEOUT_MS, "რეესტრის PDF");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// ======================= PDF: დაბალი დონე =======================
const latin = (b) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return s; };
const bytesOf = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };

// { data, ok } - ok=false: ნაკადი შეცდომით დასრულდა (data = რაც გაიხსნა)
async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate"), w = ds.writable.getWriter();
  w.write(bytes).catch(() => {}); w.close().catch(() => {});
  const r = ds.readable.getReader(), parts = []; let ok = true;
  try { for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); } } catch (e) { ok = false; }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return { data: out, ok };
}
// ნაკადის ბოლოს ზედმეტი ბაიტები ("\r\n") DecompressionStream-ს ბოლო ნაწილს აკარგვინებს - მოკლე ვარიანტებიც ვცადოთ
async function inflate(bytes) {
  let best = await inflateRaw(bytes);
  for (let cut = 1; !best.ok && cut <= 2 && bytes.length > cut; cut++) {
    const t = await inflateRaw(bytes.subarray(0, bytes.length - cut));
    if (t.ok || t.data.length > best.data.length) best = t;
  }
  return best.data;
}

function md5(bytes) {
  const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const n = bytes.length, len = ((n + 8) >> 6) + 1 << 6, m = new Uint8Array(len);
  m.set(bytes); m[n] = 0x80; const bits = n * 8;
  for (let i = 0; i < 8; i++) m[len - 8 + i] = Math.floor(bits / 2 ** (8 * i)) & 255;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const dv = new DataView(m.buffer);
  for (let o = 0; o < len; o += 64) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + dv.getUint32(o + 4 * g, true)) >>> 0;
      A = D; D = C; C = B;
      const s = S[(i >> 4) * 4 + (i & 3)];
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16), ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(4 * i, v, true));
  return out;
}
function rc4(key, data) {
  const S = new Uint8Array(256); for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; [S[i], S[j]] = [S[j], S[i]]; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + S[i]) & 255; [S[i], S[j]] = [S[j], S[i]];
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}
const PAD = bytesOf("\x28\xbf\x4e\x5e\x4e\x75\x8a\x41\x64\x00\x4e\x56\xff\xfa\x01\x08\x2e\x2e\x00\xb6\xd0\x68\x3e\x80\x2f\x0c\xa9\xfe\x64\x53\x69\x7a");

function parseLiteral(s, i) { // s[i] === "(" -> [bytesString, nextIndex]
  let depth = 1, j = i + 1, out = "";
  while (j < s.length && depth) {
    const c = s[j];
    if (c === "\\") {
      const e = s[j + 1];
      const mp = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
      if (mp[e] !== undefined) { out += mp[e]; j += 2; }
      else if (e >= "0" && e <= "7") { const m = /^[0-7]{1,3}/.exec(s.slice(j + 1, j + 4))[0]; out += String.fromCharCode(parseInt(m, 8) & 255); j += 1 + m.length; }
      else if (e === "\r" || e === "\n") { j += 2; if (e === "\r" && s[j] === "\n") j++; }
      else { out += e; j += 2; }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (!depth) break; }
    out += c; j++;
  }
  return [out, j + 1];
}
const hexStr = (h) => { h = h.replace(/[^0-9A-Fa-f]/g, ""); if (h.length % 2) h += "0"; let o = ""; for (let i = 0; i < h.length; i += 2) o += String.fromCharCode(parseInt(h.slice(i, i + 2), 16)); return o; };
// სტრიქონი პოზიციიდან i ("(" ან "<")
const pdfString = (s, i) => s[i] === "(" ? parseLiteral(s, i)[0] : hexStr(s.slice(i + 1, s.indexOf(">", i)));

function readObjects(bytes) {
  const s = latin(bytes), objs = new Map(); // num -> { gen, dict, raw(Uint8Array|null) }
  // (?<!\d): ხელმოწერის ბლოკის გრძელ ციფრულ მწკრივებზე regex კვადრატულად ნელდებოდა
  const re = /(?<!\d)(\d+)\s+(\d+)\s+obj\b/g; let m;
  const heads = []; while ((m = re.exec(s))) heads.push([+m[1], +m[2], m.index + m[0].length]);
  for (let k = 0; k < heads.length; k++) {
    const [num, gen, st] = heads[k];
    const lim = k + 1 < heads.length ? heads[k + 1][2] : s.length;
    const endobj = s.indexOf("endobj", st), stop = endobj >= 0 && endobj < lim ? endobj : lim;
    const body = s.slice(st, stop);
    const sm = /stream\r?\n/.exec(body);
    if (sm) {
      const dict = body.slice(0, sm.index), ds = st + sm.index + sm[0].length;
      let de = s.indexOf("endstream", ds); if (de < 0) de = ds;
      const lm = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/); // მხოლოდ პირდაპირი რიცხვი, არა მითითება
      if (lm && ds + +lm[1] <= de && /^\s*$/.test(s.slice(ds + +lm[1], de))) de = ds + +lm[1];
      objs.set(num, { gen, dict, raw: bytes.subarray(ds, de) });
    } else objs.set(num, { gen, dict: body, raw: null });
  }
  return { s, objs };
}

function encryptionKey(s, objs) {
  const tm = s.match(/\/Encrypt\s+(\d+)\s+\d+\s+R/); if (!tm) return null;
  const e = objs.get(+tm[1]); if (!e) return null;
  const d = e.dict, V = +(d.match(/\/V\s+(\d+)/) || [0, 0])[1], R = +(d.match(/\/R\s+(\d+)/) || [0, 2])[1];
  if (V > 2 || /\/CFM\s*\/AESV/.test(d)) return { unsupported: true }; // AES - მხარდაჭერილი არ არის
  const len = +(d.match(/\/Length\s+(\d+)/) || [0, 40])[1] / 8;
  const om = /\/O\s*([(<])/.exec(d); // "/O (" ჰარითაც
  const O = bytesOf((om ? pdfString(d, om.index + om[0].length - 1) : "").slice(0, 32));
  const P = +(d.match(/\/P\s+(-?\d+)/) || [0, 0])[1];
  const idm = /\/ID\s*\[\s*([(<])/.exec(s); // hex <…> ან ჩვეულებრივი სტრიქონი (…)
  const ID = bytesOf(idm ? pdfString(s, idm.index + idm[0].length - 1) : "");
  const buf = new Uint8Array(32 + 32 + 4 + ID.length); buf.set(PAD, 0); buf.set(O, 32);
  new DataView(buf.buffer).setInt32(64, P | 0, true); buf.set(ID, 68);
  let key = md5(buf).subarray(0, len);
  if (R >= 3) for (let i = 0; i < 50; i++) key = md5(key).subarray(0, len);
  return { key: Uint8Array.from(key), encryptNum: +tm[1] };
}
function objKey(enc, num, gen) {
  const b = new Uint8Array(enc.key.length + 5); b.set(enc.key);
  b[enc.key.length] = num & 255; b[enc.key.length + 1] = (num >> 8) & 255; b[enc.key.length + 2] = (num >> 16) & 255;
  b[enc.key.length + 3] = gen & 255; b[enc.key.length + 4] = (gen >> 8) & 255;
  return md5(b).subarray(0, Math.min(enc.key.length + 5, 16));
}
function a85(b) { // ASCII85Decode
  const out = []; let t = [], i = 0; const s = latin(b);
  if (s.startsWith("<~")) i = 2;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 126) break;
    if (c <= 32) continue;
    if (c === 122 && !t.length) { out.push(0, 0, 0, 0); continue; }
    t.push(c - 33);
    if (t.length === 5) { let v = 0; for (const x of t) v = v * 85 + x; out.push(v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255); t = []; }
  }
  if (t.length > 1) { const n = t.length; while (t.length < 5) t.push(84); let v = 0; for (const x of t) v = v * 85 + x; out.push(...[v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255].slice(0, n - 1)); }
  return Uint8Array.from(out);
}
async function streamText(o, num, enc) {
  let data = o.raw;
  if (enc && enc.key && num !== enc.encryptNum && !/\/Type\s*\/XRef/.test(o.dict)) data = rc4(objKey(enc, num, o.gen), data);
  if (/\/ASCII85Decode/.test(o.dict)) data = a85(data);
  if (/\/FlateDecode/.test(o.dict)) { const d = await inflate(data); if (d.length) data = d; }
  return latin(data);
}

// ---------- ფონტები: ToUnicode -> /Differences -> Latin-1 ----------
const GLYPH = { space: " ", period: ".", comma: ",", hyphen: "-", colon: ":", semicolon: ";", slash: "/", parenleft: "(", parenright: ")",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", underscore: "_",
  numbersign: "#", percent: "%", quotesingle: "'", quotedbl: '"', plus: "+", equal: "=", asterisk: "*", ampersand: "&", exclam: "!", question: "?" };
const glyphChar = (n) => n.length === 1 ? n : GLYPH[n] !== undefined ? GLYPH[n] : /^uni[0-9A-F]{4}$/.test(n) ? String.fromCharCode(parseInt(n.slice(3), 16)) : "";

function cmapToMap(t) {
  const map = {}; let byteLen = 1;
  const cs = t.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/); if (cs) byteLen = cs[1].length / 2;
  const u16 = (h) => { let o = ""; for (let i = 0; i + 3 < h.length; i += 4) o += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return o; };
  for (const b of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const p of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) { map[p[1].toUpperCase()] = u16(p[2]); if (!cs) byteLen = p[1].length / 2; }
  for (const b of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const p of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const a = parseInt(p[1], 16), z = parseInt(p[2], 16), w = p[1].length; if (!cs) byteLen = w / 2;
      if (p[3][0] === "[") { [...p[3].matchAll(/<([0-9A-Fa-f]+)>/g)].forEach((x, i) => { map[(a + i).toString(16).toUpperCase().padStart(w, "0")] = u16(x[1]); }); }
      else { const u = parseInt(p[3].slice(1, -1), 16); for (let i = a; i <= z && i - a < 5000; i++) map[i.toString(16).toUpperCase().padStart(w, "0")] = String.fromCharCode(u + i - a); }
    }
  return { map, byteLen };
}

function buildFonts(objs, texts) {
  const dictOf = (num) => (objs.get(num) || {}).dict || "";
  const fonts = {}, decoders = new Map();
  const decoderFor = (fnum) => {
    if (decoders.has(fnum)) return decoders.get(fnum);
    const fd = dictOf(fnum); let dec = (b) => b;
    const tu = fd.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (tu && texts.has(+tu[1])) {
      const { map, byteLen } = cmapToMap(texts.get(+tu[1]));
      dec = (b) => { let o = ""; for (let i = 0; i + byteLen <= b.length; i += byteLen) { let h = ""; for (let k = 0; k < byteLen; k++) h += b.charCodeAt(i + k).toString(16).toUpperCase().padStart(2, "0"); o += map[h] !== undefined ? map[h] : (byteLen === 1 ? b[i] : ""); } return o; };
    } else {
      let encDict = "";
      const er = fd.match(/\/Encoding\s+(\d+)\s+\d+\s+R/); if (er) encDict = dictOf(+er[1]);
      else { const ei = fd.match(/\/Encoding\s*<<([\s\S]*?)>>/); if (ei) encDict = ei[1]; }
      const dm = encDict.match(/\/Differences\s*\[([\s\S]*?)\]/);
      if (dm) {
        const diff = {}; let code = 0;
        for (const tok of dm[1].match(/\d+|\/[^\s\/\[\]]+/g) || []) { if (tok[0] !== "/") code = +tok; else { diff[code] = glyphChar(tok.slice(1)); code++; } }
        dec = (b) => { let o = ""; for (let i = 0; i < b.length; i++) { const c = b.charCodeAt(i); o += diff[c] !== undefined ? diff[c] : b[i]; } return o; };
      }
    }
    decoders.set(fnum, dec); return dec;
  };
  const namesOf = (fontDict) => { const out = {}; for (const m of fontDict.matchAll(/\/([^\s\/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) out[m[1]] = decoderFor(+m[2]); return out; };
  // სარეზერვო: ყველა რესურსი ერთად (პირველი სახელი იმარჯვებს) - მხოლოდ იმ ნაკადებისთვის, რომელთა გვერდიც ვერ ვიპოვეთ
  for (const [, o] of objs) {
    for (const m of o.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) for (const [k, v] of Object.entries(namesOf(m[1]))) if (!fonts[k]) fonts[k] = v;
    for (const m of o.dict.matchAll(/\/Font\s+(\d+)\s+\d+\s+R/g)) for (const [k, v] of Object.entries(namesOf(dictOf(+m[1])))) if (!fonts[k]) fonts[k] = v;
  }
  // სწორი გზა: ერთი სახელი (მაგ. /F0) სხვადასხვა გვერდზე / ხელმოწერის ბლოკში სხვადასხვა შრიფტია.
  // გვერდის /Contents და ფორმის (XObject) ნაკადი -> მისი /Resources -> /Font
  const resourcesOf = (dict, depth = 0) => {
    const m = /\/Resources\s*(<<|(\d+)\s+\d+\s+R)/.exec(dict);
    if (m) return m[2] ? dictOf(+m[2]) : balancedDict(dict, m.index + m[0].length - 2);
    const p = dict.match(/\/Parent\s+(\d+)\s+\d+\s+R/); // მემკვიდრეობით Pages-იდან
    return p && depth < 10 ? resourcesOf(dictOf(+p[1]), depth + 1) : null;
  };
  const fontsIn = (res) => {
    const m = res && /\/Font\s*(<<|(\d+)\s+\d+\s+R)/.exec(res);
    if (!m) return null;
    return namesOf(m[2] ? dictOf(+m[2]) : balancedDict(res, m.index + m[0].length - 2));
  };
  const perStream = new Map();
  for (const [num, o] of objs) {
    if (/\/Type\s*\/Page\b/.test(o.dict)) {
      const f = fontsIn(resourcesOf(o.dict)); if (!f) continue;
      const c = o.dict.match(/\/Contents\s*(?:(\d+)\s+\d+\s+R|\[([^\]]*)\])/);
      const nums = !c ? [] : c[1] ? [+c[1]] : [...c[2].matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => +x[1]);
      for (const n of nums) if (!perStream.has(n)) perStream.set(n, f);
    } else if (o.raw && /\/Subtype\s*\/Form\b/.test(o.dict)) {
      const f = fontsIn(resourcesOf(o.dict)); if (f) perStream.set(num, f);
    }
  }
  return { fallback: fonts, forStream: (num) => perStream.get(num) || fonts };
}
// "<<…>>" დაბალანსებულად, პოზიციიდან i (s[i..i+1] === "<<")
function balancedDict(s, i) {
  let depth = 0;
  for (let j = i; j < s.length - 1; j++) {
    if (s[j] === "<" && s[j + 1] === "<") { depth++; j++; }
    else if (s[j] === ">" && s[j + 1] === ">") { depth--; j++; if (!depth) return s.slice(i, j + 1); }
  }
  return s.slice(i);
}

function contentText(t, fonts) {
  t = t.replace(/\bBI\b[\s\S]*?\bID\s[\s\S]*?\sEI(?=\s)/g, " "); // ინლაინ სურათები (ბინარული)
  let out = "", dec = (b) => b; const re = /\/([^\s\/<>\[\]()]+)\s+[-\d.]+\s+Tf|\(|<(?!<)([0-9A-Fa-f\s]*)>|\bT[jJ]\b|'|"|\bET\b|\bTd\b|\bTD\b|\bT\*|\bTm\b/g;
  let m;
  while ((m = re.exec(t))) {
    if (m[1]) { dec = fonts[m[1]] || ((b) => b); continue; }
    if (m[0] === "(") { const [str, nx] = parseLiteral(t, m.index); out += dec(str); re.lastIndex = nx; continue; }
    if (m[2] !== undefined && m[0][0] === "<") { out += dec(hexStr(m[2])); continue; }
    if (/^(ET|Td|TD|T\*|Tm|')$/.test(m[0])) out += " ";
  }
  return out;
}

function pdfDate(v) {
  const m = v && v.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?([Z+\-])?(\d{2})?'?(\d{2})?/);
  if (!m) return null;
  const off = m[7] && m[7] !== "Z" ? (m[7] === "-" ? -1 : 1) * ((+m[8] || 0) * 60 + (+m[9] || 0)) : 0;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] || 0, +m[5] || 0, +m[6] || 0) - off * 60000);
}

// { text, raw, encrypted, unsupported, created(Date|null), signed }
export async function pdfText(bytes) {
  const { s, objs } = readObjects(bytes);
  const signed = /\/ByteRange\s*\[/.test(s);
  const enc = encryptionKey(s, objs);
  if (enc && enc.unsupported) return { text: "", raw: s, encrypted: true, unsupported: true, created: null, signed };
  // ტექსტს არ შეიცავს: სურათები, ფონტის ფაილები, XMP, xref - მათ არ ვხსნით (დიდი ფაილების სიჩქარე)
  const skip = new Set();
  for (const [, o] of objs) for (const m of o.dict.matchAll(/\/FontFile[23]?\s+(\d+)\s+\d+\s+R/g)) skip.add(+m[1]);
  const texts = new Map();
  for (const [num, o] of objs) {
    if (!o.raw || skip.has(num) || /\/Subtype\s*\/Image\b|\/Type\s*\/(?:XRef|Metadata)\b/.test(o.dict)) continue;
    texts.set(num, await streamText(o, num, enc));
  }
  for (const [num, o] of objs) { // Object stream-ები -> ცალკე ობიექტები (მათი სტრიქონები უკვე გაშიფრულია)
    if (!o.raw || !/\/Type\s*\/ObjStm/.test(o.dict) || !texts.has(num)) continue;
    const t = texts.get(num), first = +(o.dict.match(/\/First\s+(\d+)/) || [0, 0])[1];
    const nums = t.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const st = first + nums[i + 1], en = i + 3 < nums.length ? first + nums[i + 3] : t.length;
      if (!objs.has(nums[i])) objs.set(nums[i], { gen: 0, dict: t.slice(st, en), raw: null, inStm: true });
    }
  }
  const fonts = buildFonts(objs, texts);
  let text = "";
  for (const [num, t] of texts) if (/\bBT\b/.test(t) && /T[jJ]/.test(t)) text += contentText(t, fonts.forStream(num)) + " ";
  let createdStr = null;
  const im = s.match(/\/Info\s+(\d+)\s+(\d+)\s+R/);
  if (im && objs.has(+im[1])) {
    const io = objs.get(+im[1]), d = io.dict, cm = /\/CreationDate\s*([(<])/.exec(d);
    if (cm) {
      let v = pdfString(d, cm.index + cm[0].length - 1);
      if (enc && enc.key && !io.inStm) v = latin(rc4(objKey(enc, +im[1], +im[2]), bytesOf(v)));
      createdStr = v;
    }
  }
  const created = pdfDate(createdStr) || pdfDate((s.match(/\/CreationDate\s*\((D:[^)]*)\)/) || [])[1]);
  return { text: text.replace(/\s+/g, " "), raw: s, encrypted: !!enc, unsupported: false, created, signed };
}

// ======================= დოკუმენტის ამოცნობა =======================
// ამონაწერი: "… N <განცხ. №> - <შეტანის დრო> <მომზადების დრო>" (2019-2026 ფორმატები)
const EXTRACT_RE = /N\s*(\d{9,})\s*-\s*(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})\D{0,20}?(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/;
const localTime = (d) => { const m = d.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/); return m ? new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) : null; };
// რეესტრის შტამპი ნახაზებზე ("…ნახაზი არ შეესაბამება …") - სათაური არ არის
const STAMP = /(?:sakadastro|agegmviTi\/?|azomviTi|situaciuri|Sida|საკადასტრო|აგეგმვითი\/?|აზომვითი|სიტუაციური|შიდა)*(?:naxazi|ნახაზი|gegma|გეგმა)(?:arSeesabameba|არშეესაბამება)/g;

function classifyMap(flat) {
  const stamps = flat.match(STAMP) || [];
  const body = flat.replace(STAMP, "");
  let kind = /სიტუაციურინახაზი|situaciurinaxazi/.test(body) ? "situational-drawing" :
    /აზომვითინახაზი|azomviTinaxazi/.test(body) ? "measurement-drawing" :
    /საკადასტროგეგმა|sakadastrogegma/.test(body) ? "cadastral-plan" : "unknown";
  if (kind === "cadastral-plan" && !/საკადასტროკოდი|sakadastrokodi/.test(flat)) kind = "unknown";
  return { kind, stamp: stamps[0] || "", confirmed: kind === "cadastral-plan" && /საჯარორეესტრისეროვნულისააგენტო|reestriserovnulisaagento/.test(flat) };
}

// დოკუმენტში ჩაწერილი საკადასტრო კოდები (მაგ. ამონაწერში „წინა კოდები“), რიგით, გამეორების გარეშე
export function cadastralCodesInText(text) {
  const pattern = new RegExp(CADASTRAL_CODE_RE.source, "g");
  return [...new Set((text || "").match(pattern) || [])].filter((candidate) => candidate.split(".").length >= 4);
}

// row: parseAbstractPage-ის სტრიქონი (type, regNo). ბრუნდება:
// { kind, stamp, confirmed, codes, appNo, appTime, prepared, preparedHasTime, created, signed, encrypted, unsupported, readable }
//   kind: "extract" | "cadastral-plan" | "situational-drawing" | "measurement-drawing" | "unknown" | "encrypted-unsupported"
export async function describeDoc(bytes, row = {}) {
  const p = await pdfText(bytes);
  const flat = p.text.replace(/\s+/g, "");
  const base = { signed: p.signed, encrypted: p.encrypted, unsupported: p.unsupported, created: p.created, readable: flat.length > 20,
    stamp: "", confirmed: false, appNo: "", appTime: null, prepared: null, preparedHasTime: false, codes: cadastralCodesInText(p.text) };
  if (p.unsupported) return { ...base, kind: "encrypted-unsupported" };
  const known = row.regNo && flat.includes(row.regNo) ? row.regNo : "";
  if (row.type === TYPE_EXTRACT) {
    const m = p.text.match(EXTRACT_RE);
    return { ...base, kind: m || /ამონაწერი/.test(flat) ? "extract" : "unknown", appNo: m ? m[1] : known,
      appTime: m ? localTime(m[2]) : null, prepared: m ? localTime(m[3]) : null, preparedHasTime: !!m };
  }
  const c = classifyMap(flat);
  const app = known || (p.text.match(/\*(8[89]\d{10})\*/) || flat.match(/განცხადებისნომერი:?(8[89]\d{10})(?!\d)/) ||
    flat.match(/\d{2}\.\d{2}\.\d{2}(8[89]\d{10})(?!\d)/) || p.text.match(/(?<![\d.])(8[89]\d{10})(?![\d.])/) || [])[1] || "";
  const pd = flat.match(/მომზადებისთარიღი:(\d{2})\/(\d{2})\/(\d{4})/);
  return { ...base, ...c, appNo: app, prepared: pd ? new Date(+pd[3], +pd[2] - 1, +pd[1]) : null };
}

// ======================= დაჯგუფება და დალაგება =======================
// ერთი დოკუმენტი სიაში ორჯერ წერია (ხელმოწერილი + ხელმოუწერელი/დაშიფრული ასლი) -> ერთი ჯგუფი.
// docs: [{ row, info }] (info = describeDoc-ის შედეგი; ჩამოტვირთვის შეცდომისას info = { kind: "error" }).
// ბრუნდება ჯგუფები, ახლიდან ძველისკენ: { kind, when, whenHasTime, regNo, rows[], best(row), signedRow, docs[] }
export function groupDocs(docs) {
  const TOL = 15 * 60 * 1000;
  const timeOf = (d) => {
    const i = d.info || {};
    if (d.row.type === TYPE_EXTRACT) return i.prepared || i.created || null;
    return i.created || i.prepared || null; // გეგმები: /CreationDate უფრო ზუსტია (prepared მხოლოდ თარიღია)
  };
  const groups = [];
  const timed = docs.filter((d) => timeOf(d)), untimed = docs.filter((d) => !timeOf(d));
  // ჯერ წაკითხული ასლები, მერე წაუკითხავი (მათი ტიპი უცნობია - იმავე განცხადების და დროის ჯგუფს მიუერთდნენ)
  const byRow = (a, b) => a.row.row - b.row.row;
  for (const d of [...timed.filter((x) => x.info.readable).sort(byRow), ...timed.filter((x) => !x.info.readable).sort(byRow)]) {
    const t = timeOf(d).getTime(), kind = d.info.kind;
    const g = groups.find((x) => x.regNo === d.row.regNo && (x.kind === kind || !d.info.readable) && Math.abs(x.t - t) <= TOL);
    if (g) g.docs.push(d); else groups.push({ regNo: d.row.regNo, kind, t, docs: [d] });
  }
  for (const d of untimed) { // წაუკითხავი ასლი: იმავე განცხადების ერთადერთ ჯგუფს მიუერთდეს, თუ ასეთია
    const same = groups.filter((x) => x.regNo === d.row.regNo && (d.row.type !== TYPE_EXTRACT || x.kind === "extract"));
    if (same.length === 1) same[0].docs.push(d);
    else groups.push({ regNo: d.row.regNo, kind: (d.info && d.info.kind) || "error", t: null, docs: [d] });
  }
  for (const g of groups) {
    g.docs.sort((a, b) => a.row.row - b.row.row);
    g.rows = g.docs.map((d) => d.row.row);
    const signed = g.docs.find((d) => d.info && d.info.signed);
    const readable = g.docs.find((d) => d.info && d.info.readable);
    g.signedRow = signed ? signed.row : null;
    g.best = (signed || readable || g.docs[0]).row; // გასახსნელად: ხელმოწერილი, თუ არის
    const prepared = g.docs.map((d) => d.info && d.info.prepared).find(Boolean) || null;
    const hasTime = g.docs.some((d) => d.info && d.info.preparedHasTime);
    g.when = g.t !== null ? new Date(g.t) : (g.docs[0].row.listDate || null);
    g.whenSource = g.t !== null ? (prepared && (hasTime || g.kind !== "extract") ? "prepared" : "created") : "list";
    g.prepared = prepared; g.whenHasTime = g.kind === "extract" ? hasTime || g.whenSource === "created" : false;
    g.appNo = (g.docs.map((d) => d.info && d.info.appNo).find(Boolean)) || g.regNo;
    g.stamp = (g.docs.map((d) => d.info && d.info.stamp).find(Boolean)) || "";
    // გეგმები: "მომზადების თარიღი" (თუ წერია) წყვეტს დღეს; იმავე დღის შიგნით რიგს /CreationDate წყვეტს
    g.sortKey = g.t !== null ? g.t : (g.when ? g.when.getTime() : -Infinity);
    // დოკუმენტი განცხადებიდან წელზე მეტი ხნის შემდეგ ვერ მომზადდებოდა: ხელახლა შექმნილი ძველი ფაილი (/CreationDate = დღეს)
    // რიგში ზემოთ არ უნდა ავიდეს. ჩვენების თარიღი არ იცვლება, მხოლოდ დალაგება.
    const listDate = g.docs[0].row.listDate;
    if (listDate && !(g.kind !== "extract" && prepared) && !hasTime) g.sortKey = Math.min(g.sortKey, listDate.getTime() + 365 * 86400000);
    if (g.kind !== "extract" && prepared) {
      const created = g.t !== null ? new Date(g.t) : null;
      const sameDay = created && created.getFullYear() === prepared.getFullYear() && created.getMonth() === prepared.getMonth() && created.getDate() === prepared.getDate();
      g.sortKey = sameDay ? created.getTime() : prepared.getTime() + 12 * 3600 * 1000;
    }
    delete g.t;
  }
  groups.sort((a, b) => b.sortKey - a.sortKey || a.rows[0] - b.rows[0]);
  return groups;
}

// რამდენი სტრიქონი უნდა იყოს წაკითხული (სიის თავიდან), რომ N-ე დოკუმენტი საიმედოდ შეირჩეს.
// sia განცხადების შეტანის რიგითაა; დოკუმენტის მომზადება შეიძლება რამდენიმე განცხადებით "გადაასწროს".
export function rowsNeeded(kind, n, groupsSoFar, prefixRows) {
  if (kind === "extract") return Math.max(8, 2 * n + 4);
  // გეგმა: N გეგმა + იმავე განცხადების დანარჩენი სტრიქონები + 2 სტრიქონი მარაგი
  const plans = groupsSoFar.filter((g) => g.kind === "cadastral-plan");
  if (plans.length < n) return Infinity;
  const lastRow = Math.max(...plans.slice(0, n).flatMap((g) => g.rows));
  return lastRow + 3;
}

// ======================= ერთი გამოძახებით =======================
// kind: "plan" | "extract". ბრუნდება:
// { status: "found"|"missing", pageUrl, numbered[], other[], doc (N-ე ჯგუფი ან null), bytes (მისი PDF), url (მისი ლინკი) }
//   numbered: საკადასტრო გეგმები / ამონაწერები, 1 = ქრონოლოგიურად ბოლო; other: "საკადასტრო რუკად" მონიშნული ნახაზები და შეცდომები
// ჩამოტვირთავს ამ ტიპის ყველა ფაილს (parallel ერთდროულად; 4-ზე მეტი რეესტრის სერვერს ანელებს).
export async function findDocuments(cadCode, kind = "plan", { n = 1, parallel = 4, fetchImpl = fetch } = {}) {
  const pageUrl = ABSTRACT_PAGE + encodeURIComponent(cadCode.trim());
  const type = kind === "extract" ? TYPE_EXTRACT : TYPE_MAP;
  const rows = (await readList(cadCode, fetchImpl)).filter((r) => r.type === type);
  const docs = []; let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++], d = { row };
      try { d.bytes = await fetchBytes(row.url, fetchImpl); d.info = await describeDoc(d.bytes, row); }
      catch (e) { d.info = { kind: "error", error: e.message || String(e), readable: false }; }
      docs.push(d);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  const groups = groupDocs(docs);
  const numbered = kind === "plan" ? groups.filter((g) => g.kind === "cadastral-plan") : groups.filter((g) => g.kind !== "error");
  const other = groups.filter((g) => !numbered.includes(g));
  const doc = numbered[n - 1] || null;
  const best = doc ? docs.find((d) => d.row === doc.best) : null;
  return { status: doc ? "found" : "missing", pageUrl, numbered, other, doc, bytes: best ? best.bytes : null, url: best ? best.row.url : "" };
}
