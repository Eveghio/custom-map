// plan_bridge.mjs - საკადასტრო გეგმიდან კონტური რუკის გვერდისთვის.
//
// ამ საქაღალდის დანარჩენი ფაილები (napr_docs.js, plan_converter.js, plan_contour.js, contours_core.js, lib/)
// Chrome ექსთენშენიდან (Eveghio/Maps-Cadastral-TB.Auction-Lookup, src/) არის გადმოტანილი ᲣᲪᲕᲚᲔᲚᲐᲓ,
// რომ ორივეში ერთნაირად მუშაობდეს. ექსთენშენის ვერსია: კომიტი eb789f1 (2026-11-20; ბირთვი 66c2f24: 447 კოდის ტესტის გასწორებები).
//
// განსხვავება: ვებ-გვერდს რეესტრის საიტზე პირდაპირ მიმართვა არ შეუძლია (CORS), ამიტომ მოთხოვნები
// Apps Script-ის შუამავლით მიდის (Code.gs → fetchAllowed / fetchMany). შუამავალი ნელია, ამიტომ ორ ეტაპად:
//   1. latestPlanContour: სია + მხოლოდ ბოლო განცხადების ფაილები -> ბოლო გეგმა რუკაზე სწრაფად;
//   2. listPlans / planContour: ყველა ფაილი (ფონზე) -> გეგმების სრული სია ნომრებით.
// ორივე ეტაპზე 500 კბ-ზე დიდი ფაილი (SMALL_FILE_BYTES) მხოლოდ მაშინ იწერება, როცა იმავე განცხადების
// მცირე ფაილებში გეგმა არ არის (დიდი, როგორც წესი, გეგმა კი არა, „საკადასტრო რუკად“ მონიშნული ნახაზია).
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
const fileByUrl = new Map();    // GetBlob ბმული -> Promise<{ status, bytes }> (მთლიანი ფაილი)
const smallByUrl = new Map();   // GetBlob ბმული -> Promise<{ status, bytes, size }> (მხოლოდ თუ SMALL_FILE_BYTES-ზე მცირეა)
const bigSize = new Map();      // დიდი ფაილები: ბმული -> ზომა (ბაიტი)
const fileReady = new Set();    // უკვე ჩამოსული ფაილების ბმულები
const FILES_PER_REQUEST = 4;    // ერთ შუამავლის მოთხოვნაში (სერვერი მათ პარალელურად იწერს)
const FETCH_MANY_TIMEOUT_MS = 25000;
// საკადასტრო გეგმა, როგორც წესი, 500 კბ-ზე მცირეა; „საკადასტრო რუკად“ მონიშნული დიდი ნახაზები (10 მბ-მდე)
// Google-ის გავლით წუთობით მოდის. ამიტომ ჯერ მხოლოდ მცირე ფაილებს ვიწერთ; დიდს - მხოლოდ მაშინ, როცა
// იმავე განცხადების (რეგისტრაციის ნომრის) მცირე ფაილებში გეგმა არ აღმოჩნდა.
export const SMALL_FILE_BYTES = 500 * 1024;
const BIG_WAIT_MS = 30000;      // დიდ ფაილს ამდენ ხანს ველოდებით, მერე შემდეგზე გადავდივართ (ჩამოწერა ფონზე გრძელდება)

const toFile = (file) => ({ status: file.status, size: file.size || 0, bytes: file.base64 ? base64ToBytes(file.base64) : new Uint8Array() });

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

function rememberFull(url, loading) {
  loading.then((file) => { if (file.status === 200) fileReady.add(url); }, () => fileByUrl.delete(url));
  fileByUrl.set(url, loading);
}

