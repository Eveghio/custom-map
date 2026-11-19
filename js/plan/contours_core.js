// contours_core.js - ნაკვეთის კონტურების საერთო ლოგიკა (ბრაუზერის გვერდზე დამოუკიდებელი, ტესტირებადი).
//
// "კონტური" (contour) ამ ფაილში არის ერთი საკადასტრო კოდის შედეგი:
//   {
//     cadastralCode   "01.10.14.028.016"
//     source          CONTOUR_SOURCE-ის ერთ-ერთი მნიშვნელობა: საიდან მოვიდა კონტური
//     polygons        [[გარე რგოლი, ...ხვრელები], ...]; რგოლი = [[გრძედი, განედი], ...], დახურული
//     address         მისამართი (მხოლოდ maps.gov.ge იძლევა), ან ""
//     planDateMs      გეგმის თარიღი მილიწამებში (Date.getTime()), მხოლოდ source === PLAN; სხვაგან null.
//                     რიცხვია და არა Date, რადგან სია chrome.storage-ში ინახება, იქ კი Date არ შეინახება
//     accuracyMeters  { typical, max } (მხოლოდ PLAN), ან null
//     warnings        [ტექსტი, ...] - რაც მომხმარებელმა უნდა იცოდეს ამ კონტურზე
//   }

// საიდან მოვიდა კონტური
export const CONTOUR_SOURCE = {
  MAPS: "maps.gov.ge",
  MS: "ms.gov.ge",
  PLAN: "plan", // საკადასტრო გეგმის PDF-იდან გამოთვლილი (მიახლოებითი)
  APPLICATION: "application" // ms.gov.ge-ს განცხადებაზე დატანილი კონტური (საკადასტრო კოდის გარეშე)
};

// ფერები რუკაზე: რუკიდან მოსული (ზუსტი) ლურჯია, გეგმიდან გამოთვლილი (მიახლოებითი) ნარინჯისფერი
const COLOR_FROM_MAP = "#1d6fb8";
const COLOR_FROM_PLAN = "#e65100";
const COLOR_FROM_APPLICATION = "#2e7d32"; // განცხადების კონტური: მწვანე

const GEOJSON_IO_ADDRESS = "https://geojson.io/";
// geojson.io მონაცემს ბმულშივე იღებს; ძალიან გრძელ ბმულს ბრაუზერი ვერ გახსნის
const GEOJSON_IO_MAX_LINK_LENGTH = 1500000;
// 7 ათწილადი ≈ 1 სმ: საკმარისია და ბმულს ამოკლებს
const COORDINATE_DECIMALS = 7;

const twoDigits = (number) => String(number).padStart(2, "0");

// მილიწამები -> "05.08.2014"
// ფართობი კვ.მ-ში: პატარა ნაკვეთზე 2 ათწილადი (6.49 და არა 6.5 - თორემ დამრგვალების საზღვარს გადაცდენილი ჩანს)
export function formatSquareMeters(squareMeters) {
  return squareMeters < 100 ? squareMeters.toFixed(2) : squareMeters.toFixed(1);
}

// მანძილი მეტრებში: 1 მ-ზე ნაკლები - 2 ათწილადი (±0.05 და ±0.12 ორივე "±0.1"-ად არ უნდა ჩანდეს)
export function formatMeters(meters) {
  return meters < 1 ? meters.toFixed(2) : meters.toFixed(1);
}

export function formatDate(dateMs) {
  if (!dateMs) return "";
  const date = new Date(dateMs);
  return `${twoDigits(date.getDate())}.${twoDigits(date.getMonth() + 1)}.${date.getFullYear()}`;
}

// მოკლე წარწერა: საიდან არის კონტური. მაგ. "maps.gov.ge" ან "საკადასტრო გეგმა 05.08.2014"
export function describeSource(contour) {
  if (contour.source === CONTOUR_SOURCE.APPLICATION) return "განცხადება (ms.gov.ge)";
  if (contour.source !== CONTOUR_SOURCE.PLAN) return contour.source;
  return contour.planDateMs ? `საკადასტრო გეგმა ${formatDate(contour.planDateMs)}` : "საკადასტრო გეგმა";
}

// ---------- რგოლის მიმართულება ----------

