// plan_converter.js - საკადასტრო გეგმის PDF -> ნაკვეთის კონტური (გრძედი/განედი).
//
// ეს ფაილი ორი ნაწილისგან შედგება:
//
//   ნაწილი A (ამ ფაილის დასაწყისი): "convertPlanPdf" - ერთადერთი ფუნქცია, რომელსაც ექსთენშენის სხვა ფაილები იძახებენ.
//
//   ნაწილი B (ხაზის "ბირთვი cadastre_pdf_to_kml.html-იდან" ქვემოთ): გარდაქმნის ალგორითმი, გადმოტანილი
//   შენი cadastre_pdf_to_kml.html ფაილიდან ᲣᲪᲕᲚᲔᲚᲐᲓ (იგივე ფუნქციები, იგივე სახელები), რომ ორივე ერთნაირად
//   მუშაობდეს და ერთში გაკეთებული შესწორება მეორეში პირდაპირ გადაიტანო.
//
// ნაწილი B-ს ფუნქციები, გამოძახების რიგით:
//   extractPage(page, OPS)       PDF-ის გვერდიდან ამოიღებს: დახატულ ხაზებს (ფერით), ტექსტს, ბადის ციფრებს, სურათებს
//   buildTransform(ex)           ბადის ხაზები + ბადის ციფრები (UTM მეტრები) -> ფორმულა "PDF-ის წერტილი -> UTM"
//     gridLines / snap / robustFit / linfit     ბადის ხაზების პოვნა, ციფრის მიბმა ხაზზე, ცუდი საყრდენების გამორიცხვა
//     readGlyphLabels            თუ ბადის ციფრები ტექსტად არ წერია, არამედ ასოების მოხაზულობებადაა დახატული
//   chainRings(painted)          წითელი ხაზებიდან დახურული რგოლები (ნაკვეთის საზღვარი)
//   parseMeta(text, items)       საკადასტრო კოდი, ფართობი და UTM ზონა გეგმის ტექსტიდან (legacyMeta - 2016-მდე ფორმატი)
//   buildGeometry(ex)            ყველაფერი ერთად ვექტორული გეგმისთვის: რგოლები UTM-ში, ხვრელები, ფართობის შედარება
//   rasterGeometry(page, ex)     თუ საზღვარი PDF-ში სურათია: გვერდი იხატება canvas-ზე და წითელ ხაზს მიჰყვება
//     traceRedBoundary / buildGeometryRaster / gridFrame და დამხმარეები (edt, boxMorph, dpSimplify ...)
//   utmToLonLat / toLonLat       UTM -> გრძედი/განედი (WGS84)
//   detectZone / groupsInGeorgia UTM ზონის (37N / 38N) შემოწმება: ნაკვეთი საქართველოში უნდა მოხვდეს
//   accuracyEstimate(g)          სავარაუდო ცდომილება მეტრებში
//   makeKML / makeShapefile / makeZip   ფაილების აწყობა (ექსთენშენი ამჟამად მხოლოდ კონტურს იყენებს)
//
// HTML ფაილის ვერსია: 2026-11-20, კომიტი 66c2f24 (მასობრივი ტესტის გასწორებები: ორჯერ დახატული საზღვარი, გადაბმული ბადის ციფრები, (230,0,0) საზღვარი, ფართობის ზღვარი).
// საჭიროებს: lib/pdf.mjs და lib/pdf.worker.mjs (Mozilla pdf.js, იგივე ვერსია, რაც HTML ფაილშია ჩაშენებული).
// მუშაობს მხოლოდ ექსთენშენის გვერდზე (viewer.html, contours.html): რასტრულ გეგმას canvas სჭირდება,
// რომელიც background-ში (service worker) არ არსებობს.

// ===================================================================================
// ნაწილი A: ექსთენშენის შესასვლელი
// ===================================================================================

let pdfJsLibrary = null;

// pdf.js იტვირთება მხოლოდ პირველი გარდაქმნისას (1.8 MB-ია და viewer-ის გახსნას არ უნდა ანელებდეს)
async function loadPdfJs() {
  if (!pdfJsLibrary) {
    pdfJsLibrary = await import("./lib/pdf.mjs");
    pdfJsLibrary.GlobalWorkerOptions.workerSrc = new URL("./lib/pdf.worker.mjs", import.meta.url).href;
  }
  return pdfJsLibrary;
}

// გეგმის PDF-ის ბაიტები -> კონტური.
// ბრუნდება:
//   {
//     cadastralCode      გეგმაში დაწერილი საკადასტრო კოდი (ან null)
//     polygons           [[გარე რგოლი, ...ხვრელები], ...]; რგოლი = [[გრძედი, განედი], ...], დახურული
//                        (იგივე ფორმა, რასაც background.js-ის parseWktPolygons აბრუნებს და GeoJSON იყენებს)
//     areaInPdf          გეგმაში დაწერილი ფართობი, კვ.მ (ან null)
//     areaCalculated     კონტურიდან გამოთვლილი ფართობი, კვ.მ
//     areaDifferencePercent   სხვაობა პროცენტებში (NaN, თუ გეგმაში ფართობი ვერ წავიკითხე)
//     areaTolerancePercent    დასაშვები სხვაობა: 1%, ან მეტი, თუ გეგმის ფართობის დამრგვალება თავად აჭარბებს 1%-ს
//                             (მაგ. "6 კვ.მ" = 5.5-6.5 -> 8.3%)
//     accuracyMeters     { typical, max } - სავარაუდო ცდომილება
//     utmZone            37 ან 38
//     isRaster           true, თუ საზღვარი სურათიდან არის ამოღებული (ნაკლებად ზუსტი)
//     insideGeorgia      false ნიშნავს, რომ ზონა ან ბადე არასწორად წავიკითხე
//     warnings, notes    ტექსტები მომხმარებლისთვის
//   }
// შეცდომისას ისვრის Error-ს ქართული ტექსტით (მაგ. "საყრდენი ბადე ვერ მოიძებნა").
export async function convertPlanPdf(pdfBytes) {
  const pdfJs = await loadPdfJs();
  // pdf.js გადაცემულ მასივს "იტაცებს" (worker-ში გადააქვს), ამიტომ ასლს ვაძლევთ
  const loadingTask = pdfJs.getDocument({ data: pdfBytes.slice(), verbosity: 0, isEvalSupported: false });
  const pdfDocument = await loadingTask.promise;
  try {
    const firstPage = await pdfDocument.getPage(1);
    const extracted = await extractPage(firstPage, pdfJs.OPS);

    let geometry;
    try {
      geometry = buildGeometry(extracted); // ვექტორული საზღვარი (ჩვეულებრივი შემთხვევა)
    } catch (vectorError) {
      if (extracted.imageOps < 3) throw vectorError;
      geometry = await rasterGeometry(firstPage, extracted); // საზღვარი სურათშია
    }

    const { zone, hemi } = geometry.meta;
    const polygons = toLonLat(geometry.groups, zone, hemi).map((polygon) => [polygon.outer, ...polygon.holes]);
    const warnings = [...geometry.warnings];
    if (geometry.meta.zoneCorrected) warnings.push(`გეგმაში ზონა ${geometry.meta.zoneStated}N წერია, მაგრამ ამ ზონით ნაკვეთი საქართველოს გარეთ ხვდება; გამოვიყენე ${zone}N.`);
    if (geometry.meta.zoneAssumed && !geometry.meta.zoneAuto) warnings.push(`UTM ზონა გეგმაში არ წერია და კოორდინატებიდანაც ვერ დადგინდა; ვიღებ ${zone}N-ს.`);
    const insideGeorgia = groupsInGeorgia(geometry.groups, zone, hemi);
    if (!insideGeorgia) warnings.push("კონტური საქართველოს ფარგლებს გარეთ ხვდება: ზონა ან ბადე არასწორად არის წაკითხული.");

    return {
      cadastralCode: geometry.meta.code || null,
      polygons,
      areaInPdf: geometry.meta.areaPdf ?? null,
      areaCalculated: geometry.areaCalc,
      areaDifferencePercent: geometry.diffPct,
      areaTolerancePercent: geometry.areaTolerancePct ?? 1,
      accuracyMeters: accuracyEstimate(geometry),
      utmZone: zone,
      isRaster: !!geometry.raster,
      insideGeorgia,
      warnings,
      notes: geometry.notes
    };
  } finally {
    loadingTask.destroy().catch(() => {});
  }
}

// ტესტებისთვის და მომავალი გაფართოებისთვის (მაგ. SHP ფაილი)
export { makeKML, makeShapefile, makeZip, utmToLonLat };

// ===================================================================================
// ნაწილი B: ბირთვი cadastre_pdf_to_kml.html-იდან (უცვლელი)
// ===================================================================================
// NAPR საკადასტრო გეგმის PDF -> KML / SHP. ბირთვი: არ არის დამოკიდებული Node-ზე ან DOM-ზე.
// pdf.js-ის ობიექტები (page, OPS) გარედან გადმოეცემა.

const TOL = 0.05; // pt: რგოლის დახურვის ტოლერანტობი (როგორც Python ვერსიაში)

// ---------- მატრიცები (PDF row-vector კონვენცია) ----------
const IDENT = [1, 0, 0, 1, 0, 0];
const mult = (m1, m2) => [ // m1 გამოიყენება პირველი, შემდეგ m2
  m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
  m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
  m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// ---------- PDF-იდან ამოღება ----------
async function extractPage(page, OPS) {
  const ol = await page.getOperatorList();
  const { fnArray, argsArray } = ol;
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke,
    OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const closeOps = new Set([OPS.closeStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const imgOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].filter(x => x !== undefined));
  let imageOps = 0; const images = [];

  let ctm = IDENT.slice();
  const stack = [];
  let stroke = [0, 0, 0];
  let path = []; // subpath-ები: {pts, closed, curved}
  const painted = []; // {pts, closed, curved, color}

  const cur = () => path[path.length - 1];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    if (fn === OPS.save) stack.push({ ctm: ctm.slice(), stroke: stroke.slice() });
    else if (fn === OPS.restore) { const s = stack.pop(); if (s) { ctm = s.ctm; stroke = s.stroke; } }
    else if (fn === OPS.transform) ctm = mult(Array.from(a), ctm);
    else if (fn === OPS.setStrokeRGBColor) stroke = [a[0], a[1], a[2]];
    else if (fn === OPS.constructPath) {
      const ops = a[0], c = a[1];
      let k = 0;
      for (const op of ops) {
        if (op === OPS.moveTo) {
          const [x, y] = apply(ctm, c[k], c[k + 1]); k += 2;
          path.push({ pts: [[x, y]], closed: false, curved: false });
        } else if (op === OPS.lineTo) {
          const [x, y] = apply(ctm, c[k], c[k + 1]); k += 2;
          if (!cur()) path.push({ pts: [[x, y]], closed: false, curved: false });
          else cur().pts.push([x, y]);
        } else if (op === OPS.curveTo || op === OPS.curveTo2 || op === OPS.curveTo3) {
          // ბეზიეს მრუდი -> 8 სეგმენტი (ასოების მოხაზულობებისთვისაც საჭიროა)
          let p1, p2, p3;
          if (op === OPS.curveTo) { p1 = apply(ctm, c[k], c[k + 1]); p2 = apply(ctm, c[k + 2], c[k + 3]); p3 = apply(ctm, c[k + 4], c[k + 5]); k += 6; }
          else if (op === OPS.curveTo2) { p2 = apply(ctm, c[k], c[k + 1]); p3 = apply(ctm, c[k + 2], c[k + 3]); k += 4; }
          else { p1 = apply(ctm, c[k], c[k + 1]); p3 = apply(ctm, c[k + 2], c[k + 3]); p2 = p3; k += 4; }
          if (cur()) {
            const p0 = cur().pts[cur().pts.length - 1]; if (!p1) p1 = p0;
            for (let t = 1; t <= 8; t++) { const u = t / 8, v = 1 - u;
              cur().pts.push([v * v * v * p0[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u * u * u * p3[0],
                              v * v * v * p0[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u * u * u * p3[1]]); }
            cur().curved = true;
          }
        } else if (op === OPS.closePath) {
          if (cur()) cur().closed = true;
        } else if (op === OPS.rectangle) {
          const x = c[k], y = c[k + 1], w = c[k + 2], h = c[k + 3]; k += 4;
          path.push({ pts: [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)],
            closed: true, curved: false, rect: true });
        }
      }
    } else if (strokeOps.has(fn)) {
      if (closeOps.has(fn) && cur()) cur().closed = true;
      for (const sp of path) painted.push({ ...sp, color: stroke.slice() });
      path = [];
    } else if (imgOps.has(fn)) {
      imageOps++;
      const w = a && typeof a[1] === 'number' ? a[1] : 0; // paintImageXObject: [id, width, height]
      if (w > 0) { const c0 = apply(ctm, 0, 0), c1 = apply(ctm, 1, 1);
        images.push({ w, ptPerPx: Math.hypot(ctm[0], ctm[1]) / w, bbox: [Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1])] }); }
    } else if (fn === OPS.endPath || fn === OPS.fill || fn === OPS.eoFill) {
      path = [];
    }
  }

  // ტექსტი
  const tc = await page.getTextContent();
  const labelsX = new Map(), labelsY = new Map(); // მნიშვნელობა -> [პოზიციები]
  const labelRuns = { x: [], y: [] }; // ერთ ტექსტად გადაბმული ციფრები: [{ values, positions }] (პოზიცია მიახლოებითია)
  let text = '';
  const items = [];
  for (const it of tc.items) {
    text += it.str + ' ';
    if (it.str.trim()) items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width });
    const [a, b, , , e, f] = it.transform;
    const n = Math.hypot(a, b) || 1;
    const ux = a / n, uy = b / n;
    const horizontal = Math.abs(ux) > 0.9;
    // დიაპაზონი: UTM easting 166000..834000, northing 3.5M..5.5M (გვერდის ნომრები და სხვა რიცხვები არ შემოვიდეს)
    const addLabel = (t, along) => { // along: ტექსტის დასაწყისიდან ციფრის ცენტრამდე (pt)
      if (!/^\d+(\.\d{1,2})?$/.test(t)) return; // დიდ მასშტაბზე ათწილადიც: "484245.6"
      const intLen = t.split('.')[0].length, cx = e + ux * along, cy = f + uy * along;
      if (intLen === 6 && horizontal && +t >= 166000 && +t <= 834000) pushTo(labelsX, +t, cx);
      else if (intLen === 7 && !horizontal && +t >= 3500000 && +t <= 5500000) pushTo(labelsY, +t, cy);
    };
    const tokens = it.str.trim().split(/\s+/);
    if (tokens.length > 1 && tokens.every(k => /^\d{6,7}(\.\d{1,2})?$/.test(k)) && it.width > 0) {
      // რამდენიმე ბადის ციფრი ერთ ტექსტად (ArcMap: "4619070 4619080 ... 4619260"): თითოს ცენტრი
      // სიმბოლოების რიცხვით (ციფრი = 1, სივრცე ≈ 0.5 ციფრი); შეცდომას ხაზზე snap (≤6 pt) ასწორებს
      const units = tokens.reduce((u, k) => u + k.length, 0) + 0.5 * (tokens.length - 1), w = it.width / units;
      let pos = 0;
      for (const k of tokens) { addLabel(k, (pos + k.length / 2) * w); pos += k.length + 0.5; }
    } else {
      const t = it.str.replace(/\s+/g, ""); // ზოგ PDF-ში ციფრებს შორის სივრცეებია: "462 42 50"
      const run = splitGluedLabels(it.str);
      if (run && it.width > 0) { // ხაზებზე რიგით მიება buildTransform-ში (runToPairs), პოზიციით არა
        const along = run.map(([, c, total]) => c / total * it.width);
        labelRuns[horizontal ? 'x' : 'y'].push({ values: run.map(([k]) => +k), positions: along.map(a => horizontal ? e + ux * a : f + uy * a) });
      } else addLabel(t, it.width / 2);
    }
  }
  const view = page.view;
  return { painted, labelsX: meanMap(labelsX), labelsY: meanMap(labelsY), labelRuns, text, items, imageOps, images,
    pageW: view[2] - view[0], pageH: view[3] - view[1] };
}
// ბადის რამდენიმე ციფრი ერთ ტექსტად, შიგნით შემთხვევითი სივრცეებით (ArcMap):
// "46 1 68 5 0 46 1 69 0 0 ..." -> 4616850, 4616900, ... მიიღება მხოლოდ, თუ ციფრები 6/7-ნიშნა
// თანაბარი ბიჯის მიმდევრობად იყოფა. ბრუნდება [[მნიშვნელობა, ცენტრი სიმბოლოებში, სულ სიმბოლოები], ...] ან null.
function splitGluedLabels(str) {
  const chars = [...str], digitAt = []; let units = 0;
  for (const c of chars) { if (/\d/.test(c)) { digitAt.push(units + 0.5); units += 1; } else if (/\s/.test(c)) units += 0.5; else return null; }
  const D = str.replace(/\s+/g, '');
  for (const n of [7, 6]) {
    if (D.length % n || D.length / n < 2) continue;
    const vals = []; for (let i = 0; i < D.length; i += n) vals.push(+D.slice(i, i + n));
    const step = vals[1] - vals[0];
    // ბადის ბიჯი: დადებითი, მრგვალი (5-ის ჯერადი), ≤ 5 კმ - თორემ მაგ. განცხადების ნომერი 882010760186 გაიყოფოდა
    if (!(step > 0 && step % 5 === 0 && step <= 5000) || !vals.every((v, i) => v === vals[0] + i * step)) continue;
    if (n === 7 && !(vals[0] >= 3500000 && vals[vals.length - 1] <= 5500000)) continue;
    if (n === 6 && !(vals[0] >= 166000 && vals[vals.length - 1] <= 834000)) continue;
    return vals.map((v, i) => [String(v), (digitAt[i * n] + digitAt[i * n + n - 1]) / 2, units]);
  }
  return null;
}
function pushTo(m, k, v) { if (!m.has(k)) m.set(k, []); m.get(k).push(v); }
function meanMap(m) { const o = new Map(); for (const [k, v] of m) o.set(k, v.reduce((s, x) => s + x, 0) / v.length); return o; }

// ---------- გეომეტრია ----------
// წითელი საზღვარი: ჩვეულებრივ (255,0,0); Foxit-ით შექმნილ გეგმებში (230,0,0)
const isRed = (c) => c[0] >= 200 && c[1] <= 40 && c[2] <= 40;

function gridLines(painted, minLen) {
  const vx = new Set(), hy = new Set();
  for (const sp of painted) {
    for (let i = 0; i + 1 < sp.pts.length; i++) {
      const [x0, y0] = sp.pts[i], [x1, y1] = sp.pts[i + 1];
      if (Math.abs(x0 - x1) < 0.01 && Math.abs(y0 - y1) > minLen) vx.add(Math.round(x0 * 1000) / 1000);
      else if (Math.abs(y0 - y1) < 0.01 && Math.abs(x0 - x1) > minLen) hy.add(Math.round(y0 * 1000) / 1000);
    }
  }
  return [[...vx].sort((a, b) => a - b), [...hy].sort((a, b) => a - b)];
}

