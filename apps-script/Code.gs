/**
 * ხელშეკრულებების რუკა: Apps Script ვებ-აპის სერვერის ნაწილი.
 *
 * ეს სკრიპტი Google Sheet-ზეა მიბმული (Extensions → Apps Script) და:
 *   - doGet()        აბრუნებს რუკის გვერდს (Index.html);
 *   - getMapData()   კითხულობს ყველა საჭირო შიტს და გვერდს უბრუნებს ობიექტებად;
 *   - saveGeometry() ინახავს რუკაზე მოხაზულ კონტურს შიტში „გეომეტრიები“;
 *   - saveView()     ინახავს ფილტრების კომბინაციას (View) შიტში „View-ები“.
 *
 * წვდომა: ორი Deploy ერთი და იმავე კოდით.
 *   1) მთავარი: „User accessing the web app“ + „Anyone with Google account“. ყოველი მომხმარებელი
 *      Sheet-ს საკუთარი უფლებებით კითხულობს; ვისაც Sheet არ აქვს გაზიარებული, ვერაფერს ნახავს.
 *      ჩაწერა (კონტური, View, საჯარო გაზიარება) მხოლოდ Sheet-ის რედაქტორებს შეუძლიათ.
 *   2) საჯარო: „Me“ + „Anyone“. ის მხოლოდ გამოქვეყნებული View-ის ასლს აჩვენებს (?view=<კოდი>),
 *      ისიც თუ გაზიარება მოქმედია და ვადა არ გასულა. ყველა სხვა ფუნქცია ამ რეჟიმში
 *      უარს ამბობს (requireSignedInUser), ასე რომ საჯარო ბმულიდან სრული მონაცემი არ გაიცემა.
 */

// საჯარო Deploy-ის ბმული (…/exec). მეორე Deploy-ის შემდეგ აქ ჩასვი; ცარიელია = საჯარო გაზიარება გამორთულია
const PUBLIC_APP_URL = 'https://script.google.com/macros/s/AKfycbw_mcKDmLXGHjQKvGZ4fSedMM8ZGfokFbhaBrySrtmm8Dp6WATPZ8OtFrjk7jNBwEqIvw/exec';
const PUBLIC_SHEET = 'საჯარო ხედები';
const PUBLIC_CHUNK = 45000; // უჯრის ლიმიტი 50 000 სიმბოლოა, ამიტომ დიდი ასლი რამდენიმე უჯრაში იყოფა

// Sheet-ის ID (ბმულიდან: docs.google.com/spreadsheets/d/<ID>/edit)
const SPREADSHEET_ID = '1RhoMaLorr2zimIcl6Szy_HrAakcjQyMiVxSGDdc4zGo';

// შიტების სახელები და სვეტების სათაური → პროგრამული სახელი.
// სვეტები სათაურით იძებნება, ასე რომ შიტში მათი გადაადგილება არაფერს აფუჭებს.
const TABLES = {
  contracts: {
    sheet: 'ხელშეკრულებები',
    columns: { 'ID': 'id', 'ტიპი': 'type', 'მხარე': 'party', 'ნომერი': 'number',
      'გაფორმების თარიღი': 'signed', 'ძალაში შესვლა*': 'start', 'ვადის ბოლო': 'end', 'შენიშვნა': 'note' },
  },
  statusChanges: {
    sheet: 'სტატუსის ცვლილებები',
    columns: { 'ხელშეკრულება': 'contract', 'თარიღი': 'date', 'სტატუსი': 'status', 'საფუძველი': 'basis' },
  },
  history: {
    sheet: 'ქონებების ისტორია',
    columns: { 'ხელშეკრულება': 'contract', 'კოდი': 'code', 'ნაწილი': 'part', 'თარიღიდან*': 'from',
      'თარიღამდე*': 'to', 'საფუძველი': 'basis', 'გეგმის №*': 'plan' },
  },
  restrictions: {
    sheet: 'შეზღუდვები',
    columns: { 'კოდი': 'code', 'ნაწილი': 'part', 'ხელშეკრულება': 'contract', 'პირობა': 'condition',
      'თარიღიდან*': 'from', 'დაწესების საფუძველი': 'basis', 'თარიღამდე': 'to',
      'დასრულების საფუძველი': 'endBasis', 'როგორ დასრულდა': 'endKind' },
  },
  flags: {
    sheet: 'ნიშნები',
    columns: { 'ხელშეკრულება': 'contract', 'ნიშანი': 'flag', 'თარიღიდან': 'from', 'თარიღამდე': 'to',
      'საფუძველი': 'basis', 'შენიშვნა': 'note' },
  },
  flagTypes: {
    sheet: 'ცნობარი',
    columns: { 'ნიშანი': 'name', 'ნიშნის ფერი': 'color' },
  },
  statuses: {
    sheet: 'ცნობარი',
    columns: { 'სტატუსი': 'name', 'ფერი': 'color', 'პრიორიტეტი': 'priority', 'აქტიურად ითვლება': 'active' },
  },
  geometries: {
    sheet: 'გეომეტრიები',
    columns: { 'კოდი': 'code', 'ნაწილი': 'part', 'წყარო': 'source', 'გეგმის №': 'plan',
      'სახე (კონტური / პინი)': 'kind', 'GeoJSON': 'geojson', 'ფართობი (მ²)': 'area', 'განახლდა': 'updated' },
  },
  views: {
    sheet: 'View-ები',
    columns: { 'სახელი': 'name', 'ფილტრი': 'filter', 'საჯაროა': 'public', 'ბმული': 'link', 'შეიქმნა': 'created' },
  },
};

