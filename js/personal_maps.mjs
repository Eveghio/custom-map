/**
 * personal_maps.mjs: პირადი რუკები = სამუშაო მაგიდის (workItems) შენახვა სახელით.
 *
 * სად ინახება:
 *   - „Drive“: მომხმარებლის საკუთარ Google Drive-ში, ამ საიტის დამალულ საქაღალდეში (appDataFolder).
 *     ფაილებს ხედავს მხოლოდ ეს მომხმარებელი და მხოლოდ ეს საიტი: Drive-ის სიაში არ ჩანს და Google ამ საქაღალდის
 *     გაზიარებას საერთოდ არ უშვებს, ამიტომ კოლეგები ერთმანეთის რუკებს ვერ ნახავენ. Sheet-ზე უფლება არ სჭირდება.
 *     ტოკენი და Drive-ის გამოძახება: js/backend.js → SERVER.driveFetch / connectDrive.
 *   - „ბრაუზერი“: Drive-ის გარეშე (ან სანამ დაუკავშირდება) ამ ბრაუზერის localStorage-ში, მხოლოდ ამ მოწყობილობაზე.
 *
 * გაზიარება: რუკის ასლი ბმულშივე, # ნაწილში (#pm=…, gzip + base64url). # ნაწილს ბრაუზერი სერვერზე არ აგზავნის:
 * მას ხედავს მხოლოდ ის, ვისაც ბმული აქვს. ბმული ასლია: შემდგომი ცვლილებები მასში არ აისახება.
 *
 * ბმულიდან და ფაილიდან მიღებული მონაცემი უცხოა: ყოველი ველი მოწმდება (cleanItem / cleanGeometry), სანამ რუკაზე დაიხატება.
 */

export const FORMAT = 'custom-map/personal-map';
export const VERSION = 1;
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const LOCAL_INDEX_KEY = 'customMapPersonalMaps';       // [{ id, name, codes, count, modified }]
const LOCAL_MAP_KEY = (id) => 'customMapPersonalMap:' + id; // რუკის შიგთავსი (JSON)
const MAX_POINTS = 300000;          // ერთ რუკაში წვეროების ზღვარი (უცხო ბმული ბრაუზერს არ უნდა გაჭედავდეს)
const MAX_SHARE_BYTES = 8 * 1024 * 1024; // გაშლილი ბმულის ზღვარი
export const LONG_LINK = 8000;      // ამაზე გრძელ ბმულს ზოგი მესენჯერი ჭრის

// ---------- გასუფთავება (შენახვამდე და ჩატვირთვისას) ----------
const text = (value, max) => (typeof value === 'string' || typeof value === 'number') ? String(value).slice(0, max) : '';
const round7 = (number) => Math.round(number * 1e7) / 1e7; // ~1 სმ

// წერტილი [გრძედი, განედი] → შემოწმებული და დამრგვალებული, ან null
function cleanPoint(point, budget) {
  if (!Array.isArray(point) || point.length < 2) return null;
  const [lng, lat] = point;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
  if (--budget.points < 0) throw new Error('რუკაში ძალიან ბევრი წვეროა.');
  return [round7(lng), round7(lat)];
}
// depth: 0 = წერტილი, 1 = წერტილების სია, 2 = რგოლების სია, 3 = პოლიგონების სია
function cleanCoordinates(coordinates, depth, budget) {
  if (depth === 0) return cleanPoint(coordinates, budget);
  if (!Array.isArray(coordinates)) return null;
  const result = [];
  for (const child of coordinates) {
    const cleaned = cleanCoordinates(child, depth - 1, budget);
    if (cleaned && (depth === 1 || cleaned.length)) result.push(cleaned);
  }
  return result;
}
const DEPTH = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };

export function cleanGeometry(geometry, budget = { points: MAX_POINTS }) {
  if (!geometry || typeof geometry !== 'object') return null;
  if (geometry.type === 'FeatureCollection' && Array.isArray(geometry.features)) {
    const features = geometry.features.map((feature) => feature && cleanGeometry(feature.geometry, budget))
      .filter(Boolean).map((cleaned) => ({ type: 'Feature', properties: {}, geometry: cleaned }));
    return features.length ? { type: 'FeatureCollection', features } : null;
  }
  if (!(geometry.type in DEPTH)) return null;
  const coordinates = cleanCoordinates(geometry.coordinates, DEPTH[geometry.type], budget);
  if (!coordinates || (Array.isArray(coordinates) && !coordinates.length)) return null;
  return { type: geometry.type, coordinates };
}