function snap(labels, lines, maxDist = 6) {
  const pairs = new Map();
  for (const [val, pos] of labels) {
    if (!lines.length) continue;
    let best = lines[0];
    for (const L of lines) if (Math.abs(L - pos) < Math.abs(best - pos)) best = L;
    if (Math.abs(best - pos) <= maxDist) pairs.set(best + '|' + val, [best, val]);
  }
  return [...pairs.values()].sort((a, b) => a[0] - b[0]);
}

// გადაბმული ციფრების მიბმა ხაზებზე რიგით: ვარჩევთ წანაცვლებას k (ციფრი i -> ხაზი i+k), რომელზეც
// შეფასებული პოზიციები ხაზებს ყველაზე ახლოსაა; საშუალო შეცდომა ბიჯის მეოთხედზე ნაკლები უნდა იყოს.
function runToPairs(run, lines) {
  const n = run.values.length;
  if (n < 2 || lines.length < 2) return [];
  const order = run.positions.map((p, i) => i).sort((a, b) => run.positions[a] - run.positions[b]);
  const pos = order.map(i => run.positions[i]), vals = order.map(i => run.values[i]);
  const spacing = (lines[lines.length - 1] - lines[0]) / (lines.length - 1);
  const needed = Math.max(2, Math.min(n, lines.length) - 1); // ერთი ციფრი/ხაზი შეიძლება ჩარჩოს გარეთ იყოს
  let chosen = null, bestErr = Infinity;
  for (let k = -(n - 2); k <= lines.length - 2; k++) {
    const pairs = []; let err = 0;
    for (let i = 0; i < n; i++) { const L = lines[i + k]; if (L === undefined) continue; pairs.push([L, vals[i]]); err += Math.abs(L - pos[i]); }
    if (pairs.length < needed) continue;
    err /= pairs.length;
    if (err < bestErr) { bestErr = err; chosen = pairs; }
  }
  return chosen && bestErr < spacing / 4 ? chosen : [];
}

function robustFit(pairs) { // ცუდი (გამონაკლისი) საყრდენები გამოვრიცხოთ: ბადე წრფივია, ნარჩენი ~0.1 მ
  let cur = pairs.slice();
  while (cur.length > 2) {
    const [a, b] = linfit(cur);
    let worst = -1, wr = 0;
    cur.forEach(([p, v], i) => { const r = Math.abs(v - (a * p + b)); if (r > wr) { wr = r; worst = i; } });
    // ზღვარი მასშტაბის მიხედვით: ~3 pt ქაღალდზე, მაქს. 1 მ. დიდ მასშტაბზე (0.005 მ/pt) 1 მ = 200 pt,
    // ამიტომ ათწილადის არასწორად წაკითხული ციფრი (0.2 მ) აბსოლუტური 1 მ ზღვრით ვერ დაიჭირებოდა.
    if (wr <= Math.min(1.0, Math.max(0.01, 3 * Math.abs(a)))) break;
    cur.splice(worst, 1);
  }
  return cur;
}

function linfit(pairs) { // უმცირესი კვადრატები: v = a*p + b
  const n = pairs.length;
  const sp = pairs.reduce((s, [p]) => s + p, 0), sv = pairs.reduce((s, [, v]) => s + v, 0);
  const mp = sp / n, mv = sv / n;
  let num = 0, den = 0;
  for (const [p, v] of pairs) { num += (p - mp) * (v - mv); den += (p - mp) * (p - mp); }
  const a = num / den;
  return [a, mv - a * mp];
}

function buildTransform(ex) {
  const minLen = Math.min(ex.pageW, ex.pageH) * 0.4;
  const [vx, hy] = gridLines(ex.painted, minLen);
  let px = robustFit(snap(ex.labelsX, vx)), py = robustFit(snap(ex.labelsY, hy)), glyphLabels = false;
  // გადაბმული ციფრები ("46 1 68 5 0 46 1 69 0 0 ..."): პოზიცია ტექსტის სიგანიდან უხეშად ითვლება, ამიტომ
  // ხაზებს რიგით ვუსადაგებთ (თანაბარი ბიჯი ორივეგან) - მხოლოდ მაშინ, როცა ჩვეულებრივი ციფრები არ კმარა
  if (px.length < 2 && ex.labelRuns) for (const run of ex.labelRuns.x) { const p = robustFit(runToPairs(run, vx)); if (p.length > px.length) px = p; }
  if (py.length < 2 && ex.labelRuns) for (const run of ex.labelRuns.y) { const p = robustFit(runToPairs(run, hy)); if (p.length > py.length) py = p; }
  if (px.length < 2 || py.length < 2) { // ციფრები ტექსტად არ არის: შეიძლება ასოების მოხაზულობებად იყოს დახატული
    const g = readGlyphLabels(ex, vx, hy);
    // საკმარისია ერთ ღერძზე 2 ხაზი და მეორეზე 1 (დიდი მასშტაბი, მაგ. 8 კვ.მ ნაკვეთი) - ქვემოთ isoAxis
    const enough = (g.px.length >= 2 && g.py.length >= 1) || (g.px.length >= 1 && g.py.length >= 2);
    if (enough && g.px.length + g.py.length > px.length + py.length) { px = robustFit(g.px); py = robustFit(g.py); glyphLabels = true; }
  }
  // დიდი მასშტაბის (მაგ. 1:500) გეგმაზე ერთ ღერძზე შეიძლება მხოლოდ ერთი ბადის ხაზი მოხვდეს.
  // მაშინ ამ ღერძის მასშტაბს მეორე ღერძიდან ვიღებთ (ძველი ArcMap ფორმატი იზოტროპულია: X/Y მასშტაბი ემთხვევა ≤0.2%-ით).
  let isoAxis = null, ax, bx, ay, by;
  if (px.length >= 2 && py.length >= 2) { [ax, bx] = linfit(px); [ay, by] = linfit(py); }
  else if (px.length === 1 && py.length >= 2) { [ay, by] = linfit(py); ax = Math.abs(ay); bx = px[0][1] - ax * px[0][0]; isoAxis = 'x'; }
  else if (py.length === 1 && px.length >= 2) { [ax, bx] = linfit(px); ay = Math.abs(ax); by = py[0][1] - ay * py[0][0]; isoAxis = 'y'; }
  else throw new Error(`საყრდენი ბადე ვერ მოიძებნა (x:${px.length}, y:${py.length})`);
  const residX = Math.max(...px.map(([p, v]) => Math.abs(v - (ax * p + bx))));
  const residY = Math.max(...py.map(([p, v]) => Math.abs(v - (ay * p + by))));
  return { fn: (x, y) => [ax * x + bx, ay * y + by], info: { gridX: px.length, gridY: py.length, residX, residY, scaleX: ax, scaleY: ay, glyphLabels, isoAxis } };
}

const dedupe = (pts) => pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-3);

function chainRings(painted) {
  const rings = []; let curved = 0;
  for (const sp of painted) {
    if (!isRed(sp.color) || sp.rect) continue;
    let pts = dedupe(sp.pts);
    if (pts.length < 4) continue;
    const first = pts[0], last = pts[pts.length - 1];
    const closesItself = Math.hypot(first[0] - last[0], first[1] - last[1]) <= TOL;
    if (closesItself) pts = pts.slice(0, -1);
    else if (!sp.closed) continue;
    if (pts.length < 3) continue;
    if (sp.curved) curved++;
    rings.push(pts);
  }
  return { rings, curved };
}

// გეგმაზე დაწერილი ფართობი + მისი სიზუსტე: "6" ნიშნავს 5.5-6.5 კვ.მ-ს (დამრგვალების ნახევარი = 0.5), "6.25" - 0.005
function parseAreaText(raw) {
  const t = raw.replace(/\s/g, '').replace(',', '.');
  const decimals = (t.split('.')[1] || '').length;
  return { value: parseFloat(t), halfUnit: 0.5 * 10 ** -decimals };
}

// ლეიბლი, რომლის ასოებს შორის PDF-ში შემთხვევითი სივრცეებია ("s ak adastr o k odi"): ყოველ ასოს შორის \s*
const spacedLabel = (words) => new RegExp(words.split(' ').map(w => [...w].join('\\s*')).join('\\s+'), 'i');
const CODE_LABEL = spacedLabel('sakadastro kodi'), AREA_LABEL = spacedLabel('miwis nakveTis farTobi');
function legacyMeta(items) { // ძველი (2015-იანი) ფორმატი: ლეიბლი და მნიშვნელობა ერთ ხაზზე, ცალკე ელემენტებად
  const out = { code: null, areaPdf: null, areaHalfUnit: null };
  const after = (lab) => items.filter(i => i !== lab && Math.abs(i.y - lab.y) < 3 && i.x >= lab.x + lab.w - 2).sort((a, b) => a.x - b.x);
  const codeLab = items.find(i => CODE_LABEL.test(i.str));
  if (codeLab) {
    const raw = after(codeLab).map(i => i.str.trim()).filter(Boolean);
    const CODE = /^(\d{2}\.\d{2}\.\d{2}\.\d{3}(?:\.\d{3})?)/;
    const m = raw.join('').replace(/\s/g, '').match(CODE) || raw.join('.').match(new RegExp(CODE.source + '$'));
    if (m) out.code = m[1];
  }
  const areaLab = items.find(i => AREA_LABEL.test(i.str));
  if (areaLab) {
    const m = after(areaLab).map(i => i.str.trim()).join(' ').match(/(\d[\d\s.,]*?)\s*kv\s*\.?\s*m/i);
    if (m) { const a = parseAreaText(m[1]); out.areaPdf = a.value; out.areaHalfUnit = a.halfUnit; }
  }
  return out;
}

function parseMeta(text, items = []) {
  const code = text.match(/საკადასტრო\s+კოდი\s*:\s*([\d.]+)/);
  // ფართობები: "NNN კვ.მ (WGS 84 / UTM zone 38N)"; დასავლეთ საქართველოს PDF-ებში ორია (37N და 38N)
  const areaList = [];
  const ENTRY = String.raw`\d[\d\s.,]*?\s*კ\s*ვ\s*\.?\s*მ\s*(?:\(\s*WGS\s*84\s*\/\s*U\s*TM\s+zone\s*\d+\s*[NS]\s*\))?`;
  const groupRe = new RegExp(String.raw`ფართობი\s*:\s*((?:${ENTRY}\s*)+)`, 'g');
  const entryRe = new RegExp(String.raw`(\d[\d\s.,]*?)\s*კ\s*ვ\s*\.?\s*მ\s*(?:\(\s*WGS\s*84\s*\/\s*U\s*TM\s+zone\s*(\d+)\s*([NS])\s*\))?`, 'g');
  let gm;
  while ((gm = groupRe.exec(text))) { // ერთი ლეიბლის შემდეგ ერთი ან ორი ფართობი (37N/38N)
    if (/ვალდებულების\s*$/.test(text.slice(Math.max(0, gm.index - 20), gm.index))) continue; // "ვალდებულების ფართობი" გამოვტოვოთ
    let em; entryRe.lastIndex = 0;
    while ((em = entryRe.exec(gm[1]))) { const a = parseAreaText(em[1]); areaList.push({ area: a.value, halfUnit: a.halfUnit, zone: em[2] ? +em[2] : null }); }
    break; // პირველი (არა-ვალდებულების) ჯგუფი საკმარისია
  }
  // რუკის კოორდინატთა სისტემა: ცალკე სტრიქონი "კოორდინატთა სისტემა: WGS 84 / UTM zone 37N".
  // (ფართობის სტრიქონებში ნახსენები ზონა რუკის ზონას არ ნიშნავს!)
  const crs = text.match(/კოორდინატთა\s+სისტემა\s*:\s*WGS\s*84\s*\/\s*U\s*TM\s+zone\s*(\d+)\s*([NS])/);
  let zone = crs ? +crs[1] : null, hemi = crs ? crs[2] : 'N';
  if (zone === null) { // სხვაგან ნახსენები ზონა: ვიღებთ მხოლოდ თუ ერთადერთია
    const all = [...text.matchAll(/U\s*TM\s+zone\s*(\d+)\s*([NS])/g)];
    const zs = new Set(all.map(x => +x[1]));
    if (zs.size === 1) { zone = +all[0][1]; hemi = all[0][2]; }
  }
  let areaPdf = null, areaZone = null, areaHalfUnit = null;
  if (areaList.length) {
    const hit = (zone !== null && areaList.find(a => a.zone === zone)) || areaList[0];
    areaPdf = hit.area; areaZone = hit.zone; areaHalfUnit = hit.halfUnit;
  }
  let codeStr = code ? code[1] : null;
  if (!codeStr || areaPdf == null) {
    const lg = legacyMeta(items);
    codeStr = codeStr || lg.code; if (areaPdf == null) { areaPdf = lg.areaPdf; areaHalfUnit = lg.areaHalfUnit; }
  }
  // მასშტაბი "1:500" (ძველ ფორმატში ცალკე ელემენტია); გამოიყენება ერთხაზიანი ბადის შესამოწმებლად
  const sc = text.match(/(?:^|[^\d.:])1\s*:\s*(100|200|250|500|1000|2000|2500|5000|10000)(?![\d.])/);
  const legacyFormat = /sakadastro\s+(?:gegma|kodi)|miwis\s+nakveTis/i.test(text); // AcadNusx = ArcMap 2008-2015
  return { code: codeStr, areaPdf, areaZone, areaHalfUnit, areaList, zone: zone ?? 38, hemi, zoneAssumed: zone === null,
    mapScale: sc ? +sc[1] : null, legacyFormat };
}

const distToRing = (p, ring) => { // წერტილიდან რგოლის საზღვრამდე უმცირესი მანძილი
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    const dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy;
    let t = L ? ((p[0] - x0) * dx + (p[1] - y0) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p[0] - (x0 + t * dx), p[1] - (y0 + t * dy)));
  }
  return best;
};
const ringArea = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length]; s += x0 * y1 - x1 * y0; } return s / 2; };
function pointInRing(pt, r) { // ray casting
  let inside = false; const [x, y] = pt;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function interiorPoint(r) { // წერტილი რგოლის შიგნით (შესამოწმებლად ხვრელებისთვის)
  const ys = r.map(p => p[1]); const y = (Math.min(...ys) + Math.max(...ys)) / 2;
  const xs = [];
  for (let i = 0; i < r.length; i++) {
    const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length];
    if ((y0 > y) !== (y1 > y)) xs.push(x0 + (y - y0) * (x1 - x0) / (y1 - y0));
  }
  xs.sort((a, b) => a - b);
  return [(xs[0] + xs[1]) / 2, y];
}

// ---------- UTM -> WGS84 (Krüger, 6 რიგი) ----------
function utmToLonLat(E, N, zone, hemi) {
  const a = 6378137.0, f = 1 / 298.257223563, k0 = 0.9996;
  const n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
  const A = a / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  const beta = [
    n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512 + 96199 * n6 / 604800,
    n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105 - 1118711 * n6 / 3870720,
    17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480 + 5569 * n6 / 90720,
    4397 * n4 / 161280 - 11 * n5 / 504 - 830251 * n6 / 7257600,
    4583 * n5 / 161280 - 108847 * n6 / 3991680,
    20648693 * n6 / 638668800];
  const delta = [
    2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45 + 26 * n5 / 45 - 2854 * n6 / 675,
    7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45 + 2704 * n5 / 315 + 2323 * n6 / 945,
    56 * n3 / 15 - 136 * n4 / 35 - 1262 * n5 / 105 + 73814 * n6 / 2835,
    4279 * n4 / 630 - 332 * n5 / 35 - 399572 * n6 / 14175,
    4174 * n5 / 315 - 144838 * n6 / 6237,
    601676 * n6 / 22275];
  const xi0 = (N - (hemi === 'S' ? 10000000 : 0)) / (k0 * A), eta0 = (E - 500000) / (k0 * A);
  let xi = xi0, eta = eta0;
  for (let j = 1; j <= 6; j++) {
    xi -= beta[j - 1] * Math.sin(2 * j * xi0) * Math.cosh(2 * j * eta0);
    eta -= beta[j - 1] * Math.cos(2 * j * xi0) * Math.sinh(2 * j * eta0);
  }
  const chi = Math.asin(Math.sin(xi) / Math.cosh(eta));
  let phi = chi;
  for (let j = 1; j <= 6; j++) phi += delta[j - 1] * Math.sin(2 * j * chi);
  const lon0 = (zone * 6 - 183) * Math.PI / 180;
  const lam = lon0 + Math.atan2(Math.sinh(eta), Math.cos(xi));
  return [lam * 180 / Math.PI, phi * 180 / Math.PI];
}

// ---------- ზონის შემოწმება/განსაზღვრა (საქართველო: ~40.0-46.8°E, 41.0-43.6°N) ----------
const inGeorgia = (lon, lat) => lon >= 39.9 && lon <= 46.8 && lat >= 41.0 && lat <= 43.7;
function groupsInGeorgia(groups, zone, hemi) { // ყველა წვერო საქართველოს ფარგლებშია?
  return groups.every(g => g.outer.every(([x, y]) => { const [lo, la] = utmToLonLat(x, y, zone, hemi); return inGeorgia(lo, la); }));
}
function detectZone(groups, hemi = 'N') { // რომელი ზონა(ები) ათავსებს ნაკვეთს საქართველოში
  return [37, 38].filter(z => groupsInGeorgia(groups, z, hemi));
}