// JSON პასუხი (GitHub Pages-ის გვერდისთვის; ContentService-ის პასუხს ნებისმიერი საიტი კითხულობს)
function jsonOutput(object) {
  return ContentService.createTextOutput(JSON.stringify(object)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  // GitHub Pages: შუამავალი NAPR-ისა და ms.gov.ge-სთვის (ბრაუზერი სხვა საიტიდან მათ პირდაპირ ვერ მიმართავს)
  if (e && e.parameter && e.parameter.action === 'search') return jsonOutput(searchCadastralCode(String(e.parameter.code || '')));
  if (e && e.parameter && e.parameter.action === 'fetch') return jsonOutput(fetchAllowed(String(e.parameter.url || ''), Number(e.parameter.max) || 0));
  if (e && e.parameter && e.parameter.action === 'plans') return jsonOutput(fetchPlanBundle(String(e.parameter.code || '')));
  if (e && e.parameter && e.parameter.action === 'fetchmany') return jsonOutput(fetchMany(String(e.parameter.urls || '[]'), Number(e.parameter.max) || 0));
  if (e && e.parameter && e.parameter.action === 'tiles') return jsonOutput(fetchMsTiles(String(e.parameter.year || ''), String(e.parameter.t || '')));
  // GitHub Pages: საჯარო View-ის ასლი (საჯარო Deploy, „Me“ + „Anyone“)
  if (e && e.parameter && e.parameter.action === 'view') {
    try {
      return jsonOutput({ data: getPublicView(String(e.parameter.token || '').replace(/[^0-9a-zA-Z]/g, '')) });
    } catch (error) {
      return jsonOutput({ error: error.message });
    }
  }
  const template = HtmlService.createTemplateFromFile('Index');
  // კოდში მხოლოდ ასოები და ციფრები დავტოვოთ, რომ გვერდში სხვა რამ ვერ ჩაიწეროს
  template.publicToken = (e && e.parameter && e.parameter.view) ? String(e.parameter.view).replace(/[^0-9a-zA-Z]/g, '').slice(0, 64) : '';
  return template.evaluate()
    .setTitle('ხელშეკრულებების რუკა')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

function openSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

// თარიღი → 'yyyy-MM-dd' ტექსტი (გვერდზე თარიღების შედარება ტექსტით ხდება)
function formatCell(value, timeZone) {
  if (value instanceof Date) return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd');
  return value;
}

// შიტის წაკითხვა ობიექტების სიად: [{id:..., type:...}, ...]; ცარიელი სტრიქონები გამოტოვებულია
function readTable(spreadsheet, tableName) {
  const table = TABLES[tableName];
  const sheet = spreadsheet.getSheetByName(table.sheet);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const timeZone = spreadsheet.getSpreadsheetTimeZone();
  const header = values[0].map(String);
  const columnIndexes = {};
  for (const [title, key] of Object.entries(table.columns)) {
    const index = header.indexOf(title);
    if (index >= 0) columnIndexes[key] = index;
  }
  const rows = [];
  for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
    const row = values[rowIndex];
    if (row.every((cell) => cell === '' || cell === null)) continue;
    const item = {};
    for (const [key, index] of Object.entries(columnIndexes)) item[key] = formatCell(row[index], timeZone);
    rows.push(item);
  }
  return rows;
}

// სრულ მონაცემზე და ჩაწერაზე წვდომა მხოლოდ შესულ მომხმარებელს. საჯარო Deploy-ში („Me“ + „Anyone“)
// უცნობ სტუმარს ელფოსტა არ აქვს, ამიტომ აქ ჩერდება.
function requireSignedInUser() {
  if (!Session.getActiveUser().getEmail()) throw new Error('ამ მოქმედებისთვის Google ანგარიშით შესვლაა საჭირო.');
}

// ---------- ქეში (ჩატვირთვის დასაჩქარებლად) ----------
// შიტების წაკითხვა ყველაზე ნელი ნაწილია, ამიტომ წაკითხულს ქეშში ვინახავთ (CACHE_SECONDS წამით).
// Sheet-ში ხელით ცვლილებისას onEdit ქეშს ასუფთავებს, ასე რომ რუკა მაშინვე ახალ მონაცემს აჩვენებს.
// ქეშიდან მონაცემი მხოლოდ მას ეძლევა, ვინც Sheet-ს თვითონ ხსნის (openSpreadsheet ჯერ მაინც მოწმდება).
const CACHE_KEY = 'mapData';
const CACHE_SECONDS = 3600;
const CACHE_CHUNK = 90000; // ერთ ჩანაწერში მაქსიმუმ 100 KB ეტევა

function readCache() {
  try {
    const cache = CacheService.getScriptCache();
    const count = Number(cache.get(CACHE_KEY + ':n'));
    if (!count) return null;
    const keys = [];
    for (let i = 0; i < count; i++) keys.push(CACHE_KEY + ':' + i);
    const parts = cache.getAll(keys);
    if (keys.some((key) => parts[key] == null)) return null;
    return JSON.parse(keys.map((key) => parts[key]).join(''));
  } catch (error) {
    return null;
  }
}

function writeCache(tables) {
  try {
    const text = JSON.stringify(tables);
    const values = {};
    let count = 0;
    for (let i = 0; i < text.length; i += CACHE_CHUNK) values[CACHE_KEY + ':' + count++] = text.slice(i, i + CACHE_CHUNK);
    values[CACHE_KEY + ':n'] = String(count);
    CacheService.getScriptCache().putAll(values, CACHE_SECONDS);
  } catch (error) {
    // ქეში არ ჩაიწერა (მაგ. ზედმეტად დიდია): შემდეგ ჯერზე ისევ შიტიდან წავიკითხავთ
  }
}

function clearCache() {
  try { CacheService.getScriptCache().remove(CACHE_KEY + ':n'); } catch (error) { /* არაფერი */ }
}

// ---------- შიტის მენიუ „🗺 რუკა“ ----------
// მარტივი ტრიგერი: შიტის გახსნისას მენიუს დამატება
function onOpen() {
  SpreadsheetApp.getUi().createMenu('🗺 რუკა')
    .addItem('კონტურების შევსება (ms.gov.ge)', 'fillMissingContours')
    .addToUi();
}

// ყველა კოდი („ქონებების ისტორია“ + „შეზღუდვები“), რომელსაც „გეომეტრიები“-ში მთლიანი კოდის კონტური არ აქვს,
// ms.gov.ge-დან ჩამოაქვს და ჩანართში წერს. რაც ვერ მოიძებნა (გაუქმებული კოდი), სიად ჩანს:
// მათ რუკაზე „კონტურის მოძიება“ → საკადასტრო გეგმიდან შეავსებ. ხელახლა გაშვება უსაფრთხოა (შევსებულს გამოტოვებს).
const FILL_BATCH = 20;                    // ms.gov.ge-ს ერთდროულად ამდენ მოთხოვნას ვუგზავნით
const FILL_TIME_LIMIT_MS = 5 * 60 * 1000; // Apps Script-ის 6 წუთის ლიმიტამდე ვჩერდებით
function fillMissingContours() {
  const started = Date.now();
  const ui = SpreadsheetApp.getUi();
  const spreadsheet = openSpreadsheet();
  const codePattern = /^\d{1,2}(\.\d{1,3}){2,9}[ა-ჰ]?$/;
  const codes = new Set();
  for (const row of readTable(spreadsheet, 'history').concat(readTable(spreadsheet, 'restrictions'))) {
    const code = String(row.code || '').trim();
    if (codePattern.test(code)) codes.add(code);
  }
  const filled = new Set(readTable(spreadsheet, 'geometries').filter((row) => !String(row.part || '') && row.geojson).map((row) => String(row.code)));
  const missing = [...codes].filter((code) => !filled.has(code));
  if (!missing.length) { ui.alert('ყველა კოდს უკვე აქვს კონტური.'); return; }

  const sheet = spreadsheet.getSheetByName(TABLES.geometries.sheet);
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const column = (title) => header.indexOf(title);
  const added = [], notFound = [], failed = [];
  let index = 0;
  for (; index < missing.length && Date.now() - started < FILL_TIME_LIMIT_MS; index += FILL_BATCH) {
    const batch = missing.slice(index, index + FILL_BATCH);
    const responses = UrlFetchApp.fetchAll(batch.map((code) => ({
      url: 'https://ms.gov.ge/core-api/v1/search/unified-search', method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ searchText: code }), muteHttpExceptions: true })));
    const rows = [];
    responses.forEach((response, position) => {
      const code = batch[position];
      if (response.getResponseCode() !== 200) { failed.push(code); return; }
      let result = null;
      try { result = JSON.parse(response.getContentText()).naprSearchResult; } catch (error) { /* არასწორი პასუხი */ }
      const geometry = result && wktToGeometry(result.wktShape);
      if (!geometry) { notFound.push(code); return; }
      const row = header.map(() => '');
      row[column('კოდი')] = code;
      row[column('წყარო')] = 'ms.gov.ge';
      row[column('სახე (კონტური / პინი)')] = 'კონტური';
      row[column('GeoJSON')] = roundGeometryText(JSON.stringify(geometry));
      row[column('ფართობი (მ²)')] = Math.round(geometryArea(geometry) * 10) / 10;
      row[column('განახლდა')] = new Date();
      rows.push(row);
      added.push(code);
    });
    if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
  }
  clearCache();
  const left = missing.length - Math.min(index, missing.length);
  let message = 'დაემატა ' + added.length + ' კონტური.';
  if (notFound.length) message += '\n\nms.gov.ge-ზე ვერ მოიძებნა (' + notFound.length + '): ' + notFound.slice(0, 40).join(', ') + (notFound.length > 40 ? ' …' : '') +
    '\nესენი რუკაზე გახსენი → „კონტურის მოძიება“ (საკადასტრო გეგმიდან) → 💾.';
  if (failed.length) message += '\n\nms.gov.ge-მ ვერ უპასუხა (' + failed.length + '): ' + failed.slice(0, 20).join(', ') + '. ხელახლა გაუშვი.';
  if (left > 0) message += '\n\nდრო ამოიწურა: დარჩა ' + left + ' კოდი. გაუშვი ხელახლა.';
  message += '\n\nრუკაზე: ფენები → „↻ მონაცემის განახლება Sheet-იდან“.';
  ui.alert('კონტურების შევსება', message, ui.ButtonSet.OK);
}

