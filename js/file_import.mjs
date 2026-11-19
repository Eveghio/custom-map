// file_import.mjs - შენი ფაილები რუკაზე: KML, KMZ, GeoJSON, Shapefile (.shp + .dbf + .prj, ან ყველა ერთ ZIP-ში).
//
// შედეგი: [{ name, fileName, geometry (GeoJSON, გრძედი/განედი) }] - თითო ობიექტი ცალკე.
// ყველაფერი ბრაუზერში ხდება: ფაილი არსად იგზავნება.
// Shapefile-ის კოორდინატები: .prj-დან (WGS 84 ან UTM 37N/38N); .prj თუ არ არის - რიცხვებიდან ვხვდებით
// (UTM-ის ზონა ისე, რომ ობიექტი საქართველოში მოხვდეს).

import { utmToLonLat } from "./plan/plan_converter.js";

// ---------- ZIP (KMZ და SHP ZIP) ----------
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ZIP-ის ფაილები: [{ name, bytes }]
async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--; // ცენტრალური კატალოგის ბოლო
  if (end < 0) throw new Error("ZIP ფაილი დაზიანებულია");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const files = [];
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) files.push({ name, bytes: data });
    else if (method === 8) files.push({ name, bytes: await inflateRaw(data) });
  }
  return files;
}

// ---------- KML ----------
const kmlCoordinates = (text) => String(text || "").trim().split(/\s+/).filter(Boolean)
  .map((triple) => triple.split(",").slice(0, 2).map(Number)).filter((pair) => pair.length === 2 && pair.every(Number.isFinite));

function kmlGeometries(element) {
  const result = [];
  for (const child of element.children) {
    const tag = child.localName;
    if (tag === "Polygon") {
      const ring = (selector) => [...child.getElementsByTagNameNS("*", selector)]
        .map((boundary) => kmlCoordinates((boundary.getElementsByTagNameNS("*", "coordinates")[0] || {}).textContent));
      const outer = ring("outerBoundaryIs")[0];
      if (outer && outer.length >= 3) result.push({ type: "Polygon", coordinates: [outer, ...ring("innerBoundaryIs")] });
    } else if (tag === "LineString" || tag === "LinearRing") {
      const line = kmlCoordinates((child.getElementsByTagNameNS("*", "coordinates")[0] || {}).textContent);
      if (line.length >= 2) result.push({ type: "LineString", coordinates: line });
    } else if (tag === "Point") {
      const point = kmlCoordinates((child.getElementsByTagNameNS("*", "coordinates")[0] || {}).textContent)[0];
      if (point) result.push({ type: "Point", coordinates: point });
    } else if (tag === "MultiGeometry") result.push(...kmlGeometries(child));
  }
  return result;
}

function parseKml(text, fileName) {
  const documentXml = new DOMParser().parseFromString(text, "application/xml");
  if (documentXml.getElementsByTagName("parsererror").length) throw new Error("KML ვერ წავიკითხე");
  return [...documentXml.getElementsByTagNameNS("*", "Placemark")].map((placemark) => {
    const nameElement = [...placemark.children].find((child) => child.localName === "name");
    const geometries = kmlGeometries(placemark);
    if (!geometries.length) return null;
    return { name: nameElement ? nameElement.textContent.trim() : "", fileName,
      geometry: geometries.length === 1 ? geometries[0] : { type: "GeometryCollection", geometries } };
  }).filter(Boolean);
}

// ---------- GeoJSON ----------
// სახელი თვისებებიდან: ჯერ ცნობილი ველები, მერე პირველი ტექსტი
function nameFromProperties(properties) {
  if (!properties) return "";
  for (const key of ["name", "Name", "NAME", "კოდი", "cad_code", "CAD_CODE", "cadcode", "code", "title"]) {
    if (properties[key] !== undefined && properties[key] !== null && String(properties[key]).trim()) return String(properties[key]).trim();
  }
  const first = Object.values(properties).find((value) => typeof value === "string" && value.trim());
  return first ? first.trim() : "";
}

