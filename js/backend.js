/**
 * backend.js: გვერდის კავშირი მონაცემთან (GitHub Pages ვერსია).
 *
 * ადრე ამას Apps Script-ის სერვერი (google.script.run) აკეთებდა. ახლა:
 *   - მომხმარებელი Google-ით შედის (Google Identity Services, „token“ რეჟიმი);
 *   - Sheet-ს გვერდი პირდაპირ კითხულობს და წერს Sheets API-ით, მომხმარებლის საკუთარი უფლებით
 *     (ვისაც Sheet არ აქვს გაზიარებული, ის მონაცემს ვერ ნახავს: ამას Google ამოწმებს და არა ჩვენ);
 *   - Apps Script რჩება მხოლოდ ორი რამისთვის (საჯარო Deploy, „Me“ + „Anyone“):
 *       ?action=view  → საჯარო View-ის ასლი Google ანგარიშის გარეშე მნახველისთვის;
 *       POST role     → შეუძლია თუ არა შესულ მომხმარებელს Sheet-ში ჩაწერა (რედაქტორების სია მხოლოდ მფლობელს ჩანს).
 *
 * ყველა ფუნქციას იგივე სახელი და არგუმენტები აქვს, რაც ძველ სერვერს, ამიტომ index.html-ის კოდი თითქმის არ შეცვლილა.
 */

// ---------- პარამეტრები ----------
const CONFIG = {
  // Google Cloud → Clients → Web application → Client ID (საიდუმლო არ არის; მხოლოდ ამ საიტიდან მუშაობს)
  clientId: '564703262271-ce6p9rv0mm223tprcleh96vacv0gevfo.apps.googleusercontent.com',
  spreadsheetId: '1RhoMaLorr2zimIcl6Szy_HrAakcjQyMiVxSGDdc4zGo',
  // Apps Script-ის საჯარო Deploy-ის ბმული (…/exec)
  publicApiUrl: 'https://script.google.com/macros/s/AKfycbw_mcKDmLXGHjQKvGZ4fSedMM8ZGfokFbhaBrySrtmm8Dp6WATPZ8OtFrjk7jNBwEqIvw/exec',
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets', // Sheet-ის წაკითხვა და ჩაწერა (მხოლოდ იმ ფაილებზე, რაც მომხმარებელს გაზიარებული აქვს)
    'openid', 'email',                              // ვინ შევიდა (რედაქტორობის შესამოწმებლად)
  ].join(' '),
  // პირადი რუკები: მხოლოდ ამ საიტის დამალული საქაღალდე მომხმარებლის Drive-ში (სხვა ფაილებს ვერ ხედავს).
  // ცალკე ტოკენით ითხოვება (იხ. ქვემოთ „Google Drive“), Sheet-ის ტოკენში არ ერევა.
  driveScope: 'https://www.googleapis.com/auth/drive.appdata',
};
const PUBLIC_SHEET = 'საჯარო ხედები';
const PUBLIC_CHUNK = 45000; // უჯრის ლიმიტი 50 000 სიმბოლოა

// შიტების სახელები და სვეტების სათაური → პროგრამული სახელი (იგივე, რაც Code.gs-ში)
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
      'თარიღამდე*': 'to', 'როგორ დასრულდა': 'endKind', 'საფუძველი': 'basis', 'გეგმის №*': 'plan' },
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

// ამ სვეტებში თარიღებია: Sheets API მათ რიცხვად (დღეები 1899-12-30-დან) გვაძლევს → 'yyyy-mm-dd'
const DATE_KEYS = new Set(['signed', 'start', 'end', 'date', 'from', 'to', 'updated', 'created']);
const serialToDate = (serial) => new Date(Math.round((serial - 25569) * 86400000)).toISOString().slice(0, 10);

// ---------- შესვლა ----------
const TOKEN_KEY = 'customMapToken';
let accessToken = null;
let tokenClient = null;

function readStoredToken() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
    if (stored && stored.expires > Date.now() + 60000) return stored.token;
  } catch (error) { /* ბრაუზერი მეხსიერებას არ გვაძლევს */ }
  return null;
}