// WKT (POLYGON / MULTIPOLYGON, გრძედი განედი) → GeoJSON geometry
function wktToGeometry(wkt) {
  const text = String(wkt || '').trim();
  const type = text.match(/^(MULTIPOLYGON|POLYGON)/i);
  if (!type) return null;
  const json = text.slice(text.indexOf('(')).replace(/\(/g, '[').replace(/\)/g, ']')
    .replace(/(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s+(-?\d+(?:\.\d+)?(?:e-?\d+)?)(?:\s+-?\d+(?:\.\d+)?)?/gi, '[$1,$2]');
  try { return { type: type[1].toUpperCase() === 'POLYGON' ? 'Polygon' : 'MultiPolygon', coordinates: JSON.parse(json) }; } catch (error) { return null; }
}

// ფართობი კვ. მეტრებში (სფერული მიახლოება; გარე რგოლს ხვრელები აკლდება)
function geometryArea(geometry) {
  const radius = 6378137, toRadians = Math.PI / 180;
  const ringArea = (ring) => {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      sum += (ring[i + 1][0] - ring[i][0]) * toRadians * (2 + Math.sin(ring[i][1] * toRadians) + Math.sin(ring[i + 1][1] * toRadians));
    }
    return Math.abs(sum * radius * radius / 2);
  };
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((total, rings) => total + ringArea(rings[0]) - rings.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0), 0);
}

