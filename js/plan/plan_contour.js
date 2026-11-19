// plan_contour.js - საკადასტრო კოდი -> კონტური საკადასტრო გეგმის PDF-იდან.
// აერთებს ორ ნაწილს: napr_docs.js (რეესტრში გეგმის პოვნა) და plan_converter.js (PDF -> კონტური).
// იყენებს: viewer.js (ღილაკები "კონტური → KML" / "კონტური რუკაზე") და contours.js (კონტურების სია).

import { findDocuments } from "./napr_docs.js";
import { convertPlanPdf } from "./plan_converter.js";
import { CONTOUR_SOURCE } from "./contours_core.js";

// ფართობის სხვაობა (გეგმაში დაწერილი vs კონტურიდან გამოთვლილი), რომლის ზემოთაც შედეგი საეჭვოა
const SUSPICIOUS_AREA_DIFFERENCE_PERCENT = 1;

// გეგმის თარიღი მილიწამებში: "მომზადების თარიღი" (თუ გეგმაში წერია), თუ არა - PDF-ის შექმნის დრო
const planDateMsOf = (planGroup) => {
  const date = planGroup.prepared || planGroup.when;
  return date ? date.getTime() : null;
};

// planGroup - ერთი გეგმა napr_docs.js-ის groupDocs-იდან (მისი ასლებით: planGroup.docs[i].bytes).
// planNumber - რიგით რომელი გეგმაა (1 = ყველაზე ახალი).
// ბრუნდება კონტური (აღწერა: contours_core.js-ის თავში). ვერ გარდაქმნისას ისვრის Error-ს.
export async function contourFromPlanGroup(cadastralCode, planGroup, planNumber) {
  // ჯერ ის ასლი, რომელსაც viewer-იც აჩვენებს (ხელმოწერილი), მერე დანარჩენი
  const copies = planGroup.docs.filter((copy) => copy.bytes);
  copies.sort((a, b) => (b.row === planGroup.best) - (a.row === planGroup.best));
  if (!copies.length) throw new Error("გეგმის PDF ვერ ჩამოიტვირთა");

  let converted = null, lastError = null;
  for (const copy of copies) {
    try {
      converted = await convertPlanPdf(copy.bytes);
      break;
    } catch (error) {
      lastError = error; // ეს ასლი ვერ გარდაიქმნა: ვცდით მეორე ასლს
    }
  }
  if (!converted) throw lastError;

  const warnings = [...converted.warnings];
  if (converted.cadastralCode && converted.cadastralCode !== cadastralCode) {
    warnings.push(`გეგმაში სხვა კოდი წერია: ${converted.cadastralCode}.`);
  }
  // plan_converter თავადაც აფრთხილებს დასაშვებზე მეტ სხვაობაზე; აქ მხოლოდ ნიშანს ვინახავთ სიისთვის.
  // დასაშვები = 1%, პატარა ნაკვეთზე კი გეგმის ფართობის დამრგვალების ზღვარი (areaTolerancePercent)
  const allowedAreaDifferencePercent = Math.max(SUSPICIOUS_AREA_DIFFERENCE_PERCENT, converted.areaTolerancePercent ?? 0);
  const areaIsSuspicious = Number.isFinite(converted.areaDifferencePercent)
    && Math.abs(converted.areaDifferencePercent) > allowedAreaDifferencePercent;

  return {
    cadastralCode,
    source: CONTOUR_SOURCE.PLAN,
    polygons: converted.polygons,
    address: "",
    planDateMs: planDateMsOf(planGroup),
    planNumber,
    accuracyMeters: converted.accuracyMeters,
    warnings,
    notes: converted.notes || [], // ინფორმაცია (არა გაფრთხილება), მაგ. "სხვაობა მხოლოდ დამრგვალებაა"
    // დამატებითი ინფორმაცია სიაში საჩვენებლად
    areaInPdf: converted.areaInPdf,
    areaCalculated: converted.areaCalculated,
    areaDifferencePercent: converted.areaDifferencePercent,
    areaIsSuspicious,
    isRaster: converted.isRaster,
    insideGeorgia: converted.insideGeorgia
  };
}

// ერთი კოდის გეგმები რეესტრიდან იტვირთება ერთხელ (ყველა ფაილი), მერე ნებისმიერი ნომერი მყისიერია.
// გასაღები: საკადასტრო კოდი; მნიშვნელობა: findDocuments-ის პასუხი (Promise).
const registryPlansByCode = new Map();

function loadRegistryPlans(cadastralCode) {
  if (!registryPlansByCode.has(cadastralCode)) {
    const loading = findDocuments(cadastralCode, "plan");
    loading.catch(() => registryPlansByCode.delete(cadastralCode)); // შეცდომა არ დავიმახსოვროთ: შემდეგ ჯერზე ხელახლა ვცადოთ
    registryPlansByCode.set(cadastralCode, loading);
  }
  return registryPlansByCode.get(cadastralCode);
}

// კოდის ყველა საკადასტრო გეგმის სია: [{ planNumber, planDateMs }, ...], 1 = ყველაზე ახალი
export async function listPlans(cadastralCode) {
  const registry = await loadRegistryPlans(cadastralCode);
  return registry.numbered.map((planGroup, index) => ({ planNumber: index + 1, planDateMs: planDateMsOf(planGroup) }));
}

// კოდის planNumber-ე საკადასტრო გეგმა (1 = ყველაზე ახალი) -> კონტური.
// ბრუნდება { contour, plans } ან { contour: null, reason, plans }:
//   reason - რატომ ვერ მოხერხდა (ქართულად); plans - ამ კოდის გეგმების სია (listPlans-ის ფორმით).
// რეესტრის წაკითხვის შეცდომისას (მაგ. სერვერი არ პასუხობს) ისვრის Error-ს.
export async function contourFromPlanNumber(cadastralCode, planNumber = 1) {
  const registry = await loadRegistryPlans(cadastralCode);
  const plans = await listPlans(cadastralCode);
  const planGroup = registry.numbered[planNumber - 1];

  if (!planGroup) {
    let reason;
    if (plans.length) reason = `${planNumber}-ე საკადასტრო გეგმა არ არის: რეესტრში სულ ${plans.length} გეგმაა`;
    else if (registry.other.length) reason = `რეესტრში საკადასტრო გეგმა არ არის (არის ${registry.other.length} სხვა ნახაზი)`;
    else reason = "რეესტრში საკადასტრო გეგმა არ არის";
    return { contour: null, reason, plans };
  }
  try {
    return { contour: await contourFromPlanGroup(cadastralCode, planGroup, planNumber), plans };
  } catch (error) {
    return { contour: null, reason: `გეგმა ვიპოვე, მაგრამ კონტურად ვერ გარდავქმენი: ${error.message || error}`, plans };
  }
}