function parseGeoJson(text, fileName) {
  const data = JSON.parse(text);
  const features = data.type === "FeatureCollection" ? data.features : data.type === "Feature" ? [data] : [{ type: "Feature", geometry: data, properties: {} }];
  return features.filter((feature) => feature && feature.geometry)
    .map((feature) => {
      // ფერი: simplestyle „stroke“ (ასე ინახავს რუკის „⤓ GeoJSON“-იც და geojson.io-ც)
      const stroke = feature.properties && feature.properties.stroke;
      const color = typeof stroke === "string" && /^#[0-9a-f]{6}$/i.test(stroke) ? stroke.toLowerCase() : undefined;
      return { name: nameFromProperties(feature.properties), fileName, geometry: feature.geometry, color };
    });
}

// ---------- Shapefile ----------
// .prj -> ფუნქცია [x, y] -> [გრძედი, განედი]; null = უცნობი (რიცხვებიდან გამოვიცნობთ)
function projectionFromPrj(prjText) {
  if (!prjText) return null;
  const zone = prjText.match(/UTM[ _]?zone[ _]?(\d{2})\s*N/i) || prjText.match(/326(3[78])/);
  if (zone) return (point) => utmToLonLat(point[0], point[1], Number(zone[1]), "N");
  if (/^\s*GEOGCS/i.test(prjText)) return (point) => point;
  throw new Error("კოორდინატთა სისტემა (.prj) უცნობია: მხოლოდ WGS 84 და UTM 37N/38N ვიცი");
}

const insideGeorgia = ([lon, lat]) => lon > 39.9 && lon < 46.8 && lat > 41.0 && lat < 43.7;

// .prj-ის გარეშე: გრძედ-განედი, თუ არა - UTM 38N ან 37N (რომელშიც ობიექტი საქართველოში ხვდება)
function guessProjection(samplePoint) {
  if (Math.abs(samplePoint[0]) <= 180 && Math.abs(samplePoint[1]) <= 90) return (point) => point;
  for (const zone of [38, 37]) {
    if (insideGeorgia(utmToLonLat(samplePoint[0], samplePoint[1], zone, "N"))) return (point) => utmToLonLat(point[0], point[1], zone, "N");
  }
  throw new Error(".prj ფაილი არ არის და კოორდინატები საქართველოში არ ხვდება");
}

// რგოლის ფართობი (ნიშნით; მხოლოდ ზომების შესადარებლად)
const ringArea = (ring) => {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
};
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if ((ring[i][1] > y) !== (ring[j][1] > y) && x < (ring[j][0] - ring[i][0]) * (y - ring[i][1]) / (ring[j][1] - ring[i][1]) + ring[i][0]) inside = !inside;
  }
  return inside;
}

function parseDbf(bytes) {
  if (!bytes) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, true), headerLength = view.getUint16(8, true), recordLength = view.getUint16(10, true);
  const decoder = new TextDecoder("utf-8");
  const fields = [];
  for (let offset = 32; offset < headerLength - 1 && bytes[offset] !== 0x0d; offset += 32) {
    fields.push({ name: decoder.decode(bytes.subarray(offset, offset + 11)).replace(/\0.*$/, "").trim(), length: bytes[offset + 16] });
  }
  const records = [];
  for (let i = 0; i < count; i++) {
    let offset = headerLength + i * recordLength + 1; // პირველი ბაიტი = წაშლის ნიშანი
    const record = {};
    for (const field of fields) { record[field.name] = decoder.decode(bytes.subarray(offset, offset + field.length)).trim(); offset += field.length; }
    records.push(record);
  }
  return records;
}