// ---------- მთავარი გადამუშავება ----------
// ფართობის შედარება. ზღვარი 1%, მაგრამ პატარა ნაკვეთზე გეგმის ფართობის დამრგვალება თავად აჭარბებს 1%-ს
// (მაგ. "6 კვ.მ" = 5.5-6.5, ანუ ±8.3%). ამიტომ ზღვარი = max(1%, დამრგვალების ნახევარი / ფართობი).
// geomPct: ფართობის ცდომილება, რასაც გეგმის ხაზების სიზუსტე იძლევა (პერიმეტრი × 0.25 pt × მასშტაბი).
// 447 გეგმის შედარებამ maps.gov.ge-სთან (2026-11-20) აჩვენა: წვეროების ხმაური ~0.35-0.4 pt; პატარა ნაკვეთზე
// (მაგ. 8 კვ.მ, 1:500) ეს ფართობს 5-7%-ით ცვლის, ამიტომ მხოლოდ 1% / დამრგვალება ცრუ გაფრთხილებას იძლეოდა.
function areaCheck(meta, areaCalc, warnings, notes, geomPct = 0) {
  if (!meta.areaPdf) return { diffPct: NaN, areaTolerancePct: 1 };
  const diffPct = (areaCalc - meta.areaPdf) / meta.areaPdf * 100;
  const roundingPct = (meta.areaHalfUnit ?? 0) / meta.areaPdf * 100;
  const areaTolerancePct = Math.max(1, roundingPct, geomPct);
  if (Math.abs(diffPct) > areaTolerancePct) {
    const why = geomPct >= roundingPct && geomPct > 1 ? 'ხაზების სიზუსტის გათვალისწინებით' : 'დამრგვალების გათვალისწინებით';
    warnings.push(`ფართობის სხვაობა ${diffPct.toFixed(2)}% (>${areaTolerancePct > 1 ? areaTolerancePct.toFixed(1) + '%, ' + why : '1%'}) — შედეგი ხელით გადაამოწმეთ.`);
  } else if (Math.abs(diffPct) > 1 && geomPct > roundingPct && Math.abs(diffPct) > Math.max(1, roundingPct)) {
    notes.push(`ფართობის სხვაობა ${diffPct.toFixed(2)}% გეგმის ხაზების სიზუსტის ფარგლებშია (±${geomPct.toFixed(1)}%: ხაზის ±0.25 pt ქაღალდზე ≈ ±${(geomPct / 100 * areaCalc).toFixed(2)} კვ.მ).`);
  } else if (Math.abs(diffPct) > 1) {
    const h = meta.areaHalfUnit;
    notes.push(`ფართობის სხვაობა ${diffPct.toFixed(2)}% მხოლოდ დამრგვალებაა: გეგმაში ${meta.areaPdf} კვ.მ წერია, ანუ ${+(meta.areaPdf - h).toFixed(3)}–${+(meta.areaPdf + h).toFixed(3)} კვ.მ; გამოთვლილი ${areaCalc.toFixed(2)} კვ.მ ამ ფარგლებშია.`);
  }
  return { diffPct, areaTolerancePct };
}

// ერთხაზიანი ბადე: ერთი ღერძის მასშტაბი მეორიდანაა აღებული. ძველ (ArcMap, AcadNusx) ფორმატში გვერდი ნომინალურ
// მასშტაბშია დაბეჭდილი, ამიტომ თუ გამოთვლილი მასშტაბი გეგმაზე დაწერილ "1:N"-ს ემთხვევა (≤0.5%), ვარაუდი დადასტურებულია.
// ახალ (Gnostice) ფორმატში X/Y ~1.5%-ით განსხვავდება - იქ გაფრთხილება რჩება.
function singleGridLineCheck(meta, info, warnings, notes) {
  const axis = info.isoAxis === 'x' ? 'X' : 'Y';
  const measured = Math.abs(info.isoAxis === 'x' ? info.scaleY : info.scaleX); // მ / pt, ორხაზიანი ღერძიდან
  const nominal = meta.mapScale ? meta.mapScale * 0.0254 / 72 : null;
  const offPct = nominal ? Math.abs(measured / nominal - 1) * 100 : null;
  if (meta.legacyFormat && offPct !== null && offPct <= 0.5) {
    notes.push(`${axis} ღერძზე მხოლოდ ერთი ბადის ხაზია; მასშტაბი მეორე ღერძიდან არის აღებული და ემთხვევა გეგმაზე დაწერილ 1:${meta.mapScale}-ს (სხვაობა ${offPct.toFixed(2)}%).`);
  } else {
    warnings.push(`${axis} ღერძზე მხოლოდ ერთი ბადის ხაზია; მისი მასშტაბი მეორე ღერძიდან არის აღებული (ვარაუდი: ორივე ღერძის მასშტაბი ტოლია)` +
      (offPct !== null ? `; გეგმაზე დაწერილ 1:${meta.mapScale}-თან სხვაობა ${offPct.toFixed(2)}%` : '') + '. ფართობის სხვაობა გადაამოწმეთ.');
  }
}

function buildGeometry(ex) {
  const meta = parseMeta(ex.text, ex.items);
  const { fn, info } = buildTransform(ex);
  const { rings: ringsPx, curved } = chainRings(ex.painted);
  if (!ringsPx.length) throw new Error(ex.imageOps >= 3 ? 'ამ PDF-ში რუკა სურათია (რასტრი), საზღვარი ვექტორული ხაზის სახით არ არის. ზუსტი გარდაქმნა ამ მეთოდით შეუძლებელია.' : 'წითელი საზღვრის რგოლი ვერ მოიძებნა');
  const allUtm = ringsPx.map(r => r.map(([x, y]) => fn(x, y)));
  // ArcMap ზოგჯერ საზღვარს ორჯერ ხატავს: იგივე რგოლი ხვრელად არ უნდა ჩაითვალოს
  const ringsUtm = [], notes = [];
  for (const r of allUtm) {
    const A = Math.abs(ringArea(r));
    // დუბლიკატი: ფართობი ემთხვევა და ერთ-ერთი რგოლის ყველა წვერო მეორის საზღვარზე დევს
    // (ერთ ასლს შეიძლება დამატებითი წვერო ჰქონდეს - ვინარჩუნებთ უფრო დეტალურს)
    // ან: ორივე მიმართულებით ყველა წვერო მეორე რგოლის საზღვართან (≤ max(5 სმ, 1 pt)): ასლს შეიძლება
    // დამატებითი წვერო ჰქონდეს გვერდის შუაში, რაც პატარა ნაკვეთზე ფართობს >0.1%-ით ცვლის (ძველი ArcMap)
    const dupTol = Math.max(0.05, 1.0 * Math.max(Math.abs(info.scaleX), Math.abs(info.scaleY)));
    const di = ringsUtm.findIndex(k => (Math.abs(Math.abs(ringArea(k)) - A) <= 1e-3 * A &&
      (r.every(p => distToRing(p, k) <= 0.05) || k.every(p => distToRing(p, r) <= 0.05))) ||
      (Math.abs(Math.abs(ringArea(k)) - A) <= 0.05 * A && r.every(p => distToRing(p, k) <= dupTol) && k.every(p => distToRing(p, r) <= dupTol)));
    if (di >= 0) { if (r.length > ringsUtm[di].length) ringsUtm[di] = r; notes.push('PDF-ში ერთი და იგივე საზღვარი ორჯერ იყო დახატული; დუბლიკატი გამოვრიცხე.'); }
    else ringsUtm.push(r);
  }
  const order = ringsUtm.map((_, i) => i).sort((i, j) => Math.abs(ringArea(ringsUtm[j])) - Math.abs(ringArea(ringsUtm[i])));
  const groups = [];
  for (const i of order) {
    const host = groups.find(g => pointInRing(interiorPoint(ringsUtm[i]), g.outer));
    if (host) host.holes.push(ringsUtm[i]); else groups.push({ outer: ringsUtm[i], holes: [] });
  }
  const areaCalc = groups.reduce((s, g) => s + Math.abs(ringArea(g.outer)) - g.holes.reduce((q, h) => q + Math.abs(ringArea(h)), 0), 0);
  for (const gr of groups) for (const h of gr.holes)
    if (Math.abs(ringArea(h)) > 0.5 * Math.abs(ringArea(gr.outer))) notes.push('⚠ ხვრელი გარე რგოლის ფართობის ნახევარზე დიდია — საეჭვოა (შეიძლება ცალკე ნაკვეთი ან დუბლიკატი იყოს).');
  const warnings = [];
  meta.zoneCandidates = detectZone(groups, meta.hemi);
  if (meta.zoneAssumed) { // ძველ ფორმატში ზონა არ წერია
    if (meta.zoneCandidates.length === 1) { meta.zone = meta.zoneCandidates[0]; meta.zoneAuto = true; }
  } else if (meta.zoneCandidates.length === 1 && meta.zoneCandidates[0] !== meta.zone) {
    // PDF-ში ზონა წერია, მაგრამ ამ კოორდინატებით ნაკვეთი საქართველოს გარეთ ხვდება -> წარწერა არასწორია
    meta.zoneStated = meta.zone; meta.zone = meta.zoneCandidates[0]; meta.zoneCorrected = true;
  }
  if (meta.zoneAssumed && meta.areaList && meta.areaList.length > 1) { // ორი ფართობიდან ზონას შესაბამისი
    const hit = meta.areaList.find(a => a.zone === meta.zone);
    if (hit) { meta.areaPdf = hit.area; meta.areaZone = hit.zone; meta.areaHalfUnit = hit.halfUnit; }
  }
  const perimeter = ringsUtm.reduce((sum, r) => sum + r.reduce((q, p, i) => { const n = r[(i + 1) % r.length]; return q + Math.hypot(n[0] - p[0], n[1] - p[1]); }, 0), 0);
  const geomPct = areaCalc > 0 ? 100 * perimeter * 0.25 * Math.max(Math.abs(info.scaleX), Math.abs(info.scaleY)) / areaCalc : 0;
  const { diffPct, areaTolerancePct } = areaCheck(meta, areaCalc, warnings, notes, geomPct);
  if (info.isoAxis) singleGridLineCheck(meta, info, warnings, notes);
  if (curved) warnings.push('საზღვარში მრუდი სეგმენტებია; ისინი ქორდებით არის მიახლოებული, ამიტომ სიზუსტე ვერ გარანტირდება.');
  if (!Number.isFinite(diffPct)) warnings.push('PDF-ში ფართობი ვერ წავიკითხე, ფართობით გადამოწმება ვერ მოხერხდა.');
  if (info.residX > 0.5 || info.residY > 0.5) warnings.push(`ბადის საყრდენების ნარჩენი ${Math.max(info.residX, info.residY).toFixed(2)} მ — მასშტაბი არაერთგვაროვანია.`);
  return { meta, info, groups, areaCalc, diffPct, areaTolerancePct, warnings, notes, ringCount: ringsUtm.length,
    vertexCount: ringsUtm.reduce((s, r) => s + r.length, 0) };
}

function toLonLat(groups, zone, hemi) {
  const conv = (ring) => [...ring, ring[0]].map(([x, y]) => utmToLonLat(x, y, zone, hemi));
  return groups.map(g => ({ outer: conv(g.outer), holes: g.holes.map(conv) }));
}

// ---------- KML ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function makeKML(name, polysLL) {
  const ring = (c) => c.map(([lo, la]) => `${lo.toFixed(8)},${la.toFixed(8)},0`).join(' ');
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>', `<name>${esc(name)}</name>`];
  for (const p of polysLL) {
    out.push(`<Placemark><name>${esc(name)}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring(p.outer)}</coordinates></LinearRing></outerBoundaryIs>`);
    for (const h of p.holes) out.push(`<innerBoundaryIs><LinearRing><coordinates>${ring(h)}</coordinates></LinearRing></innerBoundaryIs>`);
    out.push('</Polygon></Placemark>');
  }
  out.push('</Document></kml>');
  return out.join('\n');
}

// ---------- Shapefile (.shp .shx .dbf .prj) ----------
function makePRJ(zone, hemi) {
  const cm = zone * 6 - 183, fn = hemi === 'S' ? 10000000 : 0;
  return `PROJCS["WGS_1984_UTM_Zone_${zone}${hemi}",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",${fn.toFixed(1)}],PARAMETER["Central_Meridian",${cm.toFixed(1)}],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`;
}

// რამდენიმე ნაკვეთი ერთ KML-ში: items = [{name, polysLL, description}]
function makeKMLMulti(docName, items) {
  const ring = (c) => c.map(([lo, la]) => `${lo.toFixed(8)},${la.toFixed(8)},0`).join(' ');
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>', `<name>${esc(docName)}</name>`];
  for (const it of items) for (const p of it.polysLL) {
    out.push(`<Placemark><name>${esc(it.name)}</name>` + (it.description ? `<description>${esc(it.description)}</description>` : '') + `<Polygon><outerBoundaryIs><LinearRing><coordinates>${ring(p.outer)}</coordinates></LinearRing></outerBoundaryIs>`);
    for (const h of p.holes) out.push(`<innerBoundaryIs><LinearRing><coordinates>${ring(h)}</coordinates></LinearRing></innerBoundaryIs>`);
    out.push('</Polygon></Placemark>');
  }
  out.push('</Document></kml>');
  return out.join('\n');
}

function makeShapefile(groups, rec) {
  // shapefile: გარე რგოლი საათის ისრის მიმართულებით (ხელმოწერილი ფართობი < 0), ხვრელები - საპირისპიროდ
  const orient = (ring, cw) => {
    let r = [...ring, ring[0]];
    const sa = ringArea(ring); // > 0 = ისრის საწინააღმდეგო
    const isCw = sa < 0;
    return (isCw === cw) ? r : r.slice().reverse();
  };
  const shapes = groups.map(g => [orient(g.outer, true), ...g.holes.map(h => orient(h, false))]);
  // ზომები
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  const recs = shapes.map(parts => {
    const pts = parts.flat();
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const [x, y] of pts) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
    xmin = Math.min(xmin, bx0); ymin = Math.min(ymin, by0); xmax = Math.max(xmax, bx1); ymax = Math.max(ymax, by1);
    const contentLen = 44 + 4 * parts.length + 16 * pts.length;
    return { parts, pts, bbox: [bx0, by0, bx1, by1], contentLen };
  });
  const shpLen = 100 + recs.reduce((s, r) => s + 8 + r.contentLen, 0);
  const shxLen = 100 + 8 * recs.length;
  const shp = new DataView(new ArrayBuffer(shpLen)), shx = new DataView(new ArrayBuffer(shxLen));
  const header = (dv, lenBytes) => {
    dv.setInt32(0, 9994, false); dv.setInt32(24, lenBytes / 2, false);
    dv.setInt32(28, 1000, true); dv.setInt32(32, 5, true);
    [xmin, ymin, xmax, ymax, 0, 0, 0, 0].forEach((v, i) => dv.setFloat64(36 + 8 * i, v, true));
  };
  header(shp, shpLen); header(shx, shxLen);
  let off = 100;
  recs.forEach((r, i) => {
    shx.setInt32(100 + 8 * i, off / 2, false); shx.setInt32(104 + 8 * i, r.contentLen / 2, false);
    shp.setInt32(off, i + 1, false); shp.setInt32(off + 4, r.contentLen / 2, false);
    let o = off + 8;
    shp.setInt32(o, 5, true); r.bbox.forEach((v, k) => shp.setFloat64(o + 4 + 8 * k, v, true));
    shp.setInt32(o + 36, r.parts.length, true); shp.setInt32(o + 40, r.pts.length, true);
    let idx = 0, po = o + 44;
    for (const p of r.parts) { shp.setInt32(po, idx, true); po += 4; idx += p.length; }
    for (const [x, y] of r.pts) { shp.setFloat64(po, x, true); shp.setFloat64(po + 8, y, true); po += 16; }
    off += 8 + r.contentLen;
  });
  // DBF
  const fields = [['CAD_CODE', 'C', 24, 0], ['AREA_PDF', 'N', 14, 2], ['AREA_CALC', 'N', 14, 2]];
  const recLen = 1 + fields.reduce((s, f) => s + f[2], 0), hdrLen = 32 + 32 * fields.length + 1;
  const dbf = new Uint8Array(hdrLen + recLen * recs.length + 1);
  const dv = new DataView(dbf.buffer);
  const now = new Date();
  dbf[0] = 3; dbf[1] = now.getFullYear() - 1900; dbf[2] = now.getMonth() + 1; dbf[3] = now.getDate();
  dv.setUint32(4, recs.length, true); dv.setUint16(8, hdrLen, true); dv.setUint16(10, recLen, true);
  const enc = new TextEncoder();
  fields.forEach((f, i) => {
    const o = 32 + 32 * i; dbf.set(enc.encode(f[0]), o); dbf[o + 11] = f[1].charCodeAt(0); dbf[o + 16] = f[2]; dbf[o + 17] = f[3];
  });
  dbf[32 + 32 * fields.length] = 0x0D;
  let o = hdrLen;
  const vals = [String(rec.code ?? ''), (rec.areaPdf ?? 0).toFixed(2), rec.areaCalc.toFixed(2)];
  for (let i = 0; i < recs.length; i++) {
    dbf[o++] = 0x20;
    fields.forEach((f, k) => {
      const s = f[1] === 'C' ? vals[k].padEnd(f[2], ' ').slice(0, f[2]) : vals[k].padStart(f[2], ' ').slice(-f[2]);
      dbf.set(enc.encode(s), o); o += f[2];
    });
  }
  dbf[o] = 0x1A;
  return { shp: new Uint8Array(shp.buffer), shx: new Uint8Array(shx.buffer), dbf, prj: enc.encode(makePRJ(rec.zone, rec.hemi)) };
}

// ---------- ZIP (store, შეკუმშვის გარეშე) ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function makeZip(files) { // files: [{name, data(Uint8Array)}]
  const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0)); let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

function safeName(code, fallback) { return (code || fallback || 'parcel').replace(/\./g, '_'); }

// =====================================================================
// რასტრული რეჟიმი: საზღვარი PDF-ში სურათადაა (წითელი პიქსელები).
// ბადე (ხაზები + ციფრები) ვექტორულია, ამიტომ გეორეფერენსი ზუსტია; შეზღუდვა სურათის გარჩევადობაა.
// =====================================================================

// მკაცრი ევკლიდური მანძილის ტრანსფორმაცია (Felzenszwalb & Huttenlocher). src: 1 = სამიზნე პიქსელი.
function edt(src, W, H) {
  const INF = 1e20, f = new Float64Array(Math.max(W, H)), d = new Float64Array(Math.max(W, H));
  const v = new Int32Array(Math.max(W, H)), z = new Float64Array(Math.max(W, H) + 1);
  const out = new Float32Array(W * H);
  const pass = (n) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      while (true) { const p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); if (s <= z[k] && k > 0) k--; else break; }
      if (s <= z[k]) { v[0] = q; z[0] = -INF; z[1] = INF; k = 0; continue; }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
  };
  for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) f[y] = src[y * W + x] ? 0 : INF; pass(H); for (let y = 0; y < H; y++) out[y * W + x] = d[y]; }
  for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) f[x] = out[y * W + x]; pass(W); for (let x = 0; x < W; x++) out[y * W + x] = Math.sqrt(d[x]); }
  return out;
}

function boxMorph(src, W, H, r, dilate) { // კვადრატული დილატაცია/ეროზია (გამყოფი, O(N)); ჩარჩოს გარეთ: ეროზიისთვის "სავსე"
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  const line = (get, set, n) => {
    let c = 0, valid = 0;
    for (let i = 0; i < Math.min(r, n); i++) { c += get(i); valid++; }
    for (let i = 0; i < n; i++) {
      const a = i + r; if (a < n) { c += get(a); valid++; }
      const b = i - r - 1; if (b >= 0) { c -= get(b); valid--; }
      set(i, dilate ? (c > 0 ? 1 : 0) : (c === valid ? 1 : 0));
    }
  };
  for (let y = 0; y < H; y++) { const o = y * W; line(i => src[o + i], (i, v) => { tmp[o + i] = v; }, W); }
  for (let x = 0; x < W; x++) line(i => tmp[i * W + x], (i, v) => { out[i * W + x] = v; }, H);
  return out;
}

