// plan_bridge.mjs - საკადასტრო გეგმიდან კონტური რუკის გვერდისთვის.
//
// ამ საქაღალდის დანარჩენი ფაილები (napr_docs.js, plan_converter.js, plan_contour.js, contours_core.js, lib/)
// Chrome ექსთენშენიდან (Eveghio/Maps-Cadastral-TB.Auction-Lookup, src/) არის გადმოტანილი ᲣᲪᲕᲚᲔᲚᲐᲓ,
// რომ ორივეში ერთნაირად მუშაობდეს. ექსთენშენის ვერსია: კომიტი 2485d40 (2026-11-17).
//
// განსხვავება მხოლოდ ერთია: ვებ-გვერდს რეესტრის საიტზე პირდაპირ მიმართვა არ შეუძლია (CORS),
// ამიტომ ყველა მოთხოვნა მიდის Apps Script-ის შუამავლით (SERVER.fetchRemote, Code.gs → fetchAllowed).
// ამ ფაილის proxyFetch ჩვეულებრივი fetch-ის მსგავს პასუხს აბრუნებს, napr_docs.js კი მას fetchImpl-ად იღებს.

import { findDocuments } from "./napr_docs.js";
import { contourFromPlanGroup } from "./plan_contour.js";

// base64 ტექსტი -> ბაიტები
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// შუამავლის ფუნქცია: ტესტში LOCAL_SERVER, საიტზე SERVER (js/backend.js)
function remoteFetcher() {
  const local = window.LOCAL_SERVER && window.LOCAL_SERVER.fetchRemote;
  return local || window.SERVER.fetchRemote;
}

// fetch-ის მსგავსი ფუნქცია შუამავლით. options.signal-ს (ლოდინის ლიმიტი) პატივს სცემს.
async function proxyFetch(url, options = {}) {
  const request = Promise.resolve(remoteFetcher()(url)).then((body) => {
    const status = body.status >= 200 && body.status <= 599 ? body.status : 502;
    const content = body.text !== undefined ? body.text : base64ToBytes(body.base64 || "");
    return new Response(status === 204 || status === 304 ? null : content, { status, headers: { "Content-Type": body.type || "" } });
  });
  if (!options.signal) return request;
  return Promise.race([request, new Promise((resolve, reject) => {
    if (options.signal.aborted) reject(options.signal.reason);
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  })]);
}

// ერთი კოდის გეგმები იტვირთება ერთხელ (ყველა PDF), მერე ნებისმიერი ნომერი მყისიერია.
const registryByCode = new Map();
function loadRegistry(code) {
  if (!registryByCode.has(code)) {
    // parallel 3: Apps Script-ს ერთდროულად ბევრი მოთხოვნა არ უყვარს
    const loading = findDocuments(code, "plan", { parallel: 3, fetchImpl: proxyFetch });
    loading.catch(() => registryByCode.delete(code)); // შეცდომა არ დავიმახსოვროთ
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
  return contourFromPlanGroup(code, group, planNumber);
}
