// plan_bridge.mjs - საკადასტრო გეგმიდან კონტური რუკის გვერდისთვის.
//
// ამ საქაღალდის დანარჩენი ფაილები (napr_docs.js, plan_converter.js, plan_contour.js, contours_core.js, lib/)
// Chrome ექსთენშენიდან (Eveghio/Maps-Cadastral-TB.Auction-Lookup, src/) არის გადმოტანილი ᲣᲪᲕᲚᲔᲚᲐᲓ,
// რომ ორივეში ერთნაირად მუშაობდეს. ექსთენშენის ვერსია: კომიტი 2485d40 (2026-11-17).
//
// განსხვავება: ვებ-გვერდს რეესტრის საიტზე პირდაპირ მიმართვა არ შეუძლია (CORS), ამიტომ მოთხოვნები
// Apps Script-ის შუამავლით მიდის (Code.gs → fetchAllowed / fetchMany). შუამავალი ნელია, ამიტომ ორ ეტაპად:
//   1. latestPlanContour: სია + მხოლოდ ბოლო განცხადების ფაილები -> ბოლო გეგმა რუკაზე სწრაფად;
//   2. listPlans / planContour: ყველა ფაილი (ფონზე) -> გეგმების სრული სია ნომრებით.
// napr_docs.js-ის findDocuments-ს ვაძლევთ fetch-ის მსგავს ფუნქციას, რომელიც პასუხობს მეხსიერებიდან
// (და პირველ ეტაპზე სიის მხოლოდ საჭირო სტრიქონებს აჩვენებს).

import { findDocuments, parseAbstractPage, ABSTRACT_PAGE, TYPE_MAP } from "./napr_docs.js";
import { contourFromPlanGroup } from "./plan_contour.js";

// base64 ტექსტი -> ბაიტები
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// შუამავლის ფუნქციები: ტესტში LOCAL_SERVER, საიტზე SERVER (js/backend.js)
const serverFunction = (name) => (window.LOCAL_SERVER && window.LOCAL_SERVER[name]) || (window.SERVER && window.SERVER[name]);

// ---------- ფაილების ჩამოტვირთვა (კოდისგან დამოუკიდებელი მეხსიერება) ----------
const listByCode = new Map();   // კოდი -> Promise<სიის HTML>
const fileByUrl = new Map();    // GetBlob ბმული -> Promise<{ status, bytes }>
const FILES_PER_REQUEST = 4;    // ერთ შუამავლის მოთხოვნაში (სერვერი მათ პარალელურად იწერს)
const FETCH_MANY_TIMEOUT_MS = 25000;

function loadList(code) {
  if (!listByCode.has(code)) {
    const loading = Promise.resolve(serverFunction("fetchRemote")(ABSTRACT_PAGE + encodeURIComponent(code))).then((body) => {
      if (body.status !== 200 || typeof body.text !== "string") throw new Error("რეესტრის სია: HTTP " + body.status);
      return body.text;
    });
    loading.catch(() => listByCode.delete(code));
    listByCode.set(code, loading);
  }
  return listByCode.get(code);
}

// რამდენიმე ფაილი: ჯგუფებად (თითო ჯგუფი = ერთი მოთხოვნა), ჯგუფები ერთდროულად
function loadFiles(urls) {
  const missing = urls.filter((url) => !fileByUrl.has(url));
  const fetchMany = serverFunction("fetchMany");
  for (let start = 0; start < missing.length; start += FILES_PER_REQUEST) {
    const chunk = missing.slice(start, start + FILES_PER_REQUEST);
    // ახალი Code.gs: ერთი მოთხოვნა ჯგუფზე; ძველი: თითო ფაილი ცალკე
    // თუ ჯგუფური მოთხოვნა FETCH_MANY_TIMEOUT_MS-ში არ დაბრუნდა, ფაილებს ცალ-ცალკე ვითხოვთ
    const loading = fetchMany ? Promise.race([Promise.resolve(fetchMany(chunk)).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), FETCH_MANY_TIMEOUT_MS))]) : Promise.resolve(null);
    chunk.forEach((url, index) => {
      const one = loading.then((files) => files && files[index] ? files[index] : serverFunction("fetchRemote")(url))
        .then((file) => ({ status: file.status, bytes: file.base64 ? base64ToBytes(file.base64) : new Uint8Array() }));
      one.catch(() => fileByUrl.delete(url));
      fileByUrl.set(url, one);
    });
  }
  return Promise.all(urls.map((url) => fileByUrl.get(url)));
}