// სამუშაო მაგიდის სტრიქონი → შესანახი სუფთა ობიექტი (layer, editing და სხვა დროებითი ველების გარეშე)
export function cleanItem(item, budget = { points: MAX_POINTS }) {
  if (!item || typeof item !== 'object') return null;
  const geometry = cleanGeometry(item.geometry, budget);
  if (!geometry) return null;
  const clean = { code: text(item.code, 200) || 'ობიექტი', source: text(item.source, 300), geometry,
    color: /^#[0-9a-f]{6}$/i.test(item.color) ? item.color.toLowerCase() : '#00b8d9' };
  if (item.address) clean.address = text(item.address, 300);
  if (item.areaText) clean.areaText = text(item.areaText, 120);
  if (Array.isArray(item.warnings) && item.warnings.length) clean.warnings = item.warnings.slice(0, 10).map((warning) => text(warning, 500)).filter(Boolean);
  if (Number.isInteger(item.planNumber) && item.planNumber > 0) clean.planNumber = item.planNumber;
  if (item.planRegNo) clean.planRegNo = text(item.planRegNo, 60);
  if (item.contour && typeof item.contour === 'object') {
    clean.contour = { isRaster: !!item.contour.isRaster };
    if (Number.isFinite(item.contour.planDateMs)) clean.contour.planDateMs = item.contour.planDateMs;
  }
  if (Number.isInteger(item.count) && item.count > 0) clean.count = item.count;
  if (item.hidden) clean.hidden = true;
  if (item.edited) clean.edited = true;
  return clean;
}

export function cleanItems(items) {
  const budget = { points: MAX_POINTS };
  return (Array.isArray(items) ? items : []).map((item) => cleanItem(item, budget)).filter(Boolean);
}

// შენახულთან შესადარებლად („შეუნახავი ცვლილება“)
export const snapshotText = (items) => JSON.stringify(cleanItems(items));

export function makeDocument(name, items) {
  return { format: FORMAT, version: VERSION, name: text(name, 120), saved: new Date().toISOString(), items: cleanItems(items) };
}

export function parseDocument(value) {
  const data = typeof value === 'string' ? JSON.parse(value) : value;
  if (!data || data.format !== FORMAT) throw new Error('ეს პირადი რუკის ფაილი არ არის.');
  if (data.version > VERSION) throw new Error('რუკა საიტის უფრო ახალი ვერსიითაა შენახული: განაახლე გვერდი (Ctrl+Shift+R).');
  return { name: text(data.name, 120) || 'უსახელო რუკა', saved: text(data.saved, 40), items: cleanItems(data.items) };
}

const codesOf = (items) => Array.from(new Set(items.map((item) => item.code))).join(', ').slice(0, 2000);

// ---------- Drive (appDataFolder) ----------
const drive = () => window.SERVER;

async function driveList() {
  const parameters = new URLSearchParams({ spaces: 'appDataFolder', q: 'trashed = false', pageSize: '1000', orderBy: 'modifiedTime desc',
    fields: 'files(id,name,description,modifiedTime,appProperties)' });
  const response = await drive().driveFetch(DRIVE_FILES + '?' + parameters);
  const body = await response.json();
  return (body.files || []).filter((file) => !file.appProperties || !file.appProperties.format || file.appProperties.format === FORMAT)
    .map((file) => ({ id: file.id, storage: 'drive', name: file.name.replace(/\.json$/, ''), codes: file.description || '',
      count: Number((file.appProperties || {}).count) || 0, modified: file.modifiedTime || '' }));
}

async function driveSave(id, document) {
  const metadata = { name: document.name, mimeType: 'application/json', description: codesOf(document.items),
    appProperties: { format: FORMAT, count: String(document.items.length) } };
  if (!id) metadata.parents = ['appDataFolder'];
  // multipart: მეტამონაცემი + შიგთავსი ერთი მოთხოვნით
  const boundary = 'custom-map-' + Math.random().toString(36).slice(2);
  const body = new Blob(['--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n', JSON.stringify(metadata),
    '\r\n--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n', JSON.stringify(document), '\r\n--' + boundary + '--']);
  const url = DRIVE_UPLOAD + (id ? '/' + encodeURIComponent(id) : '') + '?uploadType=multipart&fields=id,name,modifiedTime';
  const response = await drive().driveFetch(url, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
  const file = await response.json();
  return { id: file.id, storage: 'drive', name: document.name, codes: metadata.description, count: document.items.length, modified: file.modifiedTime || document.saved };
}

async function driveRead(id) {
  const response = await drive().driveFetch(DRIVE_FILES + '/' + encodeURIComponent(id) + '?alt=media');
  return parseDocument(await response.text());
}

async function driveDelete(id) {
  await drive().driveFetch(DRIVE_FILES + '/' + encodeURIComponent(id), { method: 'DELETE' });
}

// ---------- ბრაუზერი (localStorage) ----------
function localIndex() {
  try { return JSON.parse(localStorage.getItem(LOCAL_INDEX_KEY) || '[]').filter((entry) => entry && entry.id); } catch (error) { return []; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch (error) {
    throw new Error(error && error.name === 'QuotaExceededError' ? 'ბრაუზერის მეხსიერება გაივსო: წაშალე ძველი რუკები ან დაუკავშირდი Drive-ს.' : 'ბრაუზერი შენახვას არ გვაძლევს (პირადი ფანჯარა?).');
  }
}
function localSave(id, document) {
  const entry = { id: id || 'local-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), storage: 'local', name: document.name,
    codes: codesOf(document.items), count: document.items.length, modified: document.saved };
  writeLocal(LOCAL_MAP_KEY(entry.id), JSON.stringify(document));
  const index = localIndex().filter((other) => other.id !== entry.id);
  index.unshift(entry);
  writeLocal(LOCAL_INDEX_KEY, JSON.stringify(index));
  return entry;
}
function localRead(id) {
  let stored = null;
  try { stored = localStorage.getItem(LOCAL_MAP_KEY(id)); } catch (error) { /* არაფერი */ }
  if (!stored) throw new Error('რუკა ამ ბრაუზერში ვეღარ ვიპოვე.');
  return parseDocument(stored);
}
function localDelete(id) {
  try {
    localStorage.removeItem(LOCAL_MAP_KEY(id));
    localStorage.setItem(LOCAL_INDEX_KEY, JSON.stringify(localIndex().filter((entry) => entry.id !== id)));
  } catch (error) { /* არაფერი */ }
}

// ---------- საერთო ფუნქციები ----------
// ყველა რუკა: ბრაუზერისა და (დაკავშირებისას) Drive-ის. driveError: Drive ვერ წავიკითხეთ (სია მაინც ბრუნდება)
export async function listMaps() {
  const maps = localIndex().map((entry) => Object.assign({}, entry, { storage: 'local' }));
  let driveError = null;
  if (drive() && drive().hasDriveToken()) {
    try { maps.push(...await driveList()); } catch (error) { driveError = error; }
  }
  maps.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  return { maps, driveError };
}

export function readMap(entry) {
  return entry.storage === 'drive' ? driveRead(entry.id) : Promise.resolve(localRead(entry.id));
}

// id = null → ახალი რუკა; storage: 'drive' | 'local'
export async function saveMap({ id, storage, name, items }) {
  const document = makeDocument(name, items);
  if (!document.items.length) throw new Error('შესანახი ობიექტი არ არის.');
  return storage === 'drive' ? driveSave(id, document) : localSave(id, document);
}

export function deleteMap(entry) {
  return entry.storage === 'drive' ? driveDelete(entry.id) : Promise.resolve(localDelete(entry.id));
}

// ---------- გაზიარება ბმულით ----------
const toBase64Url = (bytes) => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromBase64Url = (value) => {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};
async function streamBytes(bytes, transform, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(transform).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (limit && size > limit) { reader.cancel(); throw new Error('ბმულის რუკა ძალიან დიდია.'); }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

// რუკა → ბმულის # ნაწილი: „1.“ = gzip; „0.“ = შეკუმშვის გარეშე (ძველი ბრაუზერი)
export async function encodeShare(name, items) {
  const json = new TextEncoder().encode(JSON.stringify(makeDocument(name, items)));
  if (typeof CompressionStream === 'function') return '1.' + toBase64Url(await streamBytes(json, new CompressionStream('gzip')));
  return '0.' + toBase64Url(json);
}

export async function decodeShare(value) {
  const match = /^([01])\.([A-Za-z0-9_-]+)$/.exec(String(value || ''));
  if (!match) throw new Error('ბმული დაზიანებულია (ბოლომდე არ დაკოპირდა?).');
  let bytes = fromBase64Url(match[2]);
  if (match[1] === '1') {
    if (typeof DecompressionStream !== 'function') throw new Error('ეს ბრაუზერი ბმულის გაშლას ვერ ახერხებს: განაახლე ბრაუზერი.');
    bytes = await streamBytes(bytes, new DecompressionStream('gzip'), MAX_SHARE_BYTES);
  }
  if (bytes.length > MAX_SHARE_BYTES) throw new Error('ბმულის რუკა ძალიან დიდია.');
  return parseDocument(new TextDecoder().decode(bytes));
}

// ---------- ფაილად (GeoJSON): დიდი რუკების გასაზიარებლად; რუკაზე ფაილის ჩაგდებით ბრუნდება ---------
export function toGeoJSON(name, items) {
  const features = [];
  for (const item of cleanItems(items)) {
    const properties = { name: item.code, source: item.source, stroke: item.color, fill: item.color, 'fill-opacity': 0.12 };
    if (item.address) properties.address = item.address;
    if (item.areaText) properties.area = item.areaText;
    const geometries = item.geometry.type === 'FeatureCollection' ? item.geometry.features.map((feature) => feature.geometry) : [item.geometry];
    for (const geometry of geometries) features.push({ type: 'Feature', properties, geometry });
  }
  return JSON.stringify({ type: 'FeatureCollection', name: text(name, 120), features });
}