// მარტივი ტრიგერი: Sheet-ში ნებისმიერი ხელით ცვლილებისას
function onEdit(e) {
  clearCache();
  colorReferenceCells(e);
}

// „ცნობარი“: ფერის უჯრას (სტატუსის „ფერი“, „ნიშნის ფერი“) ფონად თავისივე ფერი ედება (#RRGGBB)
function colorReferenceCells(e) {
  if (!e || !e.range || e.range.getSheet().getName() !== 'ცნობარი') return;
  const sheet = e.range.getSheet();
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const colorColumns = ['ფერი', 'ნიშნის ფერი'].map((title) => header.indexOf(title) + 1).filter((column) => column > 0);
  const range = e.range;
  for (const column of colorColumns) {
    if (column < range.getColumn() || column > range.getLastColumn()) continue;
    const cells = sheet.getRange(Math.max(2, range.getRow()), column, Math.max(1, range.getLastRow() - Math.max(2, range.getRow()) + 1), 1);
    const values = cells.getValues();
    cells.setBackgrounds(values.map(([value]) => [/^#[0-9a-f]{6}$/i.test(String(value).trim()) ? String(value).trim() : null]));
  }
}

// კონტურის კოორდინატები 7 ციფრამდე (~1 სმ): ზედმეტი ციფრები მხოლოდ ტრაფიკს ზრდის
const COORDINATE_DIGITS = 7;
function roundGeometryText(text) {
  if (!text) return text;
  try {
    const factor = Math.pow(10, COORDINATE_DIGITS);
    return JSON.stringify(JSON.parse(text), (key, value) => typeof value === 'number' ? Math.round(value * factor) / factor : value);
  } catch (error) {
    return text;
  }
}

function readAllTables(spreadsheet) {
  const tables = {};
  for (const tableName of Object.keys(TABLES)) tables[tableName] = readTable(spreadsheet, tableName);
  tables.geometries.forEach((row) => { row.geojson = roundGeometryText(row.geojson); });
  // რედაქტორების სია ნელა იკითხება, ამიტომ ისიც ქეშში მიდის
  try {
    tables.editorEmails = [spreadsheet.getOwner() ? spreadsheet.getOwner().getEmail() : '']
      .concat(spreadsheet.getEditors().map((user) => user.getEmail())).filter(Boolean);
  } catch (error) {
    tables.editorEmails = [];
  }
  return tables;
}

// fresh = true: ქეშს გვერდს უვლის და შიტებს თავიდან კითხულობს (ღილაკი „მონაცემის განახლება“)
function getMapData(fresh) {
  requireSignedInUser();
  const spreadsheet = openSpreadsheet(); // წვდომის შემოწმება: ვისაც Sheet არ აქვს, აქ შეცდომას მიიღებს
  let tables = fresh ? null : readCache();
  if (!tables) {
    tables = readAllTables(spreadsheet);
    writeCache(tables);
  }
  const email = Session.getActiveUser().getEmail();
  const data = Object.assign({}, tables, { canEdit: tables.editorEmails.indexOf(email) >= 0, appUrl: ScriptApp.getService().getUrl() });
  delete data.editorEmails;
  return data;
}

// კონტურის ჩაწერა: თუ ამ კოდს + ნაწილს უკვე აქვს სტრიქონი, ის განახლდება, თუ არა, დაემატება
function saveGeometry(code, part, geojsonText, areaSquareMeters, source, planNumber) {
  requireSignedInUser();
  const spreadsheet = openSpreadsheet();
  const sheet = spreadsheet.getSheetByName(TABLES.geometries.sheet);
  const values = sheet.getDataRange().getValues();
  const header = values[0].map(String);
  const column = (title) => header.indexOf(title);
  const newRow = header.map(() => '');
  newRow[column('კოდი')] = code;
  newRow[column('ნაწილი')] = part || '';
  newRow[column('წყარო')] = source || 'მოხაზული რუკაზე';
  if (column('გეგმის №') >= 0) newRow[column('გეგმის №')] = planNumber || '';
  newRow[column('სახე (კონტური / პინი)')] = 'კონტური';
  newRow[column('GeoJSON')] = geojsonText;
  newRow[column('ფართობი (მ²)')] = Math.round(areaSquareMeters * 10) / 10;
  newRow[column('განახლდა')] = new Date();
  for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
    const sameCode = String(values[rowIndex][column('კოდი')]) === code;
    const samePart = String(values[rowIndex][column('ნაწილი')]) === String(part || '');
    if (sameCode && samePart) {
      sheet.getRange(rowIndex + 1, 1, 1, newRow.length).setValues([newRow]);
      clearCache();
      return 'updated';
    }
  }
  sheet.appendRow(newRow);
  clearCache();
  return 'added';
}

// View-ის შენახვა სახელით (იგივე სახელი = გადაწერა)
function saveView(name, filterText, link) {
  requireSignedInUser();
  const sheet = openSpreadsheet().getSheetByName(TABLES.views.sheet);
  const values = sheet.getDataRange().getValues();
  const newRow = [name, filterText, 'არა', link, new Date()];
  for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
    if (String(values[rowIndex][0]) === name) {
      sheet.getRange(rowIndex + 1, 1, 1, newRow.length).setValues([newRow]);
      clearCache();
      return 'updated';
    }
  }
  sheet.appendRow(newRow);
  clearCache();
  return 'added';
}

// GitHub Pages: შეუძლია თუ არა შესულ მომხმარებელს Sheet-ში ჩაწერა.
// გვერდი თავის Google ტოკენს გვიგზავნის; Google-ისგან ვიგებთ, ვისია, და ვადარებთ რედაქტორების სიას.
// ტოკენს არსად ვინახავთ.
function doPost(e) {
  try {
    const request = JSON.parse(e.postData.contents);
    if (request.action !== 'role') return jsonOutput({ error: 'unknown action' });
    const info = JSON.parse(UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(request.token), { muteHttpExceptions: true }).getContentText());
    const email = String(info.email || '').toLowerCase();
    if (!email || info.email_verified === 'false') return jsonOutput({ canEdit: false });
    const spreadsheet = openSpreadsheet();
    const editors = [spreadsheet.getOwner() ? spreadsheet.getOwner().getEmail() : ''].concat(spreadsheet.getEditors().map((user) => user.getEmail()));
    return jsonOutput({ canEdit: editors.some((address) => String(address).toLowerCase() === email) });
  } catch (error) {
    return jsonOutput({ canEdit: false, error: error.message });
  }
}