// რამდენიმე ფაილი მთლიანად: ჯგუფებად (თითო ჯგუფი = ერთი მოთხოვნა), ჯგუფები ერთდროულად.
// perRequest = 1: თითო ფაილი ცალკე (ერთი დიდი ფაილი სხვებს არ აყოვნებს)
function loadFiles(urls, perRequest = FILES_PER_REQUEST) {
  const missing = urls.filter((url) => !fileByUrl.has(url));
  const fetchMany = perRequest > 1 ? serverFunction("fetchMany") : null;
  for (let start = 0; start < missing.length; start += perRequest) {
    const chunk = missing.slice(start, start + perRequest);
    // ახალი Code.gs: ერთი მოთხოვნა ჯგუფზე; ძველი: თითო ფაილი ცალკე
    // თუ ჯგუფური მოთხოვნა FETCH_MANY_TIMEOUT_MS-ში არ დაბრუნდა, ფაილებს ცალ-ცალკე ვითხოვთ
    const loading = fetchMany ? Promise.race([Promise.resolve(fetchMany(chunk)).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), FETCH_MANY_TIMEOUT_MS))]) : Promise.resolve(null);
    chunk.forEach((url, index) => rememberFull(url,
      loading.then((files) => files && files[index] ? files[index] : serverFunction("fetchRemote")(url)).then(toFile)));
  }
  return Promise.all(urls.map((url) => fileByUrl.get(url)));
}

// მცირე ფაილები (SMALL_FILE_BYTES-მდე): დიდზე სერვერი შიგთავსს არ აბრუნებს, მხოლოდ ზომას (status 413).
// ძველ Code.gs-ს ზღვარი არ ესმის და ფაილს მთლიანად აბრუნებს - ესეც მუშაობს.
function loadSmallFiles(urls, perRequest = FILES_PER_REQUEST) {
  const missing = urls.filter((url) => !smallByUrl.has(url) && !fileByUrl.has(url));
  const fetchMany = perRequest > 1 ? serverFunction("fetchMany") : null;
  for (let start = 0; start < missing.length; start += perRequest) {
    const chunk = missing.slice(start, start + perRequest);
    const loading = fetchMany ? Promise.race([Promise.resolve(fetchMany(chunk, SMALL_FILE_BYTES)).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), FETCH_MANY_TIMEOUT_MS))]) : Promise.resolve(null);
    chunk.forEach((url, index) => {
      const one = loading.then((files) => files && files[index] ? files[index] : serverFunction("fetchRemote")(url, SMALL_FILE_BYTES)).then(toFile);
      one.then((file) => {
        if (file.status === 413) bigSize.set(url, file.size);
        else if (!fileByUrl.has(url)) rememberFull(url, Promise.resolve(file)); // მთლიანი ფაილი უკვე მოვიდა
      }, () => smallByUrl.delete(url));
      smallByUrl.set(url, one);
    });
  }
  return Promise.all(urls.map((url) => fileByUrl.get(url) || smallByUrl.get(url)));
}