// რგოლის ფართობი ნიშნით: დადებითი = საათის ისრის საწინააღმდეგო მიმართულება
function signedRingArea(ring) {
  let doubledArea = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
    doubledArea += x1 * y2 - x2 * y1;
  }
  return doubledArea / 2;
}

// GeoJSON-ის წესი: გარე რგოლი საათის ისრის საწინააღმდეგოდ, ხვრელები - ისრის მიმართულებით.
// კოორდინატებს ამრგვალებს და რგოლს ხურავს (პირველი წერტილი = ბოლო წერტილი).
function toGeoJsonRings(polygon) {
  return polygon.map((ring, ringIndex) => {
    const rounded = ring.map(([longitude, latitude]) => [
      +longitude.toFixed(COORDINATE_DECIMALS),
      +latitude.toFixed(COORDINATE_DECIMALS)
    ]);
    const first = rounded[0], last = rounded[rounded.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) rounded.push([first[0], first[1]]);

    const isOuterRing = ringIndex === 0;
    const isCounterClockwise = signedRingArea(rounded) > 0;
    return isOuterRing === isCounterClockwise ? rounded : rounded.reverse();
  });
}

// ---------- GeoJSON ----------

// ერთი კონტური -> GeoJSON Feature. თვისებები (properties) geojson.io-ზე ნაკვეთზე დაკლიკებისას ჩანს.
export function buildGeoJsonFeature(contour) {
  const rings = contour.polygons.map(toGeoJsonRings);
  const geometry = rings.length === 1
    ? { type: "Polygon", coordinates: rings[0] }
    : { type: "MultiPolygon", coordinates: rings };

  const isFromPlan = contour.source === CONTOUR_SOURCE.PLAN;
  const isFromApplication = contour.source === CONTOUR_SOURCE.APPLICATION;
  const color = isFromPlan ? COLOR_FROM_PLAN : isFromApplication ? COLOR_FROM_APPLICATION : COLOR_FROM_MAP;
  const properties = {
    "კოდი": contour.cadastralCode,
    "წყარო": describeSource(contour)
  };
  if (contour.address) properties["მისამართი"] = contour.address;
  if (isFromApplication) {
    properties["განცხადება"] = contour.applicationNumber || "";
    if (contour.applicationTopic) properties["თემა"] = contour.applicationTopic;
  }
  if (isFromPlan) {
    properties["სიზუსტე"] = contour.accuracyMeters
      ? `მიახლოებითი: ჩვეულებრივ ±${contour.accuracyMeters.typical.toFixed(1)} მ, მაქს. ±${contour.accuracyMeters.max.toFixed(1)} მ`
      : "მიახლოებითი (გეგმის PDF-იდან გამოთვლილი)";
  }
  if (contour.warnings && contour.warnings.length) properties["შენიშვნა"] = contour.warnings.join(" ");
  // simplestyle: ამ თვისებებით geojson.io კონტურს ფერს აძლევს
  properties.stroke = color;
  properties["stroke-width"] = 2;
  properties.fill = color;
  properties["fill-opacity"] = 0.25;

  return { type: "Feature", properties, geometry };
}

export function buildGeoJson(contours) {
  return { type: "FeatureCollection", features: contours.map(buildGeoJsonFeature) };
}