// ---------- შუამავალი (მხოლოდ ქვემოთ ჩამოთვლილი მისამართები) ----------
// საკადასტრო კოდის ძებნა ms.gov.ge-ზე: აბრუნებს კონტურს (WKT, EPSG:4326) და მისამართს
function searchCadastralCode(code) {
  const clean = code.trim();
  if (!/^[0-9.]{5,40}[ა-ჰ]?$/.test(clean)) return { error: 'საკადასტრო კოდი არასწორია.' };
  const response = UrlFetchApp.fetch('https://ms.gov.ge/core-api/v1/search/unified-search', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ searchText: clean }), muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) return { error: 'ms.gov.ge: HTTP ' + response.getResponseCode() };
  return { data: JSON.parse(response.getContentText()) };
}

// რეესტრის გვერდი (გეგმების სია) და PDF ფაილები; სხვა მისამართზე უარს ვამბობთ
const FETCH_ALLOWED = [/^https:\/\/abstract\.reestri\.gov\.ge\/abstract\/cad_amo\.php\?/, /^https:\/\/bs\.napr\.gov\.ge\/GetBlob/i];
// რეესტრის ბმულებში ზოგჯერ არის სიმბოლოები ([ ] | და სხვ.), რომლებსაც UrlFetchApp არ იღებს: ვკოდავთ
function safeUrl(url) {
  return url.replace(/[\[\]{}|\\^`" <>]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

// maxBytes > 0: ფაილის მხოლოდ პირველი maxBytes ბაიტი ვითხოვთ (HTTP Range). თუ ფაილი უფრო დიდია,
// ბრუნდება { status: 413, size } შიგთავსის გარეშე: დიდი ნახაზები (10 მბ-მდე) Google-ის გავლით წუთობით მოდის,
// საკადასტრო გეგმა კი, როგორც წესი, 500 კბ-ზე ნაკლებია. თუ სერვერი Range-ს არ ცნობს, ფაილი მთლიანად მოდის.
function fetchOptions(url, maxBytes) {
  const options = { url: safeUrl(url), muteHttpExceptions: true, followRedirects: true };
  if (maxBytes > 0) options.headers = { Range: 'bytes=0-' + (maxBytes - 1) };
  return options;
}
function fileResult(url, response, maxBytes) {
  const headers = response.getHeaders();
  const header = (name) => String(headers[name] || headers[name.toLowerCase()] || '');
  let status = response.getResponseCode();
  if (status === 206) {
    // Content-Range: bytes 0-511999/10485760 → სრული ზომა
    const total = Number((header('Content-Range').match(/\/(\d+)/) || [])[1]) || 0;
    if (total > maxBytes) return { url, status: 413, size: total, type: header('Content-Type'), base64: '' };
    status = 200; // მთლიანი ფაილი მოვიდა
  }
  const type = header('Content-Type');
  const result = { url, status, type, size: response.getContent().length };
  if (/text|html/i.test(type)) result.text = response.getContentText();
  else result.base64 = status === 200 ? Utilities.base64Encode(response.getContent()) : '';
  return result;
}

function fetchAllowed(url, maxBytes) {
  if (!FETCH_ALLOWED.some((pattern) => pattern.test(url))) return { error: 'ეს მისამართი დაშვებული არ არის.' };
  let response;
  try {
    const options = fetchOptions(url, maxBytes || 0);
    response = UrlFetchApp.fetch(options.url, options);
  } catch (error) {
    return { error: 'რეესტრის ფაილი ვერ ჩამოვიწერე: ' + error.message };
  }
  return fileResult(url, response, maxBytes || 0);
}

// კოდის ყველა „საკადასტრო რუკა“ ერთი მოთხოვნით: რეესტრის სია + ყველა PDF პარალელურად (UrlFetchApp.fetchAll).
// ბრაუზერიდან ცალ-ცალკე მოთხოვნებთან შედარებით ბევრად სწრაფია. ბრუნდება { listHtml, files: [{ url, status, base64 }] }.
const PLAN_BUNDLE_LIMIT = 40;
function fetchPlanBundle(code) {
  if (!/^[0-9.]{5,40}[ა-ჰ]?$/.test(code)) return { error: 'საკადასტრო კოდი არასწორია.' };
  const listUrl = 'https://abstract.reestri.gov.ge/abstract/cad_amo.php?cad_code=' + encodeURIComponent(code);
  const list = UrlFetchApp.fetch(listUrl, { muteHttpExceptions: true });
  if (list.getResponseCode() !== 200) return { error: 'რეესტრის სია: HTTP ' + list.getResponseCode() };
  const listHtml = list.getContentText();
  // სტრიქონები, რომელთა ტიპია „საკადასტრო რუკა“ (napr_docs.js → parseAbstractPage-ის მსგავსად)
  const urls = [];
  const rowPattern = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowPattern.exec(listHtml)) && urls.length < PLAN_BUNDLE_LIMIT) {
    const link = match[1].match(/openWindow\('([^']+)'\)/i);
    if (!link || !/საკადასტრო\s*რუკა/.test(match[2].replace(/&nbsp;/g, ' '))) continue;
    const url = link[1].replace(/&amp;/g, '&');
    if (/^https:\/\/bs\.napr\.gov\.ge\/GetBlob/i.test(url)) urls.push(url);
  }
  const responses = urls.length ? UrlFetchApp.fetchAll(urls.map((url) => ({ url: safeUrl(url), muteHttpExceptions: true }))) : [];
  const files = responses.map((response, index) => ({ url: urls[index], status: response.getResponseCode(),
    base64: response.getResponseCode() === 200 ? Utilities.base64Encode(response.getContent()) : '' }));
  return { listHtml, files };
}

// რამდენიმე რეესტრის ფაილი ერთი მოთხოვნით, პარალელურად. urlsJson = ["https://bs.napr.gov.ge/GetBlob…", …] (მაქს. 8)
function fetchMany(urlsJson, maxBytes) {
  let urls;
  try { urls = JSON.parse(urlsJson); } catch (error) { return { error: 'არასწორი სია.' }; }
  if (!Array.isArray(urls) || !urls.length || urls.length > 8) return { error: 'ფაილების რაოდენობა 1-8 უნდა იყოს.' };
  if (!urls.every((url) => typeof url === 'string' && FETCH_ALLOWED.some((pattern) => pattern.test(url)))) return { error: 'ეს მისამართი დაშვებული არ არის.' };
  let responses;
  try {
    responses = UrlFetchApp.fetchAll(urls.map((url) => fetchOptions(url, maxBytes || 0)));
  } catch (error) {
    return { error: 'რეესტრის ფაილები ვერ ჩამოვიწერე: ' + error.message };
  }
  return { files: responses.map((response, index) => fileResult(urls[index], response, maxBytes || 0)) };
}

// ---------- ms.gov.ge-ის ორთოფოტოს ფილები ----------
// ms.gov.ge ფილებს მხოლოდ საკუთარ გვერდს აძლევს (სხვა საიტიდან ბრაუზერში 503). შუამავალი მათ ms.gov.ge-ის
// Referer-ით ითხოვს, პარალელურად (fetchAll), და base64-ად აბრუნებს. Google-ის ქეში (6 სთ) ხელახლა მოთხოვნას
// ზოგავს და UrlFetchApp-ის დღიურ ლიმიტსაც (ჩვეულებრივ ანგარიშზე ~20 000 მოთხოვნა დღეში).
// t = "z/x/y,z/x/y,…" (მაქს. 16) → { tiles: { "z/x/y": base64 | "" } }
const MS_TILE_YEARS = ['2024', '2020', '2014'];
const MS_TILE_LIMIT = 16;
function fetchMsTiles(year, list) {
  if (MS_TILE_YEARS.indexOf(year) < 0) return { error: 'ეს წელი არ არის: ' + year };
  const keys = list.split(',').filter((key) => /^\d{1,2}\/\d{1,7}\/\d{1,7}$/.test(key));
  if (!keys.length || keys.length > MS_TILE_LIMIT) return { error: 'ფილების რაოდენობა 1-' + MS_TILE_LIMIT + ' უნდა იყოს.' };
  const cache = CacheService.getScriptCache();
  const cacheKey = (key) => 'ms' + year + '/' + key;
  const cached = cache.getAll(keys.map(cacheKey));
  const tiles = {};
  const missing = [];
  keys.forEach((key) => { if (cached[cacheKey(key)] !== undefined) tiles[key] = cached[cacheKey(key)]; else missing.push(key); });
  if (missing.length) {
    const requests = missing.map((key) => {
      const [z, x, y] = key.split('/');
      return { url: 'https://ms.gov.ge/gis-api/v1/tileserver/image' + year + '/' + x + '/' + y + '/' + z, muteHttpExceptions: true,
        headers: { Referer: 'https://ms.gov.ge/home/dashboard' } };
    });
    let responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (error) {
      return { error: 'ms.gov.ge-ის ფილები ვერ მოვიდა: ' + error.message };
    }
    const toCache = {};
    const failed = {};
    responses.forEach((response, index) => {
      const headers = response.getHeaders();
      const ok = response.getResponseCode() === 200 && /image/i.test(String(headers['Content-Type'] || headers['content-type'] || ''));
      if (!ok) failed[missing[index]] = response.getResponseCode(); // შემოწმებისთვის: რა უპასუხა ms.gov.ge-მ
      const base64 = ok ? Utilities.base64Encode(response.getContent()) : '';
      tiles[missing[index]] = base64;
      if (ok && base64.length < 95000) toCache[cacheKey(missing[index])] = base64; // ქეშის ერთი ჩანაწერი ≤ 100 კბ
    });
    if (Object.keys(toCache).length) cache.putAll(toCache, 21600);
    if (Object.keys(failed).length) return { tiles, failed };
  }
  return { tiles };
}

// ---------- საჯარო View-ები ----------
// შიტი „საჯარო ხედები“: კოდი · სახელი · შეიქმნა · ვადა · მოქმედია · მხარე ჩანს · ნაწილები · მონაცემი (H სვეტიდან)
function publicSheet() {
  const spreadsheet = openSpreadsheet();
  let sheet = spreadsheet.getSheetByName(PUBLIC_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(PUBLIC_SHEET);
    sheet.getRange(1, 1, 1, 8).setValues([['კოდი', 'სახელი', 'შეიქმნა', 'ვადა', 'მოქმედია', 'მხარე ჩანს', 'ნაწილები', 'მონაცემი']]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function publicLink(token) {
  return PUBLIC_APP_URL ? PUBLIC_APP_URL + '?view=' + token : '';
}

// გამოქვეყნება: snapshotText = გვერდზე უკვე გაფილტრული მონაცემის ასლი (მხოლოდ ამ View-ის ობიექტები)
function publishView(name, days, showParty, snapshotText) {
  requireSignedInUser();
  if (!PUBLIC_APP_URL) throw new Error('საჯარო Deploy ჯერ არ არის: Code.gs-ში PUBLIC_APP_URL ცარიელია.');
  const sheet = publicSheet();
  const token = Utilities.getUuid().replace(/-/g, '');
  const expires = Number(days) > 0 ? new Date(Date.now() + Number(days) * 86400000) : '';
  const chunks = [];
  for (let i = 0; i < snapshotText.length; i += PUBLIC_CHUNK) chunks.push(snapshotText.slice(i, i + PUBLIC_CHUNK));
  const row = [token, name, new Date(), expires, 'კი', showParty ? 'კი' : 'არა', chunks.length].concat(chunks);
  const rowIndex = sheet.getLastRow() + 1;
  if (sheet.getMaxColumns() < row.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), row.length - sheet.getMaxColumns());
  sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  return { token, link: publicLink(token), expires: expires ? Utilities.formatDate(expires, openSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd') : '' };
}

function listPublicViews() {
  requireSignedInUser();
  const sheet = publicSheet();
  const timeZone = openSpreadsheet().getSpreadsheetTimeZone();
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues().filter((row) => row[0]).map((row) => ({
    token: String(row[0]), name: String(row[1]), link: publicLink(String(row[0])),
    expires: row[3] instanceof Date ? Utilities.formatDate(row[3], timeZone, 'yyyy-MM-dd') : '',
    active: row[4] === 'კი' && !(row[3] instanceof Date && row[3] < new Date()),
  }));
}

function unpublishView(token) {
  requireSignedInUser();
  const sheet = publicSheet();
  const tokens = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map((row) => String(row[0]));
  const index = tokens.indexOf(String(token));
  if (index < 1) throw new Error('ასეთი საჯარო ბმული ვერ მოიძებნა.');
  sheet.getRange(index + 1, 5).setValue('არა');
  return 'ok';
}

// საჯარო გვერდი: მხოლოდ მოქმედი, ვადაგაუსვლელი View-ის ასლი
// ვადა: Apps Script-ის ვერსია თარიღს წერს, GitHub Pages-ის ვერსია ტექსტს 'yyyy-mm-dd' (ამ დღის ბოლომდე მოქმედებს)
function expiryDate(value) {
  if (value instanceof Date) return value;
  if (!value) return null;
  const date = new Date(String(value) + 'T23:59:59+04:00');
  return isNaN(date.getTime()) ? null : date;
}

function getPublicView(token) {
  const sheet = publicSheet();
  const values = sheet.getDataRange().getValues();
  const row = values.find((candidate, index) => index > 0 && String(candidate[0]) === String(token));
  const notAvailable = 'ეს საჯარო ბმული აღარ მოქმედებს.';
  if (!row || row[4] !== 'კი') throw new Error(notAvailable);
  const expiry = expiryDate(row[3]);
  if (expiry && expiry < new Date()) throw new Error(notAvailable);
  const chunkCount = Number(row[6]) || 0;
  const data = JSON.parse(row.slice(7, 7 + chunkCount).join(''));
  data.canEdit = false;
  data.publicInfo = { name: String(row[1]), expires: expiry ? Utilities.formatDate(expiry, openSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd') : '', link: publicLink(String(token)) };
  return data;
}