// fetch-ის მსგავსი ფუნქცია findDocuments-ისთვის: სიის ნაცვლად listHtml, PDF-ები მეხსიერებიდან.
// bigAllowed: დიდი ფაილების ბმულები, რომლებიც მთლიანად უნდა ჩამოიწეროს (დანარჩენ დიდზე პასუხი 413 = გამოტოვება).
// waitMs: თუ ფაილი ამ დროში არ ჩამოვიდა, ამ ჯერზე „504“ (findDocuments მას გამოტოვებს), ჩამოწერა კი ფონზე გრძელდება.
function memoryFetch(listHtml, { waitMs = 0, bigAllowed = new Set(), perRequest = FILES_PER_REQUEST } = {}) {
  return async (url) => {
    if (url.startsWith(ABSTRACT_PAGE)) return new Response(listHtml, { status: 200 });
    if (isBig(url) && !bigAllowed.has(url)) return new Response(null, { status: 413 }); // დიდი: ამჯერად გამოვტოვებთ
    let loading;
    if (fileByUrl.has(url)) loading = fileByUrl.get(url);
    else if (bigAllowed.has(url)) loading = loadFiles([url], perRequest).then((files) => files[0]);
    else loading = loadSmallFiles([url], perRequest).then((files) => files[0]);
    const wait = bigAllowed.has(url) && !fileReady.has(url) ? Math.max(waitMs, BIG_WAIT_MS) : waitMs;
    const file = wait ? await Promise.race([loading, new Promise((resolve) => setTimeout(() => resolve({ status: 504 }), wait))]) : await loading;
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
const toTime = (text) => { const m = String(text).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : 0; };
// სტრიქონები განცხადებებად (რეგისტრაციის ნომრით), ახლიდან ძველისკენ; ნომრის გარეშე სტრიქონი = ცალკე ჯგუფი
function applicationsOf(rows) {
  const sorted = [...rows].sort((a, b) => toTime(b.listDateText) - toTime(a.listDateText) || a.row - b.row);
  const groups = new Map();
  for (const row of sorted) {
    const key = row.regNo || "row" + row.row;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}
const isBig = (url) => bigSize.has(url) && !fileReady.has(url);

// ---------- ეტაპი 1: ბოლო გეგმა სწრაფად ----------
// ზოგი „საკადასტრო რუკა“ დიდი ნახაზია და Google-ის გავლით წუთობით მოდის: მას ამ ეტაპზე არ ველოდებით.
const LATEST_WAIT_MS = 12000;
// განცხადებები ახლიდან ძველისკენ: ჯერ განცხადების მცირე ფაილები; თუ მათში გეგმა არ არის, იმავე განცხადების
// დიდი ფაილები (BIG_WAIT_MS-მდე); მერე შემდეგი განცხადება. ბრუნდება კონტური + planDateMs + regNo, ან null.
export async function latestPlanContour(code) {
  const listHtml = await loadList(code);
  const applications = applicationsOf(planRowsOf(listHtml));
  // ყველა მცირე ფაილის ჩამოწერა იწყება ერთდროულად (ახლიდან ძველისკენ, თითო ცალკე მოთხოვნით),
  // რომ განცხადებების რიგ-რიგობით შემოწმებისას ლოდინი არ დაჯამდეს
  loadSmallFiles(applications.flat().map((row) => row.url), 1);
  const keep = new Set();
  const search = (bigAllowed) => findDocuments(code, "plan", { parallel: 8,
    fetchImpl: memoryFetch(listWithOnly(listHtml, keep), { waitMs: LATEST_WAIT_MS, bigAllowed, perRequest: 1 }) });
  const found = async (registry) => {
    if (!registry.numbered.length) return null;
    const group = registry.numbered[0];
    return { ...await contourFromPlanGroup(code, group, 1), regNo: group.regNo || "" };
  };
  for (const rows of applications) {
    // წინა განცხადებების ფაილები, რომლებიც დროზე ვერ ჩამოვიდა, აღარ ველოდებით (ფონზე ჩამოვა)
    for (const url of [...keep]) if (!fileReady.has(url)) keep.delete(url);
    rows.forEach((row) => keep.add(row.url));
    let result = await found(await search(new Set()));
    if (result) return result;
    // ამ განცხადების მცირე ფაილებში გეგმა არ არის: იმავე განცხადების დიდი ფაილები
    const big = new Set(rows.map((row) => row.url).filter(isBig));
    if (big.size) {
      result = await found(await search(big));
      if (result) return result;
    }
  }
  return null;
}

// ---------- ეტაპი 2: ყველა გეგმა ----------
// ჯერ ყველა მცირე ფაილი; დიდი ფაილი მხოლოდ იმ განცხადებისა, რომლის მცირე ფაილებშიც გეგმა არ აღმოჩნდა.
const registryByCode = new Map();
function loadRegistry(code) {
  if (!registryByCode.has(code)) {
    const loading = loadList(code).then(async (listHtml) => {
      const applications = applicationsOf(planRowsOf(listHtml));
      // ყველა ერთდროულად (ჯგუფებად); ახლები პირველ ჯგუფებში, რომ ბოლო გეგმა (ეტაპი 1) არ დააყოვნოს
      await loadSmallFiles(applications.flat().map((row) => row.url));
      const small = await findDocuments(code, "plan", { parallel: 8, fetchImpl: memoryFetch(listHtml) });
      const withPlan = new Set(small.numbered.map((group) => group.regNo).filter(Boolean));
      const big = new Set(applications.filter((rows) => !withPlan.has(rows[0].regNo)).flat().map((row) => row.url).filter(isBig));
      if (!big.size) return small;
      return findDocuments(code, "plan", { parallel: 8, fetchImpl: memoryFetch(listHtml, { bigAllowed: big }) });
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