// ტექსტი -> gzip-ით შეკუმშული და "base64url"-ად ჩაწერილი (ასოები, ციფრები, "-" და "_": ბმულში უსაფრთხოა)
async function gzipToBase64Url(text) {
  const compressedStream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressedBytes = new Uint8Array(await new Response(compressedStream).arrayBuffer());
  let binaryText = "";
  for (const byte of compressedBytes) binaryText += String.fromCharCode(byte);
  return btoa(binaryText).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// geojson.io-ს ბმული, რომელიც კონტურებს პირდაპირ რუკაზე ხსნის.
// ფორმატი "#data=gz:<შეკუმშული GeoJSON>" იგივეა, რასაც geojson.io-ს საკუთარი "Share" ღილაკი ქმნის
// (შემოწმდა ცოცხლად 2026-11-14). ძველი ფორმატი "#data=data:application/json,..." აღარ გამოდგება:
// ფერის "#" ნიშანზე მონაცემი წყდება.
// ბრუნდება null, თუ მონაცემი ბმულისთვის ზედმეტად დიდია (მაშინ GeoJSON ფაილად უნდა ჩამოიტვირთოს).
// withOrtho = true: ბმულში ?napr_ortho=1 (content_geojson.js geojson.io-ზე ms.gov.ge-ს ორთოფოტოს ფენას ამატებს)
export async function buildGeoJsonIoLink(contours, withOrtho = false) {
  const link = GEOJSON_IO_ADDRESS + (withOrtho ? "?napr_ortho=1" : "") + "#data=gz:" + await gzipToBase64Url(JSON.stringify(buildGeoJson(contours)));
  return link.length <= GEOJSON_IO_MAX_LINK_LENGTH ? link : null;
}

// ---------- KML ----------

function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const ringToKmlCoordinates = (ring) => ring.map(([longitude, latitude]) => `${longitude},${latitude},0`).join(" ");

function polygonToKml(polygon) {
  const [outerRing, ...holes] = polygon;
  const holesXml = holes.map((hole) =>
    `\n        <innerBoundaryIs><LinearRing><coordinates>${ringToKmlCoordinates(hole)}</coordinates></LinearRing></innerBoundaryIs>`).join("");
  return `      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${ringToKmlCoordinates(outerRing)}</coordinates></LinearRing></outerBoundaryIs>${holesXml}
      </Polygon>`;
}

// KML-ის ფერი "aabbggrr" ფორმატშია (გამჭვირვალობა, ლურჯი, მწვანე, წითელი)
function kmlColor(htmlColor, opacityHex) {
  const red = htmlColor.slice(1, 3), green = htmlColor.slice(3, 5), blue = htmlColor.slice(5, 7);
  return opacityHex + blue + green + red;
}

// ერთი კონტური -> ერთი .kml ფაილის ტექსტი (იგივე აგებულება, რაც maps.gov.ge / ms.gov.ge-ს KML-ს აქვს ექსთენშენში)
export function buildKml(contour) {
  const polygonsXml = contour.polygons.map((polygon) => polygonToKml(toGeoJsonRings(polygon)));
  const geometryXml = polygonsXml.length === 1
    ? polygonsXml[0]
    : `      <MultiGeometry>\n${polygonsXml.join("\n")}\n      </MultiGeometry>`;

  const isFromPlan = contour.source === CONTOUR_SOURCE.PLAN;
  const color = isFromPlan ? COLOR_FROM_PLAN : "#ff0000"; // რუკიდან მოსული - წითელი, როგორც არსებულ KML-ებში
  const descriptionLines = [
    contour.address,
    `წყარო: ${describeSource(contour)}`,
    isFromPlan ? "კონტური გეგმის PDF-იდან არის გამოთვლილი (მიახლოებითი)." : "",
    ...(contour.warnings || [])
  ].filter(Boolean);

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(contour.cadastralCode)}</name>
    <Style id="parcel">
      <LineStyle><color>${kmlColor(color, "ff")}</color><width>2</width></LineStyle>
      <PolyStyle><color>${kmlColor(color, "40")}</color></PolyStyle>
    </Style>
    <Placemark>
      <name>${escapeXml(contour.cadastralCode)}</name>
      <description>${escapeXml(descriptionLines.join("\n"))}</description>
      <styleUrl>#parcel</styleUrl>
${geometryXml}
    </Placemark>
  </Document>
</kml>
`;
}

// ფაილის სახელი კოდიდან. გეგმიდან გამოთვლილს თარიღი ემატება, რომ რუკიდან ჩამოტვირთულ ფაილს არ გადაეწეროს
// და ჩანდეს, რომელი დროის საზღვარია: "01.10.14.028.016_gegma_2014-08-05.kml"
export function kmlFileName(contour) {
  const safeCode = contour.cadastralCode.replace(/[\\/:*?"<>|]/g, "_");
  if (contour.source !== CONTOUR_SOURCE.PLAN) return `${safeCode}.kml`;
  const date = contour.planDateMs ? new Date(contour.planDateMs) : null;
  const dateText = date ? `_${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}` : "";
  return `${safeCode}_gegma${dateText}.kml`;
}