function storeToken(token, seconds) {
  try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expires: Date.now() + seconds * 1000 })); } catch (error) { /* არაფერი */ }
}

function loadGoogleScript() {
  if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Google-ის შესვლის სკრიპტი ვერ ჩაიტვირთა.'));
    document.head.appendChild(script);
  });
}

// შესვლის ფანჯარა: ბრაუზერი Google-ის ფანჯარას მხოლოდ ღილაკზე დაჭერით გვიხსნის, ამიტომ ჯერ ღილაკს ვაჩვენებთ.
// შედეგი: ტოკენი, ან null თუ მომხმარებელმა „შესვლის გარეშე“ აირჩია.
function askToSignIn(message) {
  return new Promise((resolve) => {
    const box = document.getElementById('signIn');
    document.getElementById('signInText').textContent = message || 'ხელშეკრულებების სანახავად შედი Google-ით. შენი Sheet-ის უფლება გამოიყენება: ვისაც Sheet არ აქვს გაზიარებული, ხელშეკრულებებს ვერ ნახავს.';
    box.classList.add('open');
    document.getElementById('loading').style.display = 'none';
    document.getElementById('signInSkip').onclick = () => { box.classList.remove('open'); resolve(null); };
    document.getElementById('signInGo').onclick = async () => {
      try {
        await loadGoogleScript();
        if (!CONFIG.clientId) throw new Error('Client ID ჯერ არ არის ჩაწერილი (js/backend.js → CONFIG.clientId).');
        // include_granted_scopes: false → ამ ტოკენში მხოლოდ Sheet-ის უფლებაა, Drive-ის არა (ის Apps Script-საც ეგზავნება როლის შესამოწმებლად)
        tokenClient = tokenClient || google.accounts.oauth2.initTokenClient({ client_id: CONFIG.clientId, scope: CONFIG.scopes, include_granted_scopes: false, callback: () => {} });
        tokenClient.callback = (response) => {
          if (response.error || !response.access_token) { showToast('შესვლა ვერ მოხერხდა: ' + (response.error || '')); return; }
          accessToken = response.access_token;
          storeToken(accessToken, Number(response.expires_in) || 3600);
          box.classList.remove('open');
          document.getElementById('loading').style.display = 'flex';
          resolve(accessToken);
        };
        tokenClient.requestAccessToken({ prompt: '' });
      } catch (error) {
        showToast(error.message, 8000);
      }
    };
  });
}

async function ensureToken() {
  accessToken = accessToken || readStoredToken();
  if (accessToken) return accessToken;
  const token = await askToSignIn();
  if (!token) throw Object.assign(new Error('შესვლის გარეშე'), { anonymous: true });
  return token;
}

function signOut() {
  if (accessToken && window.google && google.accounts) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null;
  forgetDrive();
  try { sessionStorage.removeItem(TOKEN_KEY); } catch (error) { /* არაფერი */ }
  location.reload();
}

// Sheets API-ის გამოძახება; ვადაგასული ტოკენისას ერთხელ ვთხოვთ თავიდან შესვლას
async function sheetsApi(path, options, retried) {
  const token = await ensureToken();
  const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + CONFIG.spreadsheetId + path, Object.assign({}, options, {
    headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, (options || {}).headers),
  }));
  if (response.status === 401 && !retried) {
    accessToken = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (error) { /* არაფერი */ }
    const again = await askToSignIn('სესიას ვადა გაუვიდა. გაგრძელებისთვის თავიდან შედი Google-ით.');
    if (!again) throw new Error('შესვლის გარეშე ვერ გაგრძელდება.');
    return sheetsApi(path, options, true);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error((body.error && body.error.message) || ('Sheets API: ' + response.status)), { status: response.status });
  return body;
}

const quoteSheet = (name) => "'" + String(name).replace(/'/g, "''") + "'";

// ---------- ცხრილების წაკითხვა ----------
function rowsToObjects(values, columns) {
  if (!values || values.length < 2) return [];
  const header = values[0].map(String);
  const indexes = {};
  for (const [title, key] of Object.entries(columns)) {
    const index = header.indexOf(title);
    if (index >= 0) indexes[key] = index;
  }
  const rows = [];
  for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
    const row = values[rowIndex];
    if (!row || row.every((cell) => cell === '' || cell === null || cell === undefined)) continue;
    const item = {};
    for (const [key, index] of Object.entries(indexes)) {
      let value = row[index] === undefined ? '' : row[index];
      if (DATE_KEYS.has(key) && typeof value === 'number') value = serialToDate(value);
      item[key] = value;
    }
    rows.push(item);
  }
  return rows;
}