function largestComponent(mask, W, H, eight) {
  const lab = new Int32Array(W * H), stack = new Int32Array(W * H);
  let best = 0, bestN = 0, cur = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || lab[i]) continue;
    cur++; let sp = 0, n = 0; stack[sp++] = i; lab[i] = cur;
    while (sp) {
      const p = stack[--sp]; n++; const x = p % W, y = (p / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; if (!eight && dx && dy) continue;
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx; if (mask[q] && !lab[q]) { lab[q] = cur; stack[sp++] = q; }
      }
    }
    if (n > bestN) { bestN = n; best = cur; }
  }
  const out = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) out[i] = lab[i] === best ? 1 : 0;
  return { mask: out, n: bestN };
}

function floodOutside(block, W, H) { // გარე არე: ჩარჩოს კიდიდან, ბლოკის გარეშე (4-მეზობლობა)
  const out = new Uint8Array(W * H), stack = new Int32Array(W * H); let sp = 0;
  const push = (q) => { if (!block[q] && !out[q]) { out[q] = 1; stack[sp++] = q; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (sp) { const p = stack[--sp]; const x = p % W, y = (p / W) | 0;
    if (x > 0) push(p - 1); if (x < W - 1) push(p + 1); if (y > 0) push(p - W); if (y < H - 1) push(p + W); }
  return out;
}

function traceOuter(mask, W, H) { // გარე საზღვარი პიქსელების კიდეებზე (კუთხეების კოორდინატები)
  // ვიპოვოთ საწყისი: ზედა-მარცხენა პიქსელი; ზედა კიდე მარცხნიდან მარჯვნივ
  let s = -1; for (let i = 0; i < W * H; i++) if (mask[i]) { s = i; break; }
  if (s < 0) return [];
  const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1;
  const sx = s % W, sy = (s / W) | 0;
  // მიმართულებები: 0=E,1=S,2=W,3=N (y ქვემოთ); შიგნითა მხარე - მარჯვნივ
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  let x = sx, y = sy, dir = 0; const pts = [[x, y]];
  const guard = 4 * W * H;
  for (let it = 0; it < guard; it++) {
    // წინა კუთხეში, dir მიმართულებით: ვამოწმებთ ორ პიქსელს წინ (მარცხნივ/მარჯვნივ)
    const L = (d) => { // პიქსელი მარცხნივ წინ
      if (d === 0) return at(x, y - 1); if (d === 1) return at(x, y); if (d === 2) return at(x - 1, y); return at(x - 1, y - 1); };
    const R = (d) => {
      if (d === 0) return at(x, y); if (d === 1) return at(x - 1, y); if (d === 2) return at(x - 1, y - 1); return at(x, y - 1); };
    // მარჯვნივ მოხვევა, პირდაპირ, მარცხნივ (შიგნითა მხარე მარჯვნივ)
    let nd;
    if (L(dir)) nd = (dir + 3) % 4;          // მარცხნივ წინ შევსებულია -> მარცხნივ მოხვევა
    else if (R(dir)) nd = dir;               // პირდაპირ
    else nd = (dir + 1) % 4;                 // მარჯვნივ მოხვევა
    dir = nd; x += DX[dir]; y += DY[dir];
    if (x === sx && y === sy) break;
    pts.push([x, y]);
  }
  return pts;
}

function dpSimplify(pts, tol, wantIdx) { // დაგლას-პეკერი დახურული რგოლისთვის
  const n = pts.length; if (n < 4) return pts.slice();
  // საწყისად ორი ყველაზე დაშორებული წერტილი
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < n; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > best) { best = d; b = i; } }
  best = -1; for (let i = 0; i < n; i++) { const d = (pts[i][0] - pts[b][0]) ** 2 + (pts[i][1] - pts[b][1]) ** 2; if (d > best) { best = d; a = i; } }
  const keep = new Uint8Array(n); keep[a] = keep[b] = 1;
  const rec = (i, j) => { // i -> j (წრიულად)
    const [x0, y0] = pts[i], [x1, y1] = pts[j]; const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
    let m = -1, md = -1;
    for (let k = (i + 1) % n; k !== j; k = (k + 1) % n) { const d = Math.abs((pts[k][0] - x0) * dy - (pts[k][1] - y0) * dx) / L; if (d > md) { md = d; m = k; } }
    if (md > tol) { keep[m] = 1; rec(i, m); rec(m, j); }
  };
  rec(a, b); rec(b, a);
  if (wantIdx) { const idx = []; for (let i = 0; i < n; i++) if (keep[i]) idx.push(i); return idx; }
  return pts.filter((_, i) => keep[i]);
}

const RASTER_TOL = 1.0;

// მახვილი წვერების აღდგენა: სქელი ხაზი მახვილ კუთხეში წვერს "აჭრის" (მოკლე გვერდი ან ერთი წერტილი).
// მოკლე გვერდს ვცვლით მეზობელი გრძელი გვერდების გაგრძელებების გადაკვეთით.
function restoreTips(p, lw) {
  let pts = p.slice();
  const seg = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const inter = (a, b, c, d) => { // წრფე ab და წრფე cd
    const r = [b[0] - a[0], b[1] - a[1]], q = [d[0] - c[0], d[1] - c[1]], den = r[0] * q[1] - r[1] * q[0];
    if (Math.abs(den) < 1e-9) return null; const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den; return [a[0] + t * r[0], a[1] + t * r[1]];
  };
  for (let pass = 0; pass < 50 && pts.length > 4; pass++) {
    const n = pts.length; let done = false;
    for (let i = 0; i < n && !done; i++) {
      // "ქუდი": B=pts[i] ... C=pts[j], 1-4 მოკლე გვერდი; A->B და C->D გრძელია
      let j = i, total = 0;
      for (let k = 0; k < 4; k++) {
        const L = seg(pts[(j) % n], pts[(j + 1) % n]); if (L > 2.5 * lw || total + L > 5 * lw) break;
        total += L; j++;
        const A = pts[(i - 1 + n) % n], B = pts[i % n], C = pts[j % n], D = pts[(j + 1) % n];
        const lAB = seg(A, B), lCD = seg(C, D);
        if (lAB < 2 * total || lCD < 2 * total) continue;
        const ux = (B[0] - A[0]) / lAB, uy = (B[1] - A[1]) / lAB, vx = (D[0] - C[0]) / lCD, vy = (D[1] - C[1]) / lCD;
        if (-(ux * vx + uy * vy) < Math.cos(70 * Math.PI / 180)) continue; // მხოლოდ მახვილი (< 70°)
        const X = inter(A, B, C, D); if (!X) continue;
        if ((X[0] - B[0]) * ux + (X[1] - B[1]) * uy < -0.5 || (C[0] - X[0]) * vx + (C[1] - X[1]) * vy < -0.5) continue;
        const M = [(B[0] + C[0]) / 2, (B[1] + C[1]) / 2]; if (seg(X, M) > 8 * lw) continue;
        // B..C (k+2 წერტილი) -> X
        const cnt = j - i + 1, rm = [];
        for (let q = 0; q < cnt; q++) rm.push((i + q) % n);
        const keep = pts.filter((_, idx) => !rm.includes(idx));
        const insertAt = keep.indexOf(pts[(j + 1) % n]);
        keep.splice(insertAt, 0, X); pts = keep; done = true; break;
      }
    }
    if (!done) break;
  }
  return pts;
}

function mergeCollinear(p, tol) { // თითქმის ერთ წრფეზე მდებარე წვეროების მოშორება
  let pts = p.slice(), changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      const d = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / L;
      if (d < tol) { pts.splice(i, 1); changed = true; i--; }
    }
  }
  return pts;
}

// თითო გვერდზე წრფის მორგება (ჯამური უმცირესი კვადრატები) და მეზობელი წრფეების გადაკვეთა:
// საფეხურებიანი პიქსელური კიდის ცდომილება საშუალოდ ქრება
function refitPolygon(pts, idx, guard = 6) {
  const n = pts.length, m = idx.length, lines = [];
  for (let s = 0; s < m; s++) {
    const i = idx[s], j = idx[(s + 1) % m];
    const seg = []; for (let k = i; k !== j; k = (k + 1) % n) seg.push(pts[k]); seg.push(pts[j]);
    const trim = seg.length > 8 ? 2 : (seg.length > 4 ? 1 : 0);
    const use = seg.slice(trim, seg.length - trim);
    let mx = 0, my = 0; for (const p of use) { mx += p[0]; my += p[1]; } mx /= use.length; my /= use.length;
    let sxx = 0, syy = 0, sxy = 0; for (const p of use) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); // მთავარი მიმართულება
    lines.push({ px: mx, py: my, ux: Math.cos(th), uy: Math.sin(th), ok: use.length >= 3 });
  }
  const out = [];
  for (let s = 0; s < m; s++) {
    const A = lines[(s - 1 + m) % m], B = lines[s], P = pts[idx[s]];
    const det = A.ux * B.uy - A.uy * B.ux;
    if (!A.ok || !B.ok || Math.abs(det) < Math.sin(4 * Math.PI / 180)) { out.push(P); continue; }
    const t = ((B.px - A.px) * B.uy - (B.py - A.py) * B.ux) / det;
    const X = [A.px + t * A.ux, A.py + t * A.uy];
    out.push(Math.hypot(X[0] - P[0], X[1] - P[1]) < guard ? X : P); // უსაფრთხოება: შორს თუ გავიდა, ძველი წერტილი
  }
  return out;
}

// rgba: Uint8ClampedArray (W*H*4) - რუკის ჩარჩოს ამონაჭერი. nativePx: რენდერის პიქსელი ერთ ორიგინალ პიქსელზე.
function traceRedBoundary(rgba, W, H, nativePx) {
  const red = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < W * H; i++, j += 4) { const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    red[i] = (r > 130 && r - g > 60 && r - b > 60) ? 1 : 0; }
  let ring = null, inside = null, outside = null, k = 0, ringN = 0, inN = 0;
  // ხაზში ხარვეზები (სხვა ობიექტები ფარავს): ვხურავთ თანდათან მზარდი რადიუსით
  for (k = 1; k <= Math.max(6, Math.ceil(4 * nativePx)); k++) {
    const closed = boxMorph(boxMorph(red, W, H, k, true), W, H, k, false);
    const comp = largestComponent(closed, W, H, true);
    const out = floodOutside(comp.mask, W, H);
    let n = 0; for (let i = 0; i < W * H; i++) if (!out[i] && !comp.mask[i]) n++;
    if (n > 3 * comp.n) { ring = comp.mask; outside = out; ringN = comp.n; inN = n; break; }
  }
  if (!ring) throw new Error('რასტრულ სურათში წითელი საზღვრის დახურული კონტური ვერ ვიპოვე.');
  inside = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) inside[i] = (!outside[i] && !ring[i]) ? 1 : 0;
  // ხაზის შუა ხაზი: ხაზის პიქსელი "შიგნითაა", თუ შიდა არესთან უფრო ახლოსაა, ვიდრე გარესთან
  const dI = edt(inside, W, H), dO = edt(outside, W, H);
  const M = new Uint8Array(W * H); let widthSum = 0, widthN = 0;
  for (let i = 0; i < W * H; i++) {
    if (inside[i]) M[i] = 1; else if (ring[i]) { const df = dO[i] - dI[i]; M[i] = (df > 1e-6 || (Math.abs(df) <= 1e-6 && ((i % W) + ((i / W) | 0)) % 2 === 0)) ? 1 : 0; // თანაბარი: შახმატურად (მიკერძოების გარეშე)
      if (Math.abs(dI[i] - dO[i]) <= 1) { widthSum += dI[i] + dO[i]; widthN++; } }
  }
  const main = largestComponent(M, W, H, false).mask;
  const crack = traceOuter(main, W, H);
  // საფეხურების მოსაშორებლად: ერთეულოვანი კიდეების შუა წერტილები, შემდეგ გამარტივება
  const mid = crack.map((p, i) => { const q = crack[(i + 1) % crack.length]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; });
  const tolN = (typeof globalThis !== 'undefined' && globalThis.__rasterTol) || RASTER_TOL; // ორიგინალ პიქსელებში
  const idx = dpSimplify(mid, Math.max(1.0, tolN * nativePx), true);
  const lw0 = widthN ? widthSum / widthN : 3;
  const simp = restoreTips(mergeCollinear(refitPolygon(mid, idx, Math.max(6, 6 * lw0)), Math.max(1.0, tolN * nativePx)), lw0);
  return { ring: simp, closeRadius: k, lineWidthPx: widthN ? widthSum / widthN : NaN, ringPixels: ringN, insidePixels: inN };
}