// fetch-ის მსგავსი ფუნქცია findDocuments-ისთვის: სიის ნაცვლად listHtml, PDF-ები მეხსიერებიდან
function memoryFetch(listHtml) {
  return async (url) => {
    if (url.startsWith(ABSTRACT_PAGE)) return new Response(listHtml, { status: 200 });
    const file = await loadFiles([url]).then((files) => files[0]);
    const status = file.status >= 200 && file.status <= 599 ? file.status : 502;
    return new Response(status === 200 ? file.bytes : null, { status });
  };
}

// სიის HTML მხოლოდ მითითებული ბმულების სტრიქონებით (სხვა სტრიქონები findDocuments-მა არ უნდა ნახოს)
function listWithOnly(listHtml, keepUrls) {
  return listHtml.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi, (row) => {
    const rows = parseAbstractPage("<table>" + row + "</table>");
    return rows.length && !keepUrls.has(rows[0].url) ? "" : row;
  });
}

const planRowsOf = (listHtml) => parseAbstractPage(listHtml).filter((row) => row.type === TYPE_MAP);

// ---------- ეტაპი 1: ბოლო გეგმა სწრაფად ----------
// სია განცხადების თარიღითაა. ვიღებთ უახლესი თარიღის სტრიქონებს; თუ იქ გეგმა არ არის (მხოლოდ ნახაზი),
// მომდევნო თარიღს და ა.შ. ბრუნდება კონტური + planDateMs + regNo, ან null (გეგმა საერთოდ არ არის).
export async function latestPlanContour(code) {
  const listHtml = await loadList(code);
  const rows = planRowsOf(listHtml);
  const dates = [...new Set(rows.map((row) => row.listDateText))]
    .sort((a, b) => toTime(b) - toTime(a));
  const keep = new Set();
  for (const date of dates) {
    rows.filter((row) => row.listDateText === date).forEach((row) => keep.add(row.url));
    const registry = await findDocuments(code, "plan", { parallel: 8, fetchImpl: memoryFetch(listWithOnly(listHtml, keep)) });
    if (registry.numbered.length) {
      const group = registry.numbered[0];
      const contour = await contourFromPlanGroup(code, group, 1);
      return { ...contour, regNo: group.regNo || "" };
    }
  }
  return null;
}
const toTime = (text) => { const m = String(text).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : 0; };

// ---------- ეტაპი 2: ყველა გეგმა ----------
const registryByCode = new Map();
function loadRegistry(code) {
  if (!registryByCode.has(code)) {
    const loading = loadList(code).then(async (listHtml) => {
      await loadFiles(planRowsOf(listHtml).map((row) => row.url)); // ყველა ერთდროულად (ჯგუფებად)
      return findDocuments(code, "plan", { parallel: 8, fetchImpl: memoryFetch(listHtml) });
    });
    loading.catch(() => registryByCode.delete(code));
    registryByCode.set(code, loading);
  }
  return registryByCode.get(code);
}

// კოდის საკადასტრო გეგმები: { plans: [{ planNumber, planDateMs, regNo }], otherCount }; 1 = ყველაზე ახალი
export async function listPlans(code) {
  const registry = await loadRegistry(code);
  const plans = registry.numbered.map((group, index) => {
    const date = group.prepared || group.when;
    return { planNumber: index + 1, planDateMs: date ? date.getTime() : null, regNo: group.regNo || "" };
  });
  return { plans, otherCount: registry.other.length };
}

// კოდის planNumber-ე გეგმა -> კონტური (plan_contour.js-ის ფორმით; polygons = [[გარე, ...ხვრელები], ...])
export async function planContour(code, planNumber) {
  const registry = await loadRegistry(code);
  const group = registry.numbered[planNumber - 1];
  if (!group) throw new Error(registry.numbered.length
    ? `${planNumber}-ე გეგმა არ არის (სულ ${registry.numbered.length})`
    : "რეესტრში საკადასტრო გეგმა არ არის" + (registry.other.length ? ` (არის ${registry.other.length} სხვა ნახაზი)` : ""));
  return { ...await contourFromPlanGroup(code, group, planNumber), regNo: group.regNo || "" };
}