function emptyData(reason) {
  const data = { canEdit: false, appUrl: location.origin + location.pathname, noAccess: reason || 'anonymous' };
  for (const name of Object.keys(TABLES)) data[name] = [];
  return data;
}

// შეუძლია თუ არა ჩაწერა: რედაქტორების სია მხოლოდ მფლობელს ჩანს, ამიტომ ამას Apps Script ამოწმებს
async function checkCanEdit() {
  if (!CONFIG.publicApiUrl) return true; // საჯარო Deploy ჯერ არ არის მითითებული: ღილაკებს ვაჩვენებთ, Sheet თვითონ შეაჩერებს
  try {
    const response = await fetch(CONFIG.publicApiUrl, { method: 'POST', body: JSON.stringify({ action: 'role', token: accessToken }) });
    const body = await response.json();
    return !!body.canEdit;
  } catch (error) {
    return false;
  }
}

async function getMapData() {
  let meta;
  try {
    meta = await sheetsApi('?fields=sheets.properties.title');
  } catch (error) {
    if (error.anonymous) return emptyData('anonymous');
    if (error.status === 403 || error.status === 404) return emptyData('noSheet');
    throw error;
  }
  const existing = new Set(meta.sheets.map((sheet) => sheet.properties.title));
  const sheetNames = Array.from(new Set(Object.values(TABLES).map((table) => table.sheet))).filter((name) => existing.has(name));
  const query = sheetNames.map((name) => 'ranges=' + encodeURIComponent(quoteSheet(name))).join('&');
  const [batch, canEdit] = await Promise.all([
    sheetsApi('/values:batchGet?' + query + '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER'),
    checkCanEdit(),
  ]);
  const valuesBySheet = {};
  sheetNames.forEach((name, index) => { valuesBySheet[name] = (batch.valueRanges[index] || {}).values || []; });
  const data = { canEdit, appUrl: location.origin + location.pathname };
  for (const [key, table] of Object.entries(TABLES)) data[key] = rowsToObjects(valuesBySheet[table.sheet], table.columns);
  return data;
}

// ---------- ჩაწერა ----------
const nowText = () => { const d = new Date(); const pad = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };

async function readSheetValues(sheetName) {
  const result = await sheetsApi('/values/' + encodeURIComponent(quoteSheet(sheetName)) + '?valueRenderOption=UNFORMATTED_VALUE');
  return result.values || [];
}

// სტრიქონის განახლება (rowNumber = 1-დან) ან ბოლოში დამატება
async function writeRow(sheetName, rowNumber, row) {
  if (rowNumber) {
    return sheetsApi('/values/' + encodeURIComponent(quoteSheet(sheetName) + '!A' + rowNumber) + '?valueInputOption=USER_ENTERED', {
      method: 'PUT', body: JSON.stringify({ values: [row] }) });
  }
  return sheetsApi('/values/' + encodeURIComponent(quoteSheet(sheetName) + '!A1') + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', {
    method: 'POST', body: JSON.stringify({ values: [row] }) });
}

async function saveGeometry(code, part, geojsonText, areaSquareMeters, source, planNumber) {
  const sheetName = TABLES.geometries.sheet;
  const values = await readSheetValues(sheetName);
  const header = (values[0] || []).map(String);
  const column = (title) => header.indexOf(title);
  const row = header.map(() => '');
  row[column('კოდი')] = code;
  row[column('ნაწილი')] = part || '';
  row[column('წყარო')] = source || 'მოხაზული რუკაზე';
  if (column('გეგმის №') >= 0) row[column('გეგმის №')] = planNumber || '';
  row[column('სახე (კონტური / პინი)')] = 'კონტური';
  row[column('GeoJSON')] = geojsonText;
  row[column('ფართობი (მ²)')] = Math.round(areaSquareMeters * 10) / 10;
  row[column('განახლდა')] = nowText();
  for (let index = 1; index < values.length; index++) {
    if (String(values[index][column('კოდი')]) === String(code) && String(values[index][column('ნაწილი')] || '') === String(part || '')) {
      await writeRow(sheetName, index + 1, row);
      return 'updated';
    }
  }
  await writeRow(sheetName, 0, row);
  return 'added';
}