// ვექტორული ჩარჩო: ბადის ხაზების მომცველი მართკუთხედი (PDF-ის კოორდინატებში)
function gridFrame(ex) {
  const minLen = Math.min(ex.pageW, ex.pageH) * 0.4;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sp of ex.painted) for (let i = 0; i + 1 < sp.pts.length; i++) {
    const [a, b] = sp.pts[i], [c, d] = sp.pts[i + 1];
    const vert = Math.abs(a - c) < 0.01 && Math.abs(b - d) > minLen, hor = Math.abs(b - d) < 0.01 && Math.abs(a - c) > minLen;
    if (vert || hor) { x0 = Math.min(x0, a, c); x1 = Math.max(x1, a, c); y0 = Math.min(y0, b, d); y1 = Math.max(y1, b, d); }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

// რასტრული გეომეტრია: ringPdf - რგოლი PDF-ის კოორდინატებში
function buildGeometryRaster(ex, ringPdf, nativePt) {
  const meta = parseMeta(ex.text, ex.items);
  const { fn, info } = buildTransform(ex);
  const outer = ringPdf.map(([x, y]) => fn(x, y));
  const groups = [{ outer, holes: [] }];
  const areaCalc = Math.abs(ringArea(outer));
  const warnings = ['რასტრული PDF: საზღვარი სურათიდან (პიქსელებიდან) არის ამოღებული. სიზუსტე ვექტორულზე დაბალია. ვიწრო ზოლებსა და ძალიან მახვილ წვერებში საზღვარი შეიძლება რამდენიმე მეტრით შემოიჭრას.'];
  meta.zoneCandidates = detectZone(groups, meta.hemi);
  if (meta.zoneAssumed && meta.zoneCandidates.length === 1) { meta.zone = meta.zoneCandidates[0]; meta.zoneAuto = true; }
  else if (!meta.zoneAssumed && meta.zoneCandidates.length === 1 && meta.zoneCandidates[0] !== meta.zone) { meta.zoneStated = meta.zone; meta.zone = meta.zoneCandidates[0]; meta.zoneCorrected = true; }
  const notes = [];
  const { diffPct, areaTolerancePct } = areaCheck(meta, areaCalc, warnings, notes);
  if (!Number.isFinite(diffPct)) warnings.push('PDF-ში ფართობი ტექსტად არ არის (სურათშია), ამიტომ ფართობით გადამოწმება ვერ ხერხდება.');
  return { meta, info, groups, areaCalc, diffPct, areaTolerancePct, warnings, notes, ringCount: 1, vertexCount: outer.length, raster: true, nativePt };
}

// სავარაუდო ცდომილება: ვექტორული PDF-ების ოფიციალურ shp-თან შედარებით (9 ნაკვეთი):
// ცდომილება ფურცელზე ≈ 0.1–0.35 pt (საშუალო), ≤ 0.65 pt (მაქს.) -> მეტრებში მასშტაბზე გამრავლებით
function accuracyEstimate(g) {
  const s = Math.max(Math.abs(g.info.scaleX), Math.abs(g.info.scaleY)); // მ / pt
  if (g.raster && g.nativePt) return { typical: RASTER_TYP * g.nativePt * s, max: RASTER_MAX * g.nativePt * s };
  return { typical: 0.3 * s, max: 0.7 * s };
}
const RASTER_TYP = 1.0, RASTER_MAX = 3.5; // ორიგინალ პიქსელებში; კალიბრებული 2 ნაკვეთზე (ოფიციალური shp)

// =====================================================================
// ბადის ციფრები, დახატული შრიფტის მოხაზულობებად (Chrome-ით დაბეჭდილი NAPR გეგმები).
// ამოცნობა: თითო ციფრის მოხაზულობას ვავსებთ პატარა ბადეზე და ვადარებთ შრიფტის შაბლონებს
// (DejaVu Sans / Bold, Liberation Sans). შედეგს ამოწმებს ბადის წრფივობა (robustFit) და ფართობი.
// =====================================================================
const DIGIT_TEMPLATES = {"dejavu":{"0":[[[651,1360],[601.2,1355.7],[555.6,1342.9],[514.4,1321.6],[477.4,1291.8],[444.8,1253.4],[416.5,1206.5],[392.5,1151.0],[372.9,1087.0],[357.6,1014.4],[346.7,933.2],[340.2,843.4],[338.0,745.0],[340.2,646.9],[346.7,557.4],[357.6,476.4],[372.9,403.9],[392.5,339.9],[416.5,284.5],[444.8,237.6],[477.4,199.2],[514.4,169.4],[555.6,148.1],[601.2,135.3],[651.0,131.0],[701.2,135.3],[746.9,148.1],[788.4,169.4],[825.4,199.2],[858.2,237.6],[886.5,284.5],[910.5,339.9],[930.1,403.9],[945.4,476.4],[956.3,557.4],[962.8,646.9],[965.0,745.0],[962.8,843.4],[956.3,933.2],[945.4,1014.4],[930.1,1087.0],[910.5,1151.0],[886.5,1206.5],[858.2,1253.4],[825.4,1291.8],[788.4,1321.6],[746.9,1342.9],[701.2,1355.7],[651.0,1360.0]],[[651,1520],[731.4,1514.5],[805.2,1497.9],[872.4,1470.4],[933.0,1431.8],[987.0,1382.2],[1034.5,1321.5],[1075.0,1250.3],[1108.1,1169.2],[1133.9,1078.1],[1152.3,977.1],[1163.3,866.0],[1167.0,745.0],[1163.3,624.3],[1152.3,513.5],[1133.9,412.6],[1108.1,321.7],[1075.0,240.6],[1034.5,169.5],[987.0,108.8],[933.0,59.2],[872.4,20.6],[805.2,-6.9],[731.4,-23.5],[651.0,-29.0],[570.6,-23.5],[496.8,-6.9],[429.6,20.6],[369.0,59.2],[315.0,108.8],[267.5,169.5],[227.0,240.6],[193.9,321.7],[168.1,412.6],[149.7,513.5],[138.7,624.3],[135.0,745.0],[138.7,866.0],[149.7,977.1],[168.1,1078.1],[193.9,1169.2],[227.0,1250.3],[267.5,1321.5],[315.0,1382.2],[369.0,1431.8],[429.6,1470.4],[496.8,1497.9],[570.6,1514.5],[651.0,1520.0]]],"1":[[[254,170],[584,170],[584,1309],[225,1237],[225,1421],[582,1493],[784,1493],[784,170],[1114,170],[1114,0],[254,0]]],"2":[[[393,170],[1098,170],[1098,0],[150,0],[150,170],[190.7,211.9],[235.9,258.4],[285.9,309.4],[340.4,364.9],[399.7,424.9],[463.5,489.5],[525.6,552.4],[579.4,607.3],[625.1,654.4],[662.6,693.5],[691.9,724.7],[713.0,748.0],[743.7,783.4],[771.2,816.9],[795.4,848.6],[816.3,878.4],[834.0,906.4],[848.5,932.5],[860.3,957.6],[869.9,982.6],[877.4,1007.4],[882.7,1032.1],[885.9,1056.6],[887.0,1081.0],[884.7,1119.4],[877.7,1155.4],[866.1,1189.0],[849.9,1220.1],[829.0,1248.8],[803.5,1275.0],[774.3,1297.9],[742.2,1316.7],[707.4,1331.2],[669.7,1341.7],[629.3,1347.9],[586.0,1350.0],[554.0,1349.1],[521.5,1346.3],[488.4,1341.8],[454.7,1335.3],[420.4,1327.1],[385.5,1317.0],[349.9,1305.1],[313.6,1291.2],[276.4,1275.5],[238.4,1257.9],[199.6,1238.4],[160.0,1217.0],[160,1421],[200.2,1436.7],[239.6,1451.0],[278.0,1464.0],[315.6,1475.7],[352.2,1486.0],[388.0,1495.0],[422.8,1502.6],[456.7,1508.9],[489.5,1513.8],[521.3,1517.2],[552.2,1519.3],[582.0,1520.0],[656.7,1516.8],[726.2,1507.1],[790.5,1491.0],[849.6,1468.4],[903.4,1439.4],[952.0,1404.0],[994.2,1363.2],[1028.7,1318.0],[1055.5,1268.5],[1074.7,1214.7],[1086.2,1156.5],[1090.0,1094.0],[1089.0,1063.6],[1086.2,1033.7],[1081.4,1004.4],[1074.7,975.6],[1066.0,947.3],[1055.5,919.5],[1042.4,891.2],[1026.2,861.2],[1006.9,829.6],[984.4,796.4],[958.8,761.5],[930.0,725.0],[918.6,712.3],[901.2,693.5],[877.8,668.6],[848.2,637.7],[812.6,600.6],[771.0,557.5],[723.3,508.3],[669.4,452.9],[609.5,391.4],[543.4,323.7],[471.3,249.9],[393.0,170.0]]],"3":[[[831,805],[877.6,792.8],[920.6,776.9],[960.1,757.2],[996.1,733.9],[1028.6,706.8],[1057.5,676.0],[1082.4,642.1],[1102.8,605.6],[1118.6,566.5],[1129.9,524.9],[1136.7,480.7],[1139.0,434.0],[1134.8,363.1],[1122.1,297.8],[1101.0,238.0],[1071.4,183.8],[1033.4,135.1],[987.0,92.0],[932.8,55.0],[871.4,24.8],[803.0,1.2],[727.4,-15.6],[644.8,-25.6],[555.0,-29.0],[523.5,-28.5],[491.7,-26.9],[459.6,-24.4],[427.2,-20.8],[394.5,-16.2],[361.5,-10.5],[328.2,-3.8],[294.4,3.9],[260.4,12.6],[225.9,22.4],[191.2,33.2],[156.0,45.0],[156,240],[184.4,224.3],[213.8,210.0],[244.0,197.0],[275.1,185.3],[307.1,175.0],[340.0,166.0],[373.6,158.4],[407.7,152.1],[442.2,147.2],[477.3,143.8],[512.9,141.7],[549.0,141.0],[609.8,143.1],[665.6,149.3],[716.4,159.8],[762.1,174.3],[802.8,193.1],[838.5,216.0],[868.9,242.9],[893.8,273.6],[913.1,308.0],[926.9,346.2],[935.2,388.2],[938.0,434.0],[935.4,476.4],[927.7,515.6],[914.9,551.6],[896.9,584.4],[873.8,614.1],[845.5,640.5],[812.7,663.3],[775.8,681.9],[734.9,696.4],[689.9,706.7],[641.0,712.9],[588.0,715.0],[414,715],[414,881],[596,881],[643.7,882.7],[687.6,887.6],[727.5,895.9],[763.6,907.4],[795.7,922.3],[824.0,940.5],[848.1,961.8],[867.9,986.0],[883.2,1013.1],[894.2,1043.2],[900.8,1076.1],[903.0,1112.0],[900.7,1148.8],[893.9,1182.7],[882.6,1213.6],[866.8,1241.6],[846.4,1266.5],[821.5,1288.5],[792.4,1307.3],[759.3,1322.7],[722.4,1334.6],[681.5,1343.2],[636.7,1348.3],[588.0,1350.0],[560.0,1349.5],[531.3,1348.0],[502.0,1345.5],[472.0,1342.0],[441.3,1337.5],[410.0,1332.0],[377.8,1325.4],[344.6,1317.8],[310.2,1309.0],[274.9,1299.1],[238.5,1288.1],[201.0,1276.0],[201,1456],[238.9,1466.2],[276.1,1475.6],[312.4,1484.0],[347.9,1491.6],[382.6,1498.2],[416.5,1504.0],[449.7,1508.9],[482.2,1512.9],[514.1,1516.0],[545.4,1518.2],[576.0,1519.6],[606.0,1520.0],[680.0,1517.1],[748.7,1508.4],[812.0,1493.9],[870.0,1473.6],[922.7,1447.4],[970.0,1415.5],[1010.9,1378.6],[1044.4,1337.7],[1070.5,1292.6],[1089.1,1243.5],[1100.3,1190.3],[1104.0,1133.0],[1102.0,1092.7],[1096.1,1054.6],[1086.2,1018.6],[1072.4,984.8],[1054.7,953.1],[1033.0,923.5],[1007.7,896.5],[979.0,872.3],[947.0,851.1],[911.7,832.8],[873.0,817.5],[831.0,805.0]]],"4":[[[774,1317],[264,520],[774,520]],[[721,1493],[975,1493],[975,520],[1188,520],[1188,352],[975,352],[975,0],[774,0],[774,352],[100,352],[100,547]]],"5":[[[221,1493],[1014,1493],[1014,1323],[406,1323],[406,957],[420.7,961.8],[435.3,966.2],[450.0,970.1],[464.7,973.7],[479.3,976.8],[494.0,979.5],[508.7,981.8],[523.3,983.7],[538.0,985.1],[552.7,986.2],[567.3,986.8],[582.0,987.0],[662.4,983.2],[737.1,971.8],[806.0,952.8],[869.1,926.1],[926.4,891.9],[978.0,850.0],[1022.6,801.6],[1059.1,747.9],[1087.5,688.8],[1107.8,624.2],[1119.9,554.3],[1124.0,479.0],[1119.8,401.7],[1107.3,330.3],[1086.5,264.9],[1057.3,205.4],[1019.8,152.0],[974.0,104.5],[920.6,63.7],[860.3,30.3],[793.2,4.4],[719.3,-14.2],[638.6,-25.3],[551.0,-29.0],[519.6,-28.6],[487.9,-27.2],[456.1,-25.0],[424.1,-21.9],[391.9,-17.9],[359.5,-13.0],[326.8,-7.2],[293.8,-0.6],[260.4,7.0],[226.6,15.4],[192.5,24.8],[158.0,35.0],[158,238],[188.2,222.4],[218.7,208.1],[249.5,195.2],[280.7,183.8],[312.2,173.7],[344.0,165.0],[376.3,157.7],[409.2,151.7],[442.8,147.0],[476.9,143.7],[511.6,141.7],[547.0,141.0],[602.7,143.5],[654.3,151.1],[702.0,163.8],[745.7,181.4],[785.3,204.2],[821.0,232.0],[851.9,264.1],[877.1,299.9],[896.8,339.2],[910.8,382.2],[919.2,428.8],[922.0,479.0],[919.2,529.2],[910.8,575.8],[896.8,618.8],[877.1,658.1],[851.9,693.9],[821.0,726.0],[785.3,753.8],[745.7,776.6],[702.0,794.2],[654.3,806.9],[602.7,814.5],[547.0,817.0],[520.0,816.5],[493.1,815.0],[466.1,812.5],[439.2,809.0],[412.3,804.5],[385.5,799.0],[358.6,792.4],[331.4,784.8],[304.1,776.0],[276.6,766.1],[248.9,755.1],[221.0,743.0]]],"6":[[[676,827],[632.2,824.4],[591.6,816.7],[554.1,803.8],[519.8,785.7],[488.6,762.4],[460.5,734.0],[436.2,701.1],[416.3,664.3],[400.9,623.8],[389.8,579.3],[383.2,531.1],[381.0,479.0],[383.2,427.2],[389.8,379.2],[400.9,334.9],[416.3,294.3],[436.2,257.5],[460.5,224.5],[488.6,195.9],[519.8,172.6],[554.1,154.4],[591.6,141.4],[632.2,133.6],[676.0,131.0],[719.8,133.6],[760.4,141.4],[797.9,154.4],[832.2,172.6],[863.4,195.9],[891.5,224.5],[915.8,257.5],[935.7,294.3],[951.1,334.9],[962.2,379.2],[968.8,427.2],[971.0,479.0],[968.8,531.1],[962.2,579.3],[951.1,623.8],[935.7,664.3],[915.8,701.1],[891.5,734.0],[863.4,762.4],[832.2,785.7],[797.9,803.8],[760.4,816.7],[719.8,824.4],[676.0,827.0]],[[1077,1460],[1077,1276],[1051.6,1287.5],[1026.2,1298.1],[1000.6,1307.8],[975.0,1316.4],[949.3,1324.2],[923.5,1331.0],[897.7,1336.8],[872.0,1341.6],[846.4,1345.2],[820.8,1347.9],[795.4,1349.5],[770.0,1350.0],[706.0,1346.2],[647.2,1335.0],[593.6,1316.2],[545.3,1290.0],[502.3,1256.2],[464.5,1215.0],[431.8,1166.2],[404.2,1109.7],[381.6,1045.5],[364.1,973.7],[351.5,894.2],[344.0,807.0],[364.5,834.9],[386.7,860.5],[410.5,883.9],[436.0,905.0],[463.2,923.9],[492.0,940.5],[522.2,954.7],[553.3,966.3],[585.5,975.4],[618.7,981.8],[652.8,985.7],[688.0,987.0],[760.4,983.2],[827.5,971.8],[889.4,952.9],[946.0,926.3],[997.4,892.2],[1043.5,850.5],[1083.4,802.3],[1116.0,748.6],[1141.4,689.4],[1159.5,624.7],[1170.4,554.6],[1174.0,479.0],[1170.2,404.9],[1158.9,335.8],[1140.0,271.8],[1113.6,212.8],[1079.6,158.9],[1038.0,110.0],[990.2,67.5],[937.3,32.8],[879.5,5.8],[816.7,-13.6],[748.8,-25.1],[676.0,-29.0],[593.1,-23.5],[516.9,-6.9],[447.5,20.6],[384.9,59.2],[329.1,108.8],[280.0,169.5],[238.1,240.6],[203.9,321.7],[177.2,412.6],[158.2,513.5],[146.8,624.3],[143.0,745.0],[147.7,859.0],[161.7,965.1],[185.0,1063.1],[217.7,1153.2],[259.7,1235.3],[311.0,1309.5],[370.2,1373.8],[435.8,1426.4],[507.8,1467.4],[586.1,1496.6],[670.9,1514.2],[762.0,1520.0],[787.4,1519.6],[812.8,1518.3],[838.4,1516.2],[864.0,1513.3],[889.7,1509.6],[915.5,1505.0],[941.5,1499.6],[967.9,1493.3],[994.6,1486.2],[1021.7,1478.3],[1049.2,1469.6],[1077.0,1460.0]]],"7":[[[168,1493],[1128,1493],[1128,1407],[586,0],[375,0],[885,1323],[168,1323]]],"8":[[[651,709],[604.7,706.9],[561.8,700.4],[522.4,689.8],[486.3,674.8],[453.7,655.5],[424.5,632.0],[399.3,604.7],[378.7,574.2],[362.6,540.5],[351.2,503.6],[344.3,463.4],[342.0,420.0],[344.3,376.6],[351.2,336.4],[362.6,299.5],[378.7,265.8],[399.3,235.3],[424.5,208.0],[453.7,184.5],[486.3,165.2],[522.4,150.2],[561.8,139.6],[604.7,133.1],[651.0,131.0],[697.3,133.2],[740.2,139.6],[779.8,150.4],[815.9,165.4],[848.6,184.8],[878.0,208.5],[903.4,235.9],[924.1,266.4],[940.2,300.1],[951.8,336.9],[958.7,376.9],[961.0,420.0],[958.7,463.4],[951.8,503.6],[940.4,540.5],[924.3,574.2],[903.7,604.7],[878.5,632.0],[849.3,655.5],[816.6,674.8],[780.4,689.8],[740.7,700.4],[697.6,706.9],[651.0,709.0]],[[449,795],[407.3,807.3],[368.7,822.7],[333.4,841.2],[301.2,863.0],[272.3,887.9],[246.5,916.0],[224.3,946.8],[206.2,979.7],[192.1,1014.8],[182.1,1052.0],[176.0,1091.4],[174.0,1133.0],[177.5,1190.6],[188.2,1244.0],[205.9,1293.2],[230.7,1338.3],[262.5,1379.2],[301.5,1416.0],[346.6,1447.8],[397.0,1473.8],[452.6,1494.0],[513.5,1508.4],[579.6,1517.1],[651.0,1520.0],[722.7,1517.1],[789.0,1508.4],[850.0,1494.0],[905.7,1473.8],[956.0,1447.8],[1001.0,1416.0],[1039.8,1379.2],[1071.6,1338.3],[1096.2,1293.2],[1113.9,1244.0],[1124.5,1190.6],[1128.0,1133.0],[1126.0,1091.4],[1119.9,1052.0],[1109.9,1014.8],[1095.8,979.7],[1077.7,946.8],[1055.5,916.0],[1029.8,887.9],[1000.9,863.0],[968.9,841.2],[933.7,822.7],[895.4,807.2],[854.0,795.0],[900.9,781.9],[944.2,765.1],[983.9,744.8],[1020.0,720.8],[1052.5,693.2],[1081.5,662.0],[1106.4,627.8],[1126.8,591.1],[1142.6,552.0],[1153.9,510.4],[1160.7,466.4],[1163.0,420.0],[1159.3,350.5],[1148.3,286.6],[1129.9,228.2],[1104.1,175.6],[1071.0,128.5],[1030.5,87.0],[983.2,51.6],[929.4,22.6],[869.4,0.0],[802.9,-16.1],[730.2,-25.8],[651.0,-29.0],[571.8,-25.8],[499.1,-16.1],[432.6,0.0],[372.6,22.6],[318.8,51.6],[271.5,87.0],[231.0,128.5],[197.9,175.6],[172.1,228.2],[153.7,286.6],[142.7,350.5],[139.0,420.0],[141.3,466.4],[148.1,510.4],[159.5,552.0],[175.4,591.1],[195.9,627.8],[221.0,662.0],[250.1,693.2],[282.8,720.8],[319.0,744.8],[358.8,765.1],[402.1,781.9],[449.0,795.0]],[[375,1114],[377.0,1076.8],[383.1,1042.3],[393.1,1010.8],[407.2,982.0],[425.3,956.1],[447.5,933.0],[473.3,913.1],[502.3,896.9],[534.6,884.2],[570.2,875.2],[609.0,869.8],[651.0,868.0],[692.8,869.8],[731.4,875.2],[766.9,884.2],[799.2,896.9],[828.4,913.1],[854.5,933.0],[877.0,956.1],[895.3,982.0],[909.6,1010.8],[919.8,1042.3],[926.0,1076.8],[928.0,1114.0],[926.0,1151.2],[919.8,1185.7],[909.6,1217.2],[895.3,1246.0],[877.0,1271.9],[854.5,1295.0],[828.4,1314.9],[799.2,1331.1],[766.9,1343.8],[731.4,1352.8],[692.8,1358.2],[651.0,1360.0],[609.0,1358.2],[570.2,1352.8],[534.6,1343.8],[502.3,1331.1],[473.3,1314.9],[447.5,1295.0],[425.3,1271.9],[407.2,1246.0],[393.1,1217.2],[383.1,1185.7],[377.0,1151.2],[375.0,1114.0]]],"9":[[[225,31],[225,215],[250.4,203.5],[275.9,192.9],[301.5,183.2],[327.2,174.6],[353.1,166.8],[379.0,160.0],[404.9,154.2],[430.7,149.4],[456.2,145.8],[481.7,143.1],[506.9,141.5],[532.0,141.0],[596.0,144.7],[654.8,155.9],[708.4,174.6],[756.7,200.8],[799.7,234.4],[837.5,275.5],[870.2,324.2],[897.8,380.7],[920.4,444.9],[937.9,516.8],[950.5,596.5],[958.0,684.0],[937.8,656.4],[915.9,631.1],[892.2,608.0],[866.9,587.1],[839.8,568.4],[811.0,552.0],[780.8,537.9],[749.6,526.4],[717.2,517.5],[683.9,511.1],[649.5,507.3],[614.0,506.0],[541.9,509.8],[475.1,521.1],[413.4,539.9],[356.9,566.2],[305.6,600.1],[259.5,641.5],[219.6,689.4],[187.0,742.9],[161.6,801.9],[143.5,866.4],[132.6,936.4],[129.0,1012.0],[132.8,1086.1],[144.1,1155.2],[163.0,1219.2],[189.4,1278.2],[223.4,1332.1],[265.0,1381.0],[312.8,1423.5],[365.7,1458.2],[423.5,1485.2],[486.3,1504.6],[554.2,1516.1],[627.0,1520.0],[709.9,1514.5],[786.1,1497.9],[855.4,1470.4],[917.9,1431.8],[973.6,1382.2],[1022.5,1321.5],[1064.2,1250.3],[1098.3,1169.2],[1124.9,1078.1],[1143.8,977.1],[1155.2,866.0],[1159.0,745.0],[1154.3,631.3],[1140.4,525.5],[1117.1,427.6],[1084.6,337.7],[1042.7,255.6],[991.5,181.5],[932.5,117.2],[867.0,64.6],[795.1,23.6],[716.8,-5.6],[632.1,-23.2],[541.0,-29.0],[515.6,-28.6],[490.1,-27.3],[464.5,-25.2],[438.8,-22.3],[412.9,-18.6],[387.0,-14.0],[360.8,-8.6],[334.3,-2.3],[307.5,4.8],[280.3,12.7],[252.8,21.4],[225.0,31.0]],[[627,664],[670.8,666.6],[711.4,674.3],[748.9,687.2],[783.2,705.3],[814.4,728.6],[842.5,757.0],[866.8,789.9],[886.7,826.7],[902.1,867.2],[913.2,911.7],[919.8,959.9],[922.0,1012.0],[919.8,1063.8],[913.2,1111.8],[902.1,1156.1],[886.7,1196.7],[866.8,1233.5],[842.5,1266.5],[814.4,1295.1],[783.2,1318.4],[748.9,1336.6],[711.4,1349.6],[670.8,1357.4],[627.0,1360.0],[583.2,1357.4],[542.6,1349.6],[505.1,1336.6],[470.8,1318.4],[439.6,1295.1],[411.5,1266.5],[387.2,1233.5],[367.3,1196.7],[351.9,1156.1],[340.8,1111.8],[334.2,1063.8],[332.0,1012.0],[334.2,959.9],[340.8,911.7],[351.9,867.2],[367.3,826.7],[387.2,789.9],[411.5,757.0],[439.6,728.6],[470.8,705.3],[505.1,687.2],[542.6,674.3],[583.2,666.6],[627.0,664.0]]]},"dejavub":{"0":[[[942,748],[940.5,836.7],[936.2,916.3],[928.9,986.6],[918.7,1047.8],[905.5,1099.7],[889.5,1142.5],[870.0,1177.5],[846.6,1206.1],[819.1,1228.4],[787.7,1244.3],[752.3,1253.8],[713.0,1257.0],[673.6,1253.8],[638.2,1244.3],[606.8,1228.4],[579.2,1206.1],[555.6,1177.5],[536.0,1142.5],[519.8,1099.7],[506.6,1047.8],[496.2,986.6],[488.9,916.3],[484.5,836.7],[483.0,748.0],[484.5,658.3],[488.9,577.9],[496.2,506.8],[506.6,444.9],[519.8,392.3],[536.0,349.0],[555.6,313.6],[579.2,284.6],[606.8,262.0],[638.2,245.9],[673.6,236.2],[713.0,233.0],[752.1,236.2],[787.2,245.9],[818.5,262.0],[845.9,284.6],[869.4,313.6],[889.0,349.0],[905.2,392.3],[918.4,444.9],[928.8,506.8],[936.1,577.9],[940.5,658.3],[942.0,748.0]],[[1327,745],[1322.6,626.0],[1309.2,516.5],[1287.0,416.4],[1255.9,325.7],[1215.9,244.4],[1167.0,172.5],[1109.9,110.9],[1045.4,60.6],[973.5,21.4],[894.1,-6.6],[807.3,-23.4],[713.0,-29.0],[618.4,-23.4],[531.3,-6.6],[451.8,21.4],[379.7,60.6],[315.1,110.9],[258.0,172.5],[209.1,244.4],[169.1,325.7],[138.0,416.4],[115.8,516.5],[102.4,626.0],[98.0,745.0],[102.4,864.3],[115.8,974.1],[138.0,1074.4],[169.1,1165.2],[209.1,1246.6],[258.0,1318.5],[315.1,1380.1],[379.7,1430.4],[451.8,1469.6],[531.3,1497.6],[618.4,1514.4],[713.0,1520.0],[807.3,1514.4],[894.1,1497.6],[973.5,1469.6],[1045.4,1430.4],[1109.9,1380.1],[1167.0,1318.5],[1215.9,1246.6],[1255.9,1165.2],[1287.0,1074.4],[1309.2,974.1],[1322.6,864.3],[1327.0,745.0]]],"1":[[[240,266],[580,266],[580,1231],[231,1159],[231,1421],[578,1493],[944,1493],[944,266],[1284,266],[1284,0],[240,0]]],"2":[[[590,283],[1247,283],[1247,0],[162,0],[162,283],[707,764],[730.3,785.9],[751.4,807.7],[770.5,829.2],[787.4,850.7],[802.3,871.9],[815.0,893.0],[825.7,914.1],[834.4,935.6],[841.2,957.2],[846.1,979.2],[849.0,1001.5],[850.0,1024.0],[848.0,1057.9],[842.2,1089.4],[832.4,1118.8],[818.7,1145.8],[801.0,1170.5],[779.5,1193.0],[754.7,1212.6],[727.3,1228.6],[697.4,1241.0],[664.8,1249.9],[629.7,1255.2],[592.0,1257.0],[561.5,1255.9],[530.1,1252.7],[497.8,1247.4],[464.4,1239.9],[430.2,1230.3],[395.0,1218.5],[358.9,1204.6],[322.0,1188.7],[284.2,1170.6],[245.7,1150.5],[206.2,1128.3],[166.0,1104.0],[166,1432],[209.2,1445.8],[252.3,1458.4],[295.2,1469.9],[338.0,1480.2],[380.6,1489.4],[423.0,1497.5],[465.2,1504.4],[507.1,1510.0],[548.8,1514.4],[590.1,1517.5],[631.2,1519.4],[672.0,1520.0],[758.0,1516.7],[837.4,1506.9],[910.1,1490.5],[976.2,1467.6],[1035.7,1438.1],[1088.5,1402.0],[1133.9,1360.1],[1171.0,1313.0],[1199.9,1260.8],[1220.5,1203.3],[1232.9,1140.8],[1237.0,1073.0],[1235.2,1032.8],[1230.0,993.5],[1221.2,955.1],[1209.0,917.7],[1193.2,881.1],[1174.0,845.5],[1149.1,808.3],[1116.6,767.2],[1076.2,722.1],[1028.2,673.1],[972.5,620.0],[909.0,563.0]]],"3":[[[954,805],[1002.3,790.4],[1046.6,772.6],[1086.9,751.6],[1123.1,727.4],[1155.3,700.1],[1183.5,669.5],[1207.5,635.9],[1227.1,599.3],[1242.4,559.9],[1253.3,517.5],[1259.8,472.2],[1262.0,424.0],[1257.3,353.0],[1243.1,287.8],[1219.5,228.6],[1186.4,175.3],[1143.9,128.0],[1092.0,86.5],[1031.0,51.2],[961.3,22.3],[883.0,-0.1],[796.0,-16.2],[700.3,-25.8],[596.0,-29.0],[557.7,-28.5],[519.3,-26.9],[480.9,-24.4],[442.4,-20.8],[404.0,-16.2],[365.5,-10.5],[327.1,-3.8],[288.8,3.9],[250.6,12.6],[212.6,22.4],[174.7,33.2],[137.0,45.0],[137,342],[173.0,324.7],[208.8,308.9],[244.6,294.6],[280.3,281.8],[316.0,270.4],[351.5,260.5],[386.9,252.1],[422.1,245.2],[457.1,239.9],[491.9,236.1],[526.6,233.8],[561.0,233.0],[610.0,234.5],[655.1,238.9],[696.1,246.2],[733.2,256.6],[766.3,269.8],[795.5,286.0],[820.4,304.9],[840.8,326.4],[856.6,350.5],[867.9,377.1],[874.7,406.3],[877.0,438.0],[874.7,470.6],[867.7,500.5],[856.1,527.6],[839.9,552.0],[819.0,573.6],[793.5,592.5],[763.5,608.5],[729.0,621.7],[690.1,631.9],[646.8,639.2],[599.1,643.5],[547.0,645.0],[393,645],[393,893],[555,893],[601.3,894.3],[643.4,898.1],[681.5,904.4],[715.4,913.2],[745.3,924.6],[771.0,938.5],[792.7,955.0],[810.4,974.1],[824.2,995.9],[834.1,1020.3],[840.0,1047.3],[842.0,1077.0],[840.1,1104.6],[834.3,1130.0],[824.8,1153.2],[811.3,1174.3],[794.1,1193.2],[773.0,1210.0],[748.4,1224.4],[720.7,1236.1],[689.8,1245.2],[655.7,1251.8],[618.4,1255.7],[578.0,1257.0],[546.9,1256.4],[515.8,1254.7],[484.5,1251.8],[453.1,1247.7],[421.6,1242.4],[390.0,1236.0],[358.4,1228.4],[326.8,1219.8],[295.2,1210.0],[263.8,1199.1],[232.4,1187.1],[201.0,1174.0],[201,1456],[238.9,1466.2],[276.8,1475.6],[314.5,1484.0],[352.1,1491.6],[389.6,1498.2],[427.0,1504.0],[464.2,1508.9],[501.2,1512.9],[538.0,1516.0],[574.6,1518.2],[610.9,1519.6],[647.0,1520.0],[739.9,1517.3],[824.7,1509.4],[901.4,1496.1],[969.9,1477.6],[1030.3,1453.7],[1082.5,1424.5],[1126.7,1390.0],[1162.8,1350.1],[1190.9,1304.9],[1210.9,1254.3],[1223.0,1198.3],[1227.0,1137.0],[1225.1,1094.7],[1219.3,1054.9],[1209.8,1017.9],[1196.3,983.4],[1179.1,951.7],[1158.0,922.5],[1133.2,896.0],[1104.7,872.3],[1072.5,851.4],[1036.7,833.2],[997.2,817.7],[954.0,805.0]]],"4":[[[754,1176],[332,551],[754,551]],[[690,1493],[1118,1493],[1118,551],[1331,551],[1331,272],[1118,272],[1118,0],[754,0],[754,272],[92,272],[92,602]]],"5":[[[217,1493],[1174,1493],[1174,1210],[524,1210],[524,979],[538.7,982.8],[553.4,986.4],[568.1,989.6],[582.9,992.6],[597.7,995.2],[612.5,997.5],[627.4,999.5],[642.6,1001.1],[657.9,1002.4],[673.4,1003.3],[689.1,1003.8],[705.0,1004.0],[792.6,1000.2],[873.6,988.8],[947.8,969.9],[1015.2,943.3],[1076.0,909.2],[1130.0,867.5],[1176.4,819.0],[1214.4,764.6],[1244.0,704.1],[1265.1,637.7],[1277.8,565.3],[1282.0,487.0],[1277.4,409.3],[1263.6,337.3],[1240.6,271.2],[1208.4,211.0],[1167.1,156.6],[1116.5,108.0],[1057.8,66.1],[991.9,31.9],[918.9,5.2],[838.7,-13.8],[751.4,-25.2],[657.0,-29.0],[614.7,-28.3],[572.6,-26.3],[530.6,-22.9],[488.8,-18.1],[447.1,-12.0],[405.5,-4.5],[364.0,4.4],[322.7,14.7],[281.4,26.4],[240.2,39.5],[199.0,54.0],[158.0,70.0],[158,373],[198.3,350.6],[237.9,330.2],[276.9,311.8],[315.1,295.2],[352.7,280.6],[389.5,268.0],[425.7,257.3],[461.1,248.6],[495.9,241.8],[529.9,236.9],[563.3,234.0],[596.0,233.0],[641.0,234.9],[682.7,240.6],[721.1,250.1],[756.2,263.4],[788.0,280.6],[816.5,301.5],[841.1,325.7],[861.2,352.6],[876.9,382.1],[888.1,414.4],[894.8,449.3],[897.0,487.0],[894.8,524.9],[888.1,560.1],[876.9,592.5],[861.2,622.1],[841.1,648.9],[816.5,673.0],[788.0,693.8],[756.2,710.8],[721.1,724.0],[682.7,733.4],[641.0,739.1],[596.0,741.0],[568.0,740.4],[539.4,738.6],[510.2,735.6],[480.4,731.4],[450.0,726.1],[419.0,719.5],[387.3,711.7],[354.8,702.6],[321.5,692.1],[287.4,680.4],[252.6,667.3],[217.0,653.0]]],"6":[[[741,737],[708.7,735.2],[679.3,729.7],[652.6,720.6],[628.8,707.9],[607.7,691.5],[589.5,671.5],[574.1,647.8],[561.4,620.6],[551.6,589.6],[544.6,555.1],[540.4,516.8],[539.0,475.0],[540.4,433.2],[544.6,394.9],[551.6,360.4],[561.4,329.4],[574.1,302.2],[589.5,278.5],[607.7,258.5],[628.8,242.1],[652.6,229.4],[679.3,220.3],[708.7,214.8],[741.0,213.0],[773.6,214.8],[803.3,220.3],[830.1,229.4],[854.1,242.1],[875.2,258.5],[893.5,278.5],[908.9,302.2],[921.6,329.4],[931.4,360.4],[938.4,394.9],[942.6,433.2],[944.0,475.0],[942.6,516.8],[938.4,555.1],[931.4,589.6],[921.6,620.6],[908.9,647.8],[893.5,671.5],[875.2,691.5],[854.1,707.9],[830.1,720.6],[803.3,729.7],[773.6,735.2],[741.0,737.0]],[[1217,1454],[1217,1178],[1185.6,1192.3],[1154.9,1205.4],[1124.8,1217.1],[1095.2,1227.6],[1066.3,1236.7],[1038.0,1244.5],[1010.1,1251.1],[982.4,1256.4],[955.0,1260.6],[927.8,1263.6],[900.8,1265.4],[874.0,1266.0],[818.8,1263.3],[767.8,1255.4],[721.0,1242.1],[678.4,1223.6],[640.1,1199.7],[606.0,1170.5],[576.2,1136.1],[550.9,1096.6],[530.0,1051.9],[513.6,1002.1],[501.6,947.1],[494.0,887.0],[516.3,902.7],[539.2,916.9],[562.8,929.9],[586.9,941.4],[611.6,951.7],[637.0,960.5],[663.1,968.0],[689.9,974.1],[717.5,978.9],[745.9,982.3],[775.1,984.3],[805.0,985.0],[878.9,981.3],[947.8,970.1],[1011.9,951.5],[1071.0,925.4],[1125.2,891.9],[1174.5,851.0],[1217.4,804.0],[1252.6,752.4],[1279.9,696.2],[1299.4,635.4],[1311.1,570.0],[1315.0,500.0],[1310.6,422.7],[1297.6,350.6],[1275.8,283.9],[1245.2,222.4],[1206.0,166.3],[1158.0,115.5],[1102.7,71.3],[1041.4,35.2],[974.2,7.1],[901.1,-12.9],[822.0,-25.0],[737.0,-29.0],[643.7,-23.5],[557.6,-7.2],[478.9,20.1],[407.4,58.3],[343.3,107.5],[286.5,167.5],[237.8,237.6],[197.9,316.8],[166.9,405.1],[144.7,502.6],[131.4,609.2],[127.0,725.0],[132.2,843.9],[147.7,954.1],[173.6,1055.4],[209.9,1147.9],[256.5,1231.6],[313.5,1306.5],[379.5,1371.1],[453.2,1424.0],[534.6,1465.1],[623.7,1494.5],[720.5,1512.1],[825.0,1518.0],[859.2,1517.6],[893.0,1516.2],[926.5,1514.0],[959.7,1510.9],[992.5,1506.9],[1025.0,1502.0],[1057.3,1496.2],[1089.4,1489.6],[1121.5,1482.0],[1153.4,1473.6],[1185.3,1464.2],[1217.0,1454.0]]],"7":[[[137,1493],[1262,1493],[1262,1276],[680,0],[305,0],[856,1210],[137,1210]]],"8":[[[713,668],[678.4,666.4],[646.6,661.4],[617.5,653.2],[591.2,641.8],[567.7,627.0],[547.0,609.0],[529.3,587.9],[514.8,564.0],[503.5,537.2],[495.4,507.7],[490.6,475.2],[489.0,440.0],[490.6,404.8],[495.4,372.4],[503.5,342.9],[514.8,316.2],[529.3,292.4],[547.0,271.5],[567.7,253.6],[591.2,239.0],[617.5,227.6],[646.6,219.5],[678.4,214.6],[713.0,213.0],[747.3,214.6],[778.8,219.5],[807.5,227.6],[833.4,239.0],[856.6,253.6],[877.0,271.5],[894.4,292.4],[908.7,316.2],[919.8,342.9],[927.7,372.4],[932.4,404.8],[934.0,440.0],[932.4,475.5],[927.7,508.2],[919.8,537.9],[908.7,564.7],[894.4,588.5],[877.0,609.5],[856.6,627.4],[833.4,642.0],[807.5,653.4],[778.8,661.5],[747.3,666.4],[713.0,668.0]],[[432,795],[388.5,809.9],[348.8,827.2],[312.8,847.0],[280.4,869.2],[251.9,893.9],[227.0,921.0],[205.9,950.5],[188.7,982.3],[175.2,1016.5],[165.7,1053.0],[159.9,1091.8],[158.0,1133.0],[161.9,1193.5],[173.7,1249.0],[193.2,1299.5],[220.7,1345.0],[255.9,1385.5],[299.0,1421.0],[349.7,1451.2],[407.7,1476.0],[473.0,1495.2],[545.7,1509.0],[625.7,1517.2],[713.0,1520.0],[799.7,1517.3],[879.2,1509.1],[951.5,1495.4],[1016.6,1476.2],[1074.4,1451.6],[1125.0,1421.5],[1168.1,1386.1],[1203.3,1345.7],[1230.8,1300.1],[1250.3,1249.5],[1262.1,1193.8],[1266.0,1133.0],[1264.1,1091.8],[1258.3,1053.0],[1248.6,1016.5],[1235.1,982.3],[1217.7,950.5],[1196.5,921.0],[1171.5,893.9],[1142.8,869.2],[1110.4,847.0],[1074.3,827.2],[1034.5,809.9],[991.0,795.0],[1039.6,779.5],[1084.1,761.2],[1124.4,739.9],[1160.6,715.7],[1192.6,688.5],[1220.5,658.5],[1244.2,625.6],[1263.6,590.0],[1278.6,551.6],[1289.4,510.5],[1295.8,466.6],[1298.0,420.0],[1293.9,349.0],[1281.6,284.1],[1261.1,225.1],[1232.4,172.2],[1195.6,125.3],[1150.5,84.5],[1097.4,49.8],[1036.3,21.4],[967.4,-0.6],[890.5,-16.4],[805.7,-25.8],[713.0,-29.0],[620.0,-25.8],[534.8,-16.4],[457.6,-0.6],[388.3,21.4],[327.0,49.8],[273.5,84.5],[228.1,125.3],[191.0,172.2],[162.1,225.1],[141.5,284.1],[129.1,349.0],[125.0,420.0],[127.2,466.6],[133.6,510.5],[144.4,551.6],[159.4,590.0],[178.8,625.6],[202.5,658.5],[230.4,688.5],[262.4,715.7],[298.6,739.9],[338.9,761.2],[383.4,779.5],[432.0,795.0]],[[522,1094],[523.4,1065.5],[527.5,1039.2],[534.4,1015.2],[544.0,993.6],[556.4,974.1],[571.5,957.0],[589.2,942.3],[609.2,930.3],[631.6,921.0],[656.4,914.3],[683.5,910.3],[713.0,909.0],[741.9,910.3],[768.4,914.3],[792.8,921.0],[814.8,930.3],[834.5,942.3],[852.0,957.0],[867.0,974.1],[879.2,993.6],[888.8,1015.2],[895.6,1039.2],[899.6,1065.5],[901.0,1094.0],[899.6,1122.5],[895.6,1148.7],[888.8,1172.6],[879.2,1194.2],[867.0,1213.5],[852.0,1230.5],[834.5,1245.0],[814.8,1256.9],[792.8,1266.1],[768.4,1272.7],[741.9,1276.7],[713.0,1278.0],[683.5,1276.7],[656.4,1272.7],[631.6,1266.0],[609.2,1256.7],[589.2,1244.7],[571.5,1230.0],[556.4,1212.9],[544.0,1193.6],[534.4,1172.0],[527.5,1148.2],[523.4,1122.2],[522.0,1094.0]]],"9":[[[205,33],[205,309],[235.4,295.3],[265.4,282.7],[295.0,271.4],[324.1,261.2],[352.8,252.3],[381.0,244.5],[408.9,237.9],[436.8,232.6],[464.5,228.4],[492.1,225.4],[519.6,223.6],[547.0,223.0],[602.2,225.7],[653.2,233.6],[700.0,246.9],[742.6,265.4],[780.9,289.3],[815.0,318.5],[844.8,352.9],[870.2,392.4],[891.2,437.1],[907.9,486.9],[920.1,541.9],[928.0,602.0],[905.1,586.0],[881.7,571.4],[857.8,558.2],[833.3,546.4],[808.4,536.0],[783.0,527.0],[757.0,519.4],[730.2,513.1],[702.8,508.2],[674.6,504.8],[645.6,502.7],[616.0,502.0],[542.1,505.7],[473.2,516.8],[409.1,535.4],[350.0,561.3],[295.8,594.7],[246.5,635.5],[203.6,682.3],[168.4,733.9],[141.1,790.1],[121.6,851.1],[109.9,916.7],[106.0,987.0],[110.3,1064.7],[123.4,1137.0],[145.1,1204.0],[175.6,1265.7],[214.7,1322.0],[262.5,1373.0],[317.6,1417.3],[378.7,1453.6],[445.6,1481.8],[518.5,1501.9],[597.3,1514.0],[682.0,1518.0],[775.7,1512.5],[862.0,1496.1],[941.0,1468.8],[1012.7,1430.4],[1077.0,1381.2],[1134.0,1321.0],[1182.9,1250.8],[1222.9,1171.6],[1254.0,1083.2],[1276.2,985.9],[1289.6,879.5],[1294.0,764.0],[1288.8,645.1],[1273.2,534.9],[1247.2,433.6],[1210.9,341.1],[1164.1,257.4],[1107.0,182.5],[1040.8,117.9],[966.9,65.0],[885.2,23.9],[795.9,-5.5],[698.8,-23.1],[594.0,-29.0],[559.2,-28.6],[525.0,-27.3],[491.2,-25.1],[458.0,-22.1],[425.2,-18.2],[393.0,-13.5],[361.1,-7.9],[329.4,-1.4],[298.0,5.9],[266.8,14.1],[235.8,23.1],[205.0,33.0]],[[680,752],[712.3,753.8],[741.8,759.3],[768.5,768.4],[792.4,781.1],[813.6,797.5],[832.0,817.5],[847.6,841.2],[860.3,868.4],[870.2,899.4],[877.3,933.9],[881.6,972.2],[883.0,1014.0],[881.6,1055.6],[877.3,1093.6],[870.2,1128.0],[860.3,1158.9],[847.6,1186.2],[832.0,1210.0],[813.6,1230.2],[792.4,1246.7],[768.5,1259.5],[741.8,1268.7],[712.3,1274.2],[680.0,1276.0],[647.7,1274.2],[618.2,1268.7],[591.5,1259.5],[567.6,1246.7],[546.4,1230.2],[528.0,1210.0],[512.4,1186.2],[499.7,1158.9],[489.8,1128.0],[482.7,1093.6],[478.4,1055.6],[477.0,1014.0],[478.4,972.2],[482.7,933.9],[489.8,899.4],[499.7,868.4],[512.4,841.2],[528.0,817.5],[546.4,797.5],[567.6,781.1],[591.5,768.4],[618.2,759.3],[647.7,753.8],[680.0,752.0]]]},"liberation":{"0":[[[1059,705],[1055.5,592.0],[1045.2,488.2],[1027.9,393.8],[1003.7,308.6],[972.5,232.6],[934.5,166.0],[889.7,109.2],[838.3,62.7],[780.4,26.5],[715.8,0.7],[644.7,-14.8],[567.0,-20.0],[489.4,-14.9],[418.4,0.6],[354.2,26.2],[296.8,62.2],[246.0,108.5],[202.0,165.0],[164.7,231.4],[134.2,307.2],[110.5,392.5],[93.6,487.2],[83.4,591.4],[80.0,705.0],[83.3,820.9],[93.2,926.8],[109.6,1022.5],[132.7,1108.1],[162.3,1183.6],[198.5,1249.0],[241.8,1304.3],[292.8,1349.6],[351.4,1384.8],[417.6,1409.9],[491.5,1425.0],[573.0,1430.0],[652.4,1424.9],[724.5,1409.7],[789.4,1384.2],[847.0,1348.7],[897.4,1302.9],[940.5,1247.0],[976.7,1181.1],[1006.3,1105.4],[1029.4,1020.0],[1045.8,924.8],[1055.7,819.8],[1059.0,705.0]],[[876,705],[874.0,802.0],[868.2,889.7],[858.4,968.0],[844.7,1037.0],[827.0,1096.7],[805.5,1147.0],[779.5,1188.9],[748.3,1223.1],[712.1,1249.8],[670.8,1268.8],[624.5,1280.2],[573.0,1284.0],[520.3,1280.3],[472.7,1269.0],[430.4,1250.2],[393.2,1224.0],[361.3,1190.2],[334.5,1149.0],[312.3,1099.2],[294.2,1039.7],[280.1,970.5],[270.1,891.7],[264.0,803.2],[262.0,705.0],[264.0,609.5],[270.2,522.9],[280.4,445.2],[294.7,376.6],[313.0,316.8],[335.5,266.0],[362.4,223.5],[394.1,188.8],[430.6,161.8],[471.9,142.4],[518.1,130.9],[569.0,127.0],[619.6,130.9],[665.6,142.8],[706.8,162.5],[743.2,190.1],[775.0,225.6],[802.0,269.0],[824.6,320.6],[843.1,380.6],[857.5,449.0],[867.8,525.9],[873.9,611.2],[876.0,705.0]]],"1":[[[156,0],[156,153],[515,153],[515,1237],[197,1010],[197,1180],[530,1409],[696,1409],[696,153],[1039,153],[1039,0]]],"2":[[[103,0],[103,127],[120.6,165.2],[139.5,201.9],[159.6,237.1],[181.0,270.8],[203.6,302.9],[227.5,333.5],[252.2,362.9],[277.3,391.3],[302.9,418.8],[328.8,445.3],[355.2,470.9],[382.0,495.5],[409.0,519.4],[435.8,542.7],[462.6,565.4],[489.3,587.5],[516.0,609.0],[542.5,630.0],[568.6,650.7],[593.8,671.3],[618.1,692.0],[641.6,712.7],[664.2,733.3],[686.0,754.0],[706.7,774.8],[725.9,796.0],[743.9,817.5],[760.4,839.3],[775.7,861.5],[789.5,884.0],[801.6,907.2],[811.4,931.3],[819.1,956.5],[824.6,982.7],[827.9,1009.8],[829.0,1038.0],[827.1,1075.2],[821.4,1109.6],[812.0,1141.0],[798.8,1169.6],[781.8,1195.2],[761.0,1218.0],[736.9,1237.6],[709.8,1253.6],[679.8,1266.0],[646.8,1274.9],[610.9,1280.2],[572.0,1282.0],[534.8,1280.3],[499.8,1275.1],[467.1,1266.4],[436.7,1254.2],[408.5,1238.6],[382.5,1219.5],[359.4,1197.3],[339.7,1172.2],[323.4,1144.4],[310.5,1113.7],[301.0,1080.3],[295.0,1044.0],[111,1061],[120.5,1115.4],[135.8,1166.0],[156.9,1212.8],[183.7,1255.7],[216.2,1294.8],[254.5,1330.0],[297.6,1360.6],[344.7,1385.6],[395.6,1405.0],[450.5,1418.9],[509.3,1427.2],[572.0,1430.0],[640.3,1427.2],[703.1,1418.8],[760.4,1404.9],[812.2,1385.3],[858.6,1360.2],[899.5,1329.5],[934.5,1293.7],[963.1,1253.1],[985.4,1207.9],[1001.3,1157.9],[1010.8,1103.3],[1014.0,1044.0],[1013.0,1016.7],[1009.8,989.4],[1004.6,962.2],[997.3,935.1],[988.0,908.0],[976.5,881.0],[963.0,854.0],[947.4,827.0],[929.9,800.0],[910.3,773.0],[888.7,746.0],[865.0,719.0],[836.6,689.5],[800.7,655.1],[757.2,615.8],[706.3,571.4],[647.9,522.2],[582.0,468.0],[545.0,437.2],[510.6,407.4],[478.8,378.6],[449.6,350.9],[423.0,324.2],[399.0,298.5],[377.4,273.5],[357.9,248.8],[340.5,224.4],[325.2,200.3],[312.1,176.5],[301.0,153.0],[1036,153],[1036,0]]],"3":[[[1049,389],[1045.6,326.4],[1035.2,268.8],[1018.0,216.0],[993.9,168.1],[962.9,125.1],[925.0,87.0],[880.7,54.3],[830.6,27.6],[774.5,6.8],[712.6,-8.1],[644.7,-17.0],[571.0,-20.0],[502.1,-17.3],[437.9,-9.3],[378.6,4.1],[324.1,22.9],[274.4,47.0],[229.5,76.5],[189.9,111.2],[156.0,151.1],[127.9,196.1],[105.5,246.3],[88.9,301.6],[78.0,362.0],[264,379],[282.5,302.6],[314.1,240.1],[358.8,191.5],[416.4,156.8],[487.2,135.9],[571.0,129.0],[614.7,130.9],[655.2,136.4],[692.4,145.8],[726.3,158.8],[757.0,175.5],[784.5,196.0],[808.2,220.1],[827.6,247.9],[842.6,279.2],[853.4,314.2],[859.8,352.8],[862.0,395.0],[859.5,431.9],[852.2,466.1],[839.9,497.4],[822.7,525.9],[800.5,551.6],[773.5,574.5],[741.8,594.2],[705.8,610.3],[665.4,622.9],[620.6,631.8],[571.5,637.2],[518.0,639.0],[416,639],[416,795],[514,795],[561.5,796.8],[605.3,802.2],[645.4,811.1],[681.8,823.7],[714.5,839.8],[743.5,859.5],[768.4,882.4],[788.8,908.0],[804.6,936.4],[815.9,967.5],[822.7,1001.4],[825.0,1038.0],[823.2,1074.3],[817.6,1108.1],[808.4,1139.1],[795.4,1167.6],[778.8,1193.3],[758.5,1216.5],[734.5,1236.5],[707.0,1252.9],[675.9,1265.6],[641.2,1274.7],[602.9,1280.2],[561.0,1282.0],[522.6,1280.3],[486.7,1275.2],[453.4,1266.8],[422.6,1254.9],[394.3,1239.6],[368.5,1221.0],[345.7,1199.3],[326.3,1174.8],[310.4,1147.5],[297.8,1117.4],[288.7,1084.6],[283.0,1049.0],[102,1063],[111.5,1118.6],[126.8,1169.9],[147.9,1217.0],[174.7,1259.9],[207.2,1298.6],[245.5,1333.0],[288.6,1362.6],[335.7,1386.9],[386.6,1405.8],[441.5,1419.2],[500.3,1427.3],[563.0,1430.0],[631.0,1427.3],[693.8,1419.1],[751.4,1405.4],[803.7,1386.2],[850.7,1361.6],[892.5,1331.5],[928.4,1296.5],[957.8,1257.2],[980.6,1213.6],[996.9,1165.7],[1006.7,1113.5],[1010.0,1057.0],[1007.9,1013.4],[1001.6,972.6],[991.1,934.6],[976.4,899.4],[957.6,867.1],[934.5,837.5],[907.4,810.8],[876.6,787.2],[841.9,766.6],[803.4,749.1],[761.1,734.5],[715.0,723.0],[715,719],[765.7,711.3],[812.6,699.7],[855.5,684.0],[894.6,664.3],[929.7,640.7],[961.0,613.0],[987.9,582.1],[1009.9,548.6],[1027.0,512.5],[1039.2,473.9],[1046.6,432.7],[1049.0,389.0]]],"4":[[[881,319],[881,0],[711,0],[711,319],[47,319],[47,459],[692,1409],[881,1409],[881,461],[1079,461],[1079,319]],[[711,1206],[709.7,1202.9],[707.0,1197.4],[703.0,1189.8],[697.7,1179.8],[691.0,1167.5],[683.0,1153.0],[674.7,1138.1],[667.1,1124.8],[660.2,1113.0],[654.1,1102.8],[648.7,1094.1],[644.0,1087.0],[283,555],[229,481],[213,461],[711,461]]],"5":[[[1053,459],[1049.3,387.3],[1038.3,320.9],[1019.9,259.8],[994.1,203.9],[961.0,153.3],[920.5,108.0],[873.5,68.9],[820.8,36.9],[762.4,12.0],[698.3,-5.8],[628.5,-16.4],[553.0,-20.0],[489.4,-17.6],[430.1,-10.4],[375.0,1.5],[324.1,18.2],[277.4,39.7],[235.0,66.0],[197.1,96.8],[164.2,131.9],[136.2,171.2],[113.2,214.9],[95.1,262.8],[82.0,315.0],[264,336],[288.0,272.1],[321.9,219.9],[365.8,179.2],[419.6,150.2],[483.3,132.8],[557.0,127.0],[603.6,129.4],[646.7,136.7],[686.2,148.9],[722.3,165.9],[754.9,187.8],[784.0,214.5],[809.1,245.5],[829.6,280.1],[845.5,318.4],[856.9,360.3],[863.7,405.8],[866.0,455.0],[863.7,497.9],[856.8,538.0],[845.4,575.2],[829.3,609.7],[808.7,641.2],[783.5,670.0],[754.4,695.1],[722.1,715.6],[686.6,731.5],[647.9,742.9],[606.1,749.7],[561.0,752.0],[536.9,751.4],[513.4,749.4],[490.5,746.2],[468.1,741.8],[446.3,736.0],[425.0,729.0],[404.0,720.4],[383.0,710.1],[362.0,698.0],[341.0,684.1],[320.0,668.4],[299.0,651.0],[123,651],[170,1409],[971,1409],[971,1256],[334,1256],[307,809],[347.6,836.5],[391.3,859.0],[438.2,876.5],[488.3,889.0],[541.6,896.5],[598.0,899.0],[665.0,895.6],[727.3,885.4],[784.9,868.5],[837.8,844.8],[886.0,814.3],[929.5,777.0],[967.2,734.3],[998.1,687.4],[1022.1,636.5],[1039.3,581.4],[1049.6,522.3],[1053.0,459.0]]],"6":[[[1049,461],[1045.6,389.3],[1035.6,322.8],[1018.8,261.5],[995.2,205.4],[965.0,154.6],[928.0,109.0],[885.1,69.6],[837.1,37.3],[784.0,12.2],[725.8,-5.7],[662.4,-16.4],[594.0,-20.0],[517.8,-15.1],[447.8,-0.3],[384.0,24.2],[326.4,58.7],[275.1,102.9],[230.0,157.0],[191.5,220.5],[160.0,292.9],[135.5,374.2],[118.0,464.6],[107.5,563.8],[104.0,672.0],[107.6,789.3],[118.6,897.1],[136.8,995.5],[162.2,1084.4],[195.0,1163.9],[235.0,1234.0],[281.8,1293.9],[334.7,1342.9],[393.8,1381.0],[459.0,1408.2],[530.4,1424.6],[608.0,1430.0],[707.8,1422.0],[794.4,1398.1],[868.0,1358.2],[928.4,1302.4],[975.8,1230.7],[1010.0,1143.0],[838,1112],[816.8,1164.6],[788.7,1207.6],[753.5,1241.0],[711.3,1264.9],[662.2,1279.2],[606.0,1284.0],[556.6,1280.0],[511.1,1268.1],[469.4,1248.1],[431.6,1220.2],[397.6,1184.3],[367.5,1140.5],[341.7,1089.1],[320.6,1030.6],[304.1,964.9],[292.4,892.1],[285.3,812.1],[283.0,725.0],[300.4,754.1],[320.1,780.8],[342.0,805.1],[366.1,827.0],[392.4,846.5],[421.0,863.5],[451.4,878.0],[483.2,889.9],[516.5,899.1],[551.2,905.7],[587.4,909.7],[625.0,911.0],[687.8,907.6],[746.1,897.4],[799.9,880.5],[849.2,856.8],[894.1,826.3],[934.5,789.0],[969.5,746.0],[998.1,698.3],[1020.4,646.0],[1036.3,589.0],[1045.8,527.3],[1049.0,461.0]],[[866,453],[863.9,502.1],[857.7,547.2],[847.2,588.5],[832.7,625.9],[813.9,659.4],[791.0,689.0],[764.4,714.4],[734.4,735.1],[701.2,751.2],[664.8,762.8],[625.0,769.7],[582.0,772.0],[541.3,770.0],[503.4,763.8],[468.1,753.6],[435.6,739.3],[405.7,721.0],[378.5,698.5],[354.8,672.5],[335.4,643.3],[320.4,611.1],[309.6,575.8],[303.2,537.5],[301.0,496.0],[303.2,443.3],[309.9,393.9],[321.1,347.8],[336.8,304.9],[356.9,265.3],[381.5,229.0],[409.6,197.2],[440.2,171.2],[473.4,151.0],[509.1,136.6],[547.3,127.9],[588.0,125.0],[629.8,127.4],[668.4,134.7],[704.0,146.9],[736.4,163.9],[765.8,185.8],[792.0,212.5],[814.6,243.5],[833.1,278.1],[847.5,316.4],[857.8,358.3],[863.9,403.8],[866.0,453.0]]],"7":[[[1036,1263],[967.5,1157.0],[906.1,1058.9],[851.8,968.8],[804.4,886.6],[764.2,812.3],[731.0,746.0],[702.6,683.8],[676.6,621.9],[653.1,560.2],[632.1,498.9],[613.6,437.8],[597.5,377.0],[583.9,316.0],[572.8,254.2],[564.1,191.8],[557.9,128.6],[554.2,64.6],[553.0,0.0],[365,0],[368.2,90.8],[377.7,183.2],[393.6,277.1],[415.9,372.7],[444.5,469.8],[479.5,568.5],[521.9,670.5],[572.9,777.6],[632.4,889.6],[700.4,1006.7],[776.9,1128.8],[862.0,1256.0],[105,1256],[105,1409],[1036,1409]]],"8":[[[1050,393],[1046.6,330.4],[1036.2,272.6],[1019.0,219.5],[994.9,171.2],[963.9,127.7],[926.0,89.0],[881.7,55.7],[831.3,28.4],[775.0,7.2],[712.7,-7.9],[644.3,-17.0],[570.0,-20.0],[497.4,-17.0],[430.3,-8.1],[368.6,6.8],[312.4,27.6],[261.7,54.3],[216.5,87.0],[177.5,125.2],[145.7,168.3],[120.9,216.5],[103.2,269.7],[92.5,327.8],[89.0,391.0],[91.2,435.8],[97.8,478.1],[108.8,518.0],[124.1,555.4],[143.9,590.4],[168.0,623.0],[195.6,652.3],[225.6,677.4],[258.0,698.5],[292.9,715.4],[330.2,728.3],[370.0,737.0],[370,741],[333.0,751.8],[298.7,766.0],[267.1,783.8],[238.2,805.0],[212.0,829.8],[188.5,858.0],[168.2,888.9],[151.6,921.4],[138.6,955.8],[129.4,991.8],[123.8,1029.5],[122.0,1069.0],[125.3,1121.0],[135.4,1169.6],[152.1,1214.8],[175.6,1256.6],[205.7,1295.0],[242.5,1330.0],[285.0,1360.6],[332.0,1385.6],[383.6,1405.0],[439.8,1418.9],[500.6,1427.2],[566.0,1430.0],[632.9,1427.3],[694.9,1419.1],[752.1,1405.5],[804.4,1386.4],[851.9,1361.9],[894.5,1332.0],[931.3,1297.4],[961.4,1259.0],[984.9,1216.8],[1001.6,1170.7],[1011.7,1120.8],[1015.0,1067.0],[1013.1,1027.5],[1007.6,989.8],[998.2,953.8],[985.2,919.4],[968.5,886.9],[948.0,856.0],[924.3,827.9],[897.9,803.4],[868.8,782.8],[836.9,765.8],[802.3,752.5],[765.0,743.0],[765,739],[808.3,729.7],[848.3,716.5],[885.0,699.4],[918.3,678.3],[948.3,653.4],[975.0,624.5],[997.9,592.4],[1016.7,557.7],[1031.2,520.4],[1041.7,480.5],[1047.9,438.0],[1050.0,393.0]],[[828,1057],[820.7,1130.0],[798.9,1189.8],[762.5,1236.2],[711.6,1269.4],[646.1,1289.4],[566.0,1296.0],[525.3,1294.3],[488.1,1289.3],[454.1,1281.0],[423.6,1269.3],[396.3,1254.3],[372.5,1236.0],[352.2,1214.4],[335.6,1189.4],[322.6,1161.2],[313.4,1129.8],[307.8,1095.0],[306.0,1057.0],[307.9,1018.3],[313.6,982.7],[323.1,950.4],[336.4,921.2],[353.6,895.3],[374.5,872.5],[398.9,853.1],[426.4,837.2],[457.1,824.9],[490.9,816.1],[527.9,810.8],[568.0,809.0],[608.7,810.6],[645.9,815.5],[679.9,823.6],[710.4,835.0],[737.7,849.6],[761.5,867.5],[781.8,889.0],[798.4,914.6],[811.4,944.1],[820.6,977.7],[826.2,1015.3],[828.0,1057.0]],[[863,410],[860.8,451.9],[854.3,490.2],[843.5,524.9],[828.3,556.0],[808.8,583.5],[785.0,607.5],[757.2,627.8],[726.0,644.4],[691.2,657.4],[653.0,666.6],[611.2,672.2],[566.0,674.0],[522.0,672.0],[481.3,666.1],[444.0,656.1],[410.0,642.2],[379.3,624.3],[352.0,602.5],[328.5,577.2],[309.2,548.9],[294.2,517.6],[283.6,483.4],[277.1,446.2],[275.0,406.0],[283.3,317.1],[308.0,244.3],[349.2,187.8],[407.0,147.3],[481.3,123.1],[572.0,115.0],[618.9,117.0],[661.7,122.8],[700.2,132.6],[734.7,146.3],[764.9,164.0],[791.0,185.5],[813.0,211.3],[831.0,241.8],[845.0,276.9],[855.0,316.6],[861.0,361.0],[863.0,410.0]]],"9":[[[1042,733],[1038.3,616.7],[1027.3,509.7],[1008.9,412.0],[983.1,323.7],[950.0,244.7],[909.5,175.0],[862.2,115.4],[808.7,66.7],[748.9,28.8],[682.8,1.7],[610.5,-14.6],[532.0,-20.0],[478.8,-18.1],[429.3,-12.3],[383.4,-2.6],[341.1,10.9],[302.5,28.3],[267.5,49.5],[235.9,75.0],[207.4,105.3],[182.1,140.4],[159.9,180.2],[140.9,224.7],[125.0,274.0],[297,301],[318.6,247.2],[347.4,203.2],[383.5,169.0],[426.8,144.6],[477.3,129.9],[535.0,125.0],[584.7,129.0],[630.6,141.0],[672.5,161.0],[710.6,189.0],[744.7,225.0],[775.0,269.0],[801.1,320.4],[822.7,378.7],[839.8,443.8],[852.3,515.7],[860.4,594.4],[864.0,680.0],[849.1,651.0],[831.0,623.9],[809.8,598.9],[785.3,575.8],[757.8,554.7],[727.0,535.5],[694.1,518.8],[660.2,505.2],[625.2,494.6],[589.2,487.1],[552.1,482.5],[514.0,481.0],[452.8,484.6],[395.8,495.4],[343.0,513.5],[294.4,538.8],[250.1,571.3],[210.0,611.0],[175.2,656.7],[146.7,707.1],[124.5,762.2],[108.7,822.1],[99.2,886.7],[96.0,956.0],[99.4,1027.0],[109.8,1092.8],[127.0,1153.4],[151.1,1208.7],[182.1,1258.7],[220.0,1303.5],[264.0,1342.2],[313.4,1373.8],[368.2,1398.4],[428.4,1415.9],[494.0,1426.5],[565.0,1430.0],[640.2,1425.2],[709.0,1410.7],[771.5,1386.5],[827.7,1352.7],[877.5,1309.2],[921.0,1256.0],[958.0,1193.1],[988.2,1120.6],[1011.8,1038.2],[1028.6,946.2],[1038.6,844.5],[1042.0,733.0]],[[846,907],[843.8,961.8],[837.3,1012.9],[826.5,1060.4],[811.3,1104.1],[791.8,1144.2],[768.0,1180.5],[740.5,1212.1],[710.1,1238.0],[676.8,1258.1],[640.4,1272.5],[601.2,1281.1],[559.0,1284.0],[517.2,1281.5],[478.4,1274.2],[442.8,1261.9],[410.1,1244.7],[380.5,1222.5],[354.0,1195.5],[331.1,1164.3],[312.3,1129.6],[297.8,1091.4],[287.3,1049.7],[281.1,1004.6],[279.0,956.0],[281.1,906.5],[287.3,860.5],[297.8,818.1],[312.3,779.3],[331.1,744.1],[354.0,712.5],[380.5,685.2],[409.9,662.8],[442.2,645.4],[477.6,632.9],[515.8,625.5],[557.0,623.0],[582.7,624.0],[607.8,626.9],[632.2,631.9],[656.1,638.8],[679.4,647.7],[702.0,658.5],[723.5,671.2],[743.5,685.4],[761.9,701.4],[778.7,718.9],[793.9,738.2],[807.5,759.0],[819.3,781.2],[828.9,804.3],[836.4,828.5],[841.7,853.7],[844.9,879.8],[846.0,907.0]]]}};
const GW = 12, GH = 18;
function rasterContours(contours, bb) { // ლუწ-კენტი შევსება GW x GH ბადეზე
  const [x0, y0, x1, y1] = bb, w = (x1 - x0) || 1, h = (y1 - y0) || 1, out = new Uint8Array(GW * GH);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const px = x0 + (i + 0.5) / GW * w, py = y0 + (j + 0.5) / GH * h; let inside = false;
    for (const c of contours) for (let a = 0, b = c.length - 1; a < c.length; b = a++) {
      const [xa, ya] = c[a], [xb, yb] = c[b];
      if ((ya > py) !== (yb > py) && px < (xb - xa) * (py - ya) / (yb - ya) + xa) inside = !inside;
    }
    out[j * GW + i] = inside ? 1 : 0;
  }
  return out;
}
const bboxOf = (cs) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cs) for (const [x, y] of c) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
let TPL = null;
function templates() {
  if (TPL) return TPL;
  TPL = [];
  for (const font of Object.keys(DIGIT_TEMPLATES)) for (const d of Object.keys(DIGIT_TEMPLATES[font])) {
    const cs = DIGIT_TEMPLATES[font][d], bb = bboxOf(cs);
    TPL.push({ d, font, bmp: rasterContours(cs, bb), aspect: (bb[2] - bb[0]) / (bb[3] - bb[1]) });
  }
  return TPL;
}
function classifyGlyph(cs) { // -> {d, score}
  const bb = bboxOf(cs), aspect = (bb[2] - bb[0]) / ((bb[3] - bb[1]) || 1), bmp = rasterContours(cs, bb);
  let best = { d: null, score: -1 }, second = -1;
  for (const t of templates()) {
    let inter = 0, uni = 0; for (let i = 0; i < bmp.length; i++) { inter += bmp[i] & t.bmp[i]; uni += bmp[i] | t.bmp[i]; }
    const score = (uni ? inter / uni : 0) - 0.5 * Math.abs(Math.log((aspect + 0.05) / (t.aspect + 0.05)));
    if (score > best.score) { if (best.d !== t.d) second = Math.max(second, best.score); best = { d: t.d, score }; }
    else if (t.d !== best.d && score > second) second = score;
  }
  best.margin = best.score - second;
  return best;
}
function readLabel(contours) { // კონტურების ჯგუფი -> რიცხვი (4 შესაძლო მობრუნებიდან საუკეთესო)
  let best = null;
  for (const rot of [0, 90, 180, 270]) {
    const r = rot * Math.PI / 180, cr = Math.round(Math.cos(r)), sr = Math.round(Math.sin(r));
    const cs = contours.map(c => c.map(([x, y]) => [x * cr + y * sr, -x * sr + y * cr])); // ვაბრუნებთ -rot-ით
    // ასოებად დაჯგუფება: x-ში გადაფარვადი კონტურები (ხვრელები) ერთ ასოს ეკუთვნის
    const items = cs.map(c => ({ c, bb: bboxOf([c]) })).sort((a, b) => a.bb[0] - b.bb[0]);
    const glyphs = [];
    for (const it of items) {
      const g = glyphs[glyphs.length - 1];
      if (g && it.bb[0] < g.bb[2] - 0.05 * (g.bb[2] - g.bb[0])) { g.cs.push(it.c); g.bb = bboxOf(g.cs); }
      else glyphs.push({ cs: [it.c], bb: it.bb });
    }
    const H = Math.max(...glyphs.map(g => g.bb[3] - g.bb[1]));
    const real = glyphs.filter(g => g.bb[3] - g.bb[1] > 0.5 * H); // წერტილები/ნაგავი გამოვრიცხოთ
    if (real.length < 6 || real.length > 9) continue;
    // ათწილადი წერტილი (დიდი მასშტაბის გეგმებზე, მაგ. "484245.6", "4615528.2"): პატარა ნიშანი
    // ციფრებს შორის, ხაზის ძირთან. სწორ მობრუნებაზე წერტილი ქვედა ნაწილშია; 180°-ზე - ზედა.
    const bottom = Math.min(...real.map(g => g.bb[1]));
    const dots = glyphs.filter(g => { const h = g.bb[3] - g.bb[1], w = g.bb[2] - g.bb[0];
      return h < 0.3 * H && w < 0.4 * H && (g.bb[1] + g.bb[3]) / 2 < bottom + 0.3 * H; });
    let decimalAfter = -1; // რამდენი ციფრია წერტილამდე
    for (const d of dots) {
      const cx = (d.bb[0] + d.bb[2]) / 2;
      const k = real.findIndex(g => g.bb[0] > cx); // პირველი ციფრი წერტილის შემდეგ
      if (k > 0) { if (decimalAfter >= 0 && decimalAfter !== k) { decimalAfter = -2; break; } decimalAfter = k; }
    }
    if (decimalAfter === -2) continue; // ორი სხვადასხვა წერტილი - რიცხვი არ არის
    const intDigits = decimalAfter > 0 ? decimalAfter : real.length;
    if (intDigits < 6 || intDigits > 7 || real.length - intDigits > 2) continue; // ≤ 2 ათწილადი
    const res = real.map(g => classifyGlyph(g.cs));
    const score = res.reduce((s, x) => s + x.score, 0) / res.length;
    const ds = res.map(x => x.d).join('');
    const value = +(intDigits < real.length ? ds.slice(0, intDigits) + '.' + ds.slice(intDigits) : ds);
    if (!best || score > best.score) best = { value, digits: intDigits, decimals: real.length - intDigits, score, minMargin: Math.min(...res.map(x => x.margin)) };
  }
  return best;
}
function readGlyphLabels(ex, vx, hy) {
  // მუქი ფერის პატარა, დახურული კონტურები = ასოების კანდიდატები
  const dark = ex.painted.filter(sp => sp.pts.length >= 3 && Math.max(...sp.color) < 160 && Math.abs(sp.color[0] - sp.color[1]) < 20 && Math.abs(sp.color[1] - sp.color[2]) < 20)
    .map(sp => ({ c: sp.pts, bb: bboxOf([sp.pts]) })).filter(o => o.bb[2] - o.bb[0] < 15 && o.bb[3] - o.bb[1] < 15);
  const ext = (lines, sp, axis) => { // ხაზების ბოლოები
    let a = Infinity, b = -Infinity;
    for (const p of ex.painted) for (let i = 0; i + 1 < p.pts.length; i++) {
      const [x0, y0] = p.pts[i], [x1, y1] = p.pts[i + 1];
      if (axis === 'v' && Math.abs(x0 - x1) < 0.01 && Math.abs(x0 - sp) < 0.01) { a = Math.min(a, y0, y1); b = Math.max(b, y0, y1); }
      if (axis === 'h' && Math.abs(y0 - y1) < 0.01 && Math.abs(y0 - sp) < 0.01) { a = Math.min(a, x0, x1); b = Math.max(b, x0, x1); }
    }
    return [a, b];
  };
  const reads = { x: [], y: [] };
  const take = (sel, pos, key, ndig, lo, hi) => {
    if (sel.length < 6) return;
    const r = readLabel(sel.map(o => o.c));
    if (r && r.digits === ndig && r.value >= lo && r.value <= hi) reads[key].push([pos, r.value, r.score, r.minMargin]);
  };
  for (const X of vx) {
    const [ya, yb] = ext(vx, X, 'v');
    const cx = (o) => (o.bb[0] + o.bb[2]) / 2, cy = (o) => (o.bb[1] + o.bb[3]) / 2;
    take(dark.filter(o => Math.abs(cx(o) - X) < 30 && cy(o) > yb && cy(o) < yb + 16), X, 'x', 6, 166000, 834000);
    take(dark.filter(o => Math.abs(cx(o) - X) < 30 && cy(o) < ya && cy(o) > ya - 16), X, 'x', 6, 166000, 834000);
  }
  for (const Y of hy) {
    const [xa, xb] = ext(hy, Y, 'h');
    const cx = (o) => (o.bb[0] + o.bb[2]) / 2, cy = (o) => (o.bb[1] + o.bb[3]) / 2;
    take(dark.filter(o => Math.abs(cy(o) - Y) < 30 && cx(o) < xa && cx(o) > xa - 16), Y, 'y', 7, 3500000, 5500000);
    take(dark.filter(o => Math.abs(cy(o) - Y) < 30 && cx(o) > xb && cx(o) < xb + 16), Y, 'y', 7, 3500000, 5500000);
  }
  // ორჯერ წაკითხული (ზედა/ქვედა, მარცხენა/მარჯვენა) ერთი ხაზისთვის: ვინარჩუნებთ მხოლოდ თანხმობას ან უკეთესს
  const merge = (arr) => {
    const by = new Map(); for (const r of arr) { const k = r[0]; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
    const out = []; for (const [k, rs] of by) { rs.sort((a, b) => b[2] - a[2]); out.push([k, rs[0][1]]); }
    return out.sort((a, b) => a[0] - b[0]);
  };
  return { px: merge(reads.x), py: merge(reads.y), raw: reads };
}


// ---------- რასტრული გეგმა: გვერდის დახატვა და წითელი ხაზის მიყოლა (HTML ფაილის UI ნაწილიდან, უცვლელი) ----------
async function rasterGeometry(page, ex) { // საზღვარი სურათშია: გვერდს ვარენდერებთ და წითელ ხაზს ვუყვებით
  const frame = gridFrame(ex);
  if (!frame) throw new Error('რასტრული PDF: ბადის ჩარჩო ვერ ვიპოვე, გეორეფერენსი შეუძლებელია.');
  const ov = (b) => Math.max(0, Math.min(b[2], frame[2]) - Math.max(b[0], frame[0])) * Math.max(0, Math.min(b[3], frame[3]) - Math.max(b[1], frame[1]));
  const imgs = ex.images.filter(im => ov(im.bbox) > 0).sort((a, b) => ov(b.bbox) - ov(a.bbox));
  const nativePt = imgs.length ? imgs[0].ptPerPx : 0.5;
  let scale = Math.min(6, Math.max(2, 2.5 / nativePt));
  const fw = frame[2] - frame[0], fh = frame[3] - frame[1];
  scale = Math.min(scale, Math.sqrt(5e6 / (fw * fh))); // ტელეფონის მეხსიერებისთვის (~5 მლნ პიქსელი)
  const vp = page.getViewport({ scale });
  const [ax, ay] = vp.convertToViewportPoint(frame[0], frame[1]), [bx, by] = vp.convertToViewportPoint(frame[2], frame[3]);
  const x0 = Math.floor(Math.min(ax, bx)) + 2, y0 = Math.floor(Math.min(ay, by)) + 2;
  const W = Math.ceil(Math.max(ax, bx)) - 2 - x0, H = Math.ceil(Math.max(ay, by)) - 2 - y0;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -x0, -y0] }).promise;
  const img = ctx.getImageData(0, 0, W, H);
  const t = traceRedBoundary(img.data, W, H, nativePt * scale);
  canvas.width = canvas.height = 0;
  const ringPdf = t.ring.map(([x, y]) => vp.convertToPdfPoint(x + x0, y + y0));
  const g = buildGeometryRaster(ex, ringPdf, nativePt);
  g.notes.push(`რასტრი: ორიგინალი სურათის პიქსელი ≈ ${(nativePt * Math.max(Math.abs(g.info.scaleX), Math.abs(g.info.scaleY))).toFixed(2)} მ, საზღვრის ხაზის სისქე ≈ ${(t.lineWidthPx / scale * Math.abs(g.info.scaleX)).toFixed(2)} მ.`);
  return g;
}