function parseShp(shpBytes, dbfBytes, prjText, fileName) {
  const view = new DataView(shpBytes.buffer, shpBytes.byteOffset, shpBytes.byteLength);
  const records = parseDbf(dbfBytes);
  let project = projectionFromPrj(prjText);
  const result = [];
  let offset = 100, index = 0;
  while (offset + 12 <= shpBytes.length) {
    const contentLength = view.getInt32(offset + 4) * 2; // big-endian, 16-ბიტიან სიტყვებში
    const start = offset + 8, type = view.getInt32(start, true);
    offset = start + contentLength;
    const properties = records[index++] || {};
    if (type === 0) continue; // ცარიელი
    const readPoint = (at) => [view.getFloat64(at, true), view.getFloat64(at + 8, true)];
    let geometry = null;
    if (type === 1 || type === 11 || type === 21) {
      const point = readPoint(start + 4);
      project = project || guessProjection(point);
      geometry = { type: "Point", coordinates: project(point) };
    } else if ([3, 5, 13, 15, 23, 25].includes(type)) {
      const partCount = view.getInt32(start + 36, true), pointCount = view.getInt32(start + 40, true);
      const parts = []; for (let i = 0; i < partCount; i++) parts.push(view.getInt32(start + 44 + i * 4, true));
      const pointsStart = start + 44 + partCount * 4;
      const rawParts = parts.map((first, i) => {
        const last = i + 1 < partCount ? parts[i + 1] : pointCount;
        const ring = []; for (let p = first; p < last; p++) ring.push(readPoint(pointsStart + p * 16));
        return ring;
      });
      project = project || guessProjection(rawParts[0][0]);
      if (type % 10 === 3) { // ხაზი
        const lines = rawParts.map((part) => part.map(project));
        geometry = lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines };
      } else { // პოლიგონი: გარე რგოლები და მათში ხვრელები
        // მიმართულებას ყველა პროგრამა სწორად არ წერს, ამიტომ ვამოწმებთ მდებარეობასაც:
        // დიდიდან პატარისკენ; რგოლი, რომელიც უკვე მიღებულ გარე რგოლშია (და არა მის ხვრელში), ხვრელია.
        const rings = rawParts.map((raw) => ({ ring: raw.map(project), size: Math.abs(ringArea(raw)) })).sort((a, b) => b.size - a.size);
        const polygons = [];
        for (const { ring } of rings) {
          const owner = polygons.find((polygon) => pointInRing(ring[0], polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(ring[0], hole)));
          if (owner) owner.push(ring); else polygons.push([ring]);
        }
        geometry = polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0] } : { type: "MultiPolygon", coordinates: polygons };
      }
    }
    if (geometry) result.push({ name: nameFromProperties(properties), fileName, geometry });
  }
  return result;
}

// ---------- შესასვლელი ----------
const extensionOf = (name) => (name.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
const baseOf = (name) => name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").toLowerCase();

// entries: [{ name, bytes }] - ერთად ჩაგდებული ან ZIP-იდან ამოღებული ფაილები
async function importEntries(entries, warnings) {
  const result = [];
  const byBase = new Map(); // shapefile-ის ნაწილები სახელით
  for (const entry of entries) {
    const extension = extensionOf(entry.name), text = () => new TextDecoder().decode(entry.bytes);
    try {
      const shownName = entry.archive || entry.name; // ZIP/KMZ-ის შიგთავსი არქივის სახელით ჩანს
      if (extension === "kml") result.push(...parseKml(text(), shownName));
      else if (extension === "geojson" || extension === "json") result.push(...parseGeoJson(text(), shownName));
      else if (extension === "kmz" || extension === "zip") {
        const inner = (await unzip(entry.bytes)).map((file) => ({ ...file, archive: entry.archive || entry.name }));
        result.push(...await importEntries(inner, warnings));
      }
      else if (["shp", "dbf", "prj", "cpg", "shx"].includes(extension)) {
        const base = baseOf(entry.name);
        if (!byBase.has(base)) byBase.set(base, {});
        byBase.get(base)[extension] = entry;
      } else if (!entry.name.startsWith("__MACOSX")) warnings.push(entry.name + ": ამ ტიპის ფაილს ვერ ვკითხულობ");
    } catch (error) {
      warnings.push(entry.name + ": " + error.message);
    }
  }
  for (const parts of byBase.values()) {
    if (!parts.shp) { if (parts.dbf) warnings.push(parts.dbf.name + ": .shp ფაილი აკლია"); continue; }
    try {
      const prjText = parts.prj ? new TextDecoder().decode(parts.prj.bytes) : "";
      result.push(...parseShp(parts.shp.bytes, parts.dbf && parts.dbf.bytes, prjText, parts.shp.archive || parts.shp.name.replace(/^.*\//, "")));
    } catch (error) {
      warnings.push(parts.shp.name + ": " + error.message);
    }
  }
  return result;
}

// files: FileList / File[] -> { items, warnings }
export async function importFiles(files) {
  const entries = await Promise.all([...files].map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
  const warnings = [];
  const items = await importEntries(entries, warnings);
  return { items, warnings };
}