async function saveView(name, filterText, link) {
  const sheetName = TABLES.views.sheet;
  const values = await readSheetValues(sheetName);
  const row = [name, filterText, 'არა', link, nowText()];
  for (let index = 1; index < values.length; index++) {
    if (String(values[index][0]) === name) { await writeRow(sheetName, index + 1, row); return 'updated'; }
  }
  await writeRow(sheetName, 0, row);
  return 'added';
}

// ---------- საჯარო View-ები ----------
const publicLink = (token) => location.origin + location.pathname + '?view=' + token;

async function ensurePublicSheet() {
  const meta = await sheetsApi('?fields=sheets.properties.title');
  if (meta.sheets.some((sheet) => sheet.properties.title === PUBLIC_SHEET)) return;
  await sheetsApi(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: PUBLIC_SHEET, gridProperties: { frozenRowCount: 1 } } } }] }) });
  await writeRow(PUBLIC_SHEET, 1, ['კოდი', 'სახელი', 'შეიქმნა', 'ვადა', 'მოქმედია', 'მხარე ჩანს', 'ნაწილები', 'მონაცემი']);
}

async function publishView(name, days, showParty, snapshotText) {
  if (!CONFIG.publicApiUrl) throw new Error('საჯარო Deploy-ის ბმული ჯერ არ არის ჩაწერილი (js/backend.js → CONFIG.publicApiUrl).');
  await ensurePublicSheet();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  let expires = '';
  if (Number(days) > 0) expires = new Date(Date.now() + Number(days) * 86400000).toISOString().slice(0, 10);
  const chunks = [];
  for (let i = 0; i < snapshotText.length; i += PUBLIC_CHUNK) chunks.push(snapshotText.slice(i, i + PUBLIC_CHUNK));
  // RAW: ტექსტი ისე ჩაიწეროს, როგორც არის (JSON ფორმულად არ გადაიქცეს)
  const row = [token, name, nowText(), expires, 'კი', showParty ? 'კი' : 'არა', chunks.length].concat(chunks);
  await sheetsApi('/values/' + encodeURIComponent(quoteSheet(PUBLIC_SHEET) + '!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
    method: 'POST', body: JSON.stringify({ values: [row] }) });
  return { token, link: publicLink(token), expires };
}

async function listPublicViews() {
  await ensurePublicSheet();
  const values = await sheetsApi('/values/' + encodeURIComponent(quoteSheet(PUBLIC_SHEET) + '!A:F') + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER');
  const today = new Date().toISOString().slice(0, 10);
  return (values.values || []).slice(1).filter((row) => row[0]).map((row) => {
    let expires = row[3] || '';
    if (typeof expires === 'number') expires = serialToDate(expires);
    return { token: String(row[0]), name: String(row[1] || ''), link: publicLink(String(row[0])), expires: String(expires), active: row[4] === 'კი' && !(expires && expires < today) };
  });
}

async function unpublishView(token) {
  const values = await readSheetValues(PUBLIC_SHEET);
  const index = values.findIndex((row, i) => i > 0 && String(row[0]) === String(token));
  if (index < 1) throw new Error('ასეთი საჯარო ბმული ვერ მოიძებნა.');
  await sheetsApi('/values/' + encodeURIComponent(quoteSheet(PUBLIC_SHEET) + '!E' + (index + 1)) + '?valueInputOption=RAW', {
    method: 'PUT', body: JSON.stringify({ values: [['არა']] }) });
  return 'ok';
}

// Google ანგარიშის გარეშე: ასლს Apps Script-ის საჯარო Deploy გვაძლევს
async function getPublicView(token) {
  if (!CONFIG.publicApiUrl) throw new Error('საჯარო Deploy-ის ბმული ჯერ არ არის ჩაწერილი.');
  const response = await fetch(CONFIG.publicApiUrl + '?action=view&token=' + encodeURIComponent(token));
  const body = await response.json();
  if (body.error) throw new Error(body.error);
  body.data.publicInfo = Object.assign({}, body.data.publicInfo, { link: publicLink(token) });
  return body.data;
}

// ---------- Google Drive: პირადი რუკები ----------
// პირადი რუკები ინახება მომხმარებლის საკუთარ Drive-ში, აპის დამალულ საქაღალდეში (appDataFolder):
//   - უფლება drive.appdata: მხოლოდ ამ საიტის საქაღალდე; მომხმარებლის სხვა ფაილებს ვერ ვხედავთ;
//   - ამ საქაღალდეს Google არავისთან აზიარებს: კოლეგები ერთმანეთის რუკებს ვერ ნახავენ;
//   - Sheet-ზე უფლება არ სჭირდება: ვისაც მხოლოდ ნახვა აქვს (ან Sheet საერთოდ არ აქვს), ისიც ინახავს.
// ტოკენი ცალკეა (არა Sheet-ის ტოკენი), ინახება მხოლოდ ამ ჩანართში (sessionStorage) და არსად იგზავნება Google-ის გარდა.
const DRIVE_TOKEN_KEY = 'customMapDriveToken';
const DRIVE_USED_KEY = 'customMapDriveUsed'; // localStorage: ამ ბრაუზერში Drive უკვე დაკავშირებულა (შემდეგზე ავტომატურად ვცდით)
let driveToken = null;
let driveTokenClient = null;
let driveRequest = null; // მიმდინარე დაკავშირების { resolve, reject }

function hasDriveToken() {
  if (driveToken) return true;
  try {
    const stored = JSON.parse(sessionStorage.getItem(DRIVE_TOKEN_KEY) || 'null');
    if (stored && stored.expires > Date.now() + 60000) driveToken = stored.token;
  } catch (error) { /* ბრაუზერი მეხსიერებას არ გვაძლევს */ }
  return !!driveToken;
}
function driveWasUsed() {
  try { return localStorage.getItem(DRIVE_USED_KEY) === '1'; } catch (error) { return false; }
}
// Drive-დან გასვლა ამ ბრაუზერში (ტოკენის დავიწყება; Google-ის ნებართვა რჩება, მოხსნა: myaccount.google.com → უსაფრთხოება)
function forgetDrive() {
  driveToken = null;
  try { sessionStorage.removeItem(DRIVE_TOKEN_KEY); localStorage.removeItem(DRIVE_USED_KEY); } catch (error) { /* არაფერი */ }
}

// დაკავშირება: Google-ის ფანჯარა. ბრაუზერი ფანჯარას მხოლოდ ღილაკზე დაჭერისას გვიხსნის,
// ამიტომ ეს ფუნქცია დაჭერის დამმუშავებელში პირველივე უნდა გამოიძახო (სხვა ლოდინამდე).
function connectDrive() {
  return new Promise((resolve, reject) => {
    if (!CONFIG.clientId) { reject(new Error('Client ID ჯერ არ არის ჩაწერილი.')); return; }
    if (driveRequest) driveRequest.finish(new Error('ახალი მცდელობა დაიწყო.'));
    const request = { finish: (error, token) => {
      if (driveRequest === request) driveRequest = null;
      if (error) reject(error); else resolve(token);
    } };
    driveRequest = request;
    const finish = request.finish;
    loadGoogleScript().then(() => {
      // დამმუშავებლები initTokenClient-ში ერთხელ გადაეცემა და მიმდინარე მოთხოვნას (driveRequest) პასუხობს
      driveTokenClient = driveTokenClient || google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.clientId, scope: CONFIG.driveScope, include_granted_scopes: false,
        callback: (response) => driveTokenResponse(response),
        error_callback: (error) => driveRequest && driveRequest.finish(new Error(error && error.type === 'popup_closed'
          ? 'Google-ის ფანჯარა დაიხურა.' : error && error.type === 'popup_failed_to_open'
            ? 'ბრაუზერმა Google-ის ფანჯარა დაბლოკა: დაუშვი ამ საიტისთვის და სცადე თავიდან.' : 'Drive-თან დაკავშირება ვერ მოხერხდა.')),
      });
      driveTokenClient.requestAccessToken({ prompt: '' });
    }, (error) => finish(error));
  });
}

function driveTokenResponse(response) {
  if (!driveRequest) return;
  if (response.error || !response.access_token) { driveRequest.finish(new Error('Drive-თან დაკავშირება ვერ მოხერხდა' + (response.error ? ': ' + response.error : '.'))); return; }
  if (!google.accounts.oauth2.hasGrantedAllScopes(response, CONFIG.driveScope)) {
    driveRequest.finish(new Error('Google-ის ფანჯარაში Drive-ის ნებართვა არ მოინიშნა. სცადე თავიდან და მონიშნე.'));
    return;
  }
  driveToken = response.access_token;
  try {
    sessionStorage.setItem(DRIVE_TOKEN_KEY, JSON.stringify({ token: driveToken, expires: Date.now() + (Number(response.expires_in) || 3600) * 1000 }));
    localStorage.setItem(DRIVE_USED_KEY, '1');
  } catch (error) { /* არაფერი */ }
  driveRequest.finish(null, driveToken);
}

// Drive API-ის გამოძახება ტოკენით. ვადაგასვლისას: შეცდომა needsDrive (ღილაკით თავიდან დაკავშირება)
async function driveFetch(url, options) {
  if (!hasDriveToken()) throw Object.assign(new Error('Google Drive დაკავშირებული არ არის.'), { needsDrive: true });
  const response = await fetch(url, Object.assign({}, options, {
    headers: Object.assign({ Authorization: 'Bearer ' + driveToken }, (options || {}).headers),
  }));
  if (response.status === 401) {
    driveToken = null;
    try { sessionStorage.removeItem(DRIVE_TOKEN_KEY); } catch (error) { /* არაფერი */ }
    throw Object.assign(new Error('Drive-ის სესიას ვადა გაუვიდა: დააჭირე „Drive-თან დაკავშირება“.'), { needsDrive: true });
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = (body.error && body.error.message) || ('Drive API: ' + response.status);
    if (/has not been used|is disabled|not been enabled/i.test(message)) {
      throw new Error('Google Cloud-ის პროექტში Drive API ჩართული არ არის (APIs & Services → Library → Google Drive API → Enable).');
    }
    throw Object.assign(new Error(message), { status: response.status });
  }
  return response;
}

// ---------- შუამავალი: კოდის ძებნა ms.gov.ge-ზე, რეესტრის გვერდები ----------
async function publicApi(parameters) {
  if (!CONFIG.publicApiUrl) throw new Error('საჯარო Deploy-ის ბმული ჯერ არ არის ჩაწერილი.');
  const response = await fetch(CONFIG.publicApiUrl + '?' + new URLSearchParams(parameters).toString());
  const body = await response.json().catch(() => ({ error: 'შუამავალმა არასწორი პასუხი დააბრუნა (Apps Script-ის ახალი ვერსია ჩასმულია?)' }));
  if (body.error) throw new Error(body.error);
  return body;
}
const searchCode = async (code) => (await publicApi({ action: 'search', code })).data;
const fetchRemote = (url) => publicApi({ action: 'fetch', url });
const fetchPlans = (code) => publicApi({ action: 'plans', code }); // სია + ყველა გეგმის PDF ერთად
const fetchMany = async (urls) => (await publicApi({ action: 'fetchmany', urls: JSON.stringify(urls) })).files; // რამდენიმე PDF ერთად

window.SERVER = { searchCode, fetchRemote, fetchPlans, fetchMany,  getMapData: (fresh) => getMapData(fresh), saveGeometry, saveView, publishView, listPublicViews, unpublishView, getPublicView, signOut,
  hasDriveToken, driveWasUsed, connectDrive, driveFetch, forgetDrive,
  preloadGoogle: () => { loadGoogleScript().catch(() => {}); } }; // „ჩემი რუკების“ გახსნისას: ფანჯარა მერე დაყოვნების გარეშე გაიხსნება
