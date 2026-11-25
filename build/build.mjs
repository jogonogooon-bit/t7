// Bereitet offene Daten pro Rasterzelle auf und verschlüsselt jede Zelle mit dem öffentlichen
// Schlüssel (ECDH P-256 + HKDF + AES-GCM). Lesbar nur mit dem privaten Schlüssel in index.html.
//
//   node build/build.mjs --out data --osm f.geojsonseq [--zensus z.csv] [--bnetza b.csv] [--gtfs dir]
//
// Quellen: OpenStreetMap (ODbL), Zensus 2022 (dl-de/by-2-0), Ladesäulenregister BNetzA (CC BY 4.0),
// Fahrplandaten GTFS (gtfs.de, CC BY 4.0).
import { webcrypto as crypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const PUB = 'BMUw/I2PcV86M2IeV+CpMdQVLmzqYtW6uhrZDV8OYKTheFHtfpKBY0H9Ig5y0l28VD4Yp0eprMmud0USda5Onj8=';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const OUT = args.out || 'data';
const GRID = { lat0: 47.2, lon0: 5.8, dLat: 0.2, dLon: 0.3, nLat: 40, nLon: 31 };
const PAD = 0.012;
const KEEP = /^(name|operator|brand|opening_hours|capacity|capacity:hgv|beds|rooms|employees|population|amenity|shop|landuse|man_made|industrial|building|building:flats|railway|station|train|public_transport|highway|tourism|leisure|natural|place|social_facility|hgv|park_ride|access|vending|self_service|automated|socket:.*|addr:(street|housenumber|postcode|city)|website|description|check_date|check_date:opening_hours|survey:date|isced:level|school|school:de|military|aeroway|office|sport|students)$/;
const SHOP = /^(supermarket|convenience|kiosk|bakery|pastry|beverages|variety_store|deli|butcher|farm|laundry|food|general|car_repair|car)$/;
const AMEN = /^(hospital|nursing_home|charging_station|bus_station|police|fire_station|university|college|car_wash|vending_machine|fuel|fast_food|restaurant|cafe|bar|pub|biergarten|nightclub|cinema|canteen|ice_cream|school|clinic|townhall|theatre|events_venue|conference_centre|exhibition_centre|ferry_terminal)$/;
const LOGI_RX = /logisti|spedition|transport|lager|distribution|fulfil|paket|parcel|hub|umschlag|dhl|amazon|hermes|dpd|gls|ups|fedex|rhenus|dachser|schenker|kühne|kuehne|fiege|nagel|hellmann|zentrallager/i;
const FOOD_RX = /fleisch|schlacht|wurst|molkerei|käserei|futter|food|lebensmittel|backwaren|großbäckerei|geflügel|tiefkühl|brauerei/i;
// Planungs-Richtwerte: m² Geschossfläche je Arbeitsplatz, Standard-Geschosse, Anteil Schicht-/Nachtarbeit
const JOBS = {
  office: [30, 3, 0.05], commercial: [40, 2, 0.1], industrial: [100, 1, 0.5], factory: [90, 1, 0.55],
  manufacture: [90, 1, 0.55], warehouse: [200, 1, 0.6], hangar: [300, 1, 0.3],
};

function wanted(t, type) {
  if (t.landuse === 'industrial' || t.landuse === 'allotments' || t.man_made === 'works' || t.industrial) return true;
  if (/^(warehouse|industrial|factory|manufacture)$/.test(t.building || '') && t.name) return true;
  if (AMEN.test(t.amenity || '')) return true;
  if (t.amenity === 'social_facility' && /nursing_home|assisted_living/.test(t.social_facility || '')) return true;
  if (t.amenity === 'parking' && (/^(yes|designated)$/.test(t.hgv || '') || (t.park_ride && t.park_ride !== 'no'))) return true;
  if (SHOP.test(t.shop || '')) return true;
  if (/^(station|halt)$/.test(t.railway || '')) return true;
  if (/^(rest_area|services)$/.test(t.highway || '')) return true;
  if (/^(hotel|motel|hostel|guest_house|camp_site|caravan_site)$/.test(t.tourism || '')) return true;
  if (/^(fitness_centre|swimming_area|water_park|marina|beach_resort|sports_centre|stadium|ice_rink|sports_hall|bowling_alley|trampoline_park)$/.test(t.leisure || '')) return true;
  if (t.natural === 'beach' || t.building === 'dormitory' || t.military === 'barracks' || t.aeroway === 'terminal') return true;
  if (/^(government|employment_agency)$/.test(t.office || '')) return true;
  if (type === 'node' && /^(village|hamlet|suburb|quarter|neighbourhood)$/.test(t.place || '')) return true;
  return false;
}
function bounds(g) {
  let s = 90, w = 180, n = -90, e = -180;
  const walk = (c) => { if (typeof c[0] === 'number') { if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1]; if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; } else c.forEach(walk); };
  walk(g.coordinates);
  return [s, w, n, e];
}
function ringArea(r) {
  if (!r || r.length < 4) return 0;
  const k = Math.cos((r[0][1] * Math.PI) / 180) * 111320; let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * k) * (r[i][1] * 110540) - (r[i][0] * k) * (r[j][1] * 110540);
  return Math.abs(a / 2);
}
function polyArea(g) {
  if (g.type === 'Polygon') return Math.max(0, ringArea(g.coordinates[0]) - g.coordinates.slice(1).reduce((s, h) => s + ringArea(h), 0));
  if (g.type === 'MultiPolygon') return g.coordinates.reduce((s, p) => s + Math.max(0, ringArea(p[0]) - p.slice(1).reduce((x, h) => x + ringArea(h), 0)), 0);
  if (g.type === 'LineString') { const c = g.coordinates; const f = c[0], l = c[c.length - 1]; return f && l && f[0] === l[0] && f[1] === l[1] ? ringArea(c) : 0; }
  return 0;
}
const inGrid = (y, x) => y >= GRID.lat0 && y < GRID.lat0 + GRID.dLat * GRID.nLat && x >= GRID.lon0 && x < GRID.lon0 + GRID.dLon * GRID.nLon;
const cellOf = (y, x) => `${Math.floor((y - GRID.lat0) / GRID.dLat)}_${Math.floor((x - GRID.lon0) / GRID.dLon)}`;
const C = new Map(); // Zelle -> {els, pop, jobs, ev, tr}
const cell = (id) => { let c = C.get(id); if (!c) C.set(id, (c = { els: [], pop: [], jobs: [], ev: [], tr: [] })); return c; };
function padCells(y, x) {
  const out = [];
  const i0 = Math.floor((y - PAD - GRID.lat0) / GRID.dLat), i1 = Math.floor((y + PAD - GRID.lat0) / GRID.dLat);
  const j0 = Math.floor((x - PAD - GRID.lon0) / GRID.dLon), j1 = Math.floor((x + PAD - GRID.lon0) / GRID.dLon);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (i >= 0 && j >= 0 && i < GRID.nLat && j < GRID.nLon) out.push(`${i}_${j}`);
  return out;
}
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
async function* lines(file, enc = 'utf8') {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: enc }), crlfDelay: Infinity });
  for await (const l of rl) yield l;
}
function splitCsv(line, sep) {
  if (line.indexOf('"') < 0) return line.split(sep);
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === sep) { out.push(cur); cur = ''; } else cur += c; }
  out.push(cur); return out;
}

/* ---------------------------------------------------------------- 1) OpenStreetMap */
const jobB = new Map(); let n = 0, kept = 0, bld = 0;
if (args.osm) {
  const seen = new Set();
  for await (let line of lines(args.osm)) {
    line = line.replace(/^\x1e/, '').trim(); if (!line) continue;
    n++;
    let f; try { f = JSON.parse(line); } catch { continue; }
    const p = f.properties || {}; const type = p['@type']; const id = p['@id'];
    if (!type || id == null || !f.geometry) continue;
    const tags = {}; for (const k in p) if (k[0] !== '@') tags[k] = p[k];
    const g = f.geometry; const k = type[0] + id;
    // Arbeitsplatz-Raster aus Gebäudeflächen
    const jb = JOBS[tags.building];
    if (jb && g.type !== 'Point' && !seen.has('B' + k)) {
      seen.add('B' + k);
      const area = polyArea(g);
      if (area >= 100) {
        const B = bounds(g); const y = (B[0] + B[2]) / 2, x = (B[1] + B[3]) / 2;
        const lv = Math.min(20, Math.max(1, num(tags['building:levels']) || jb[1]));
        const jobs = (area * lv) / jb[0];
        let sh = jb[2]; const nm = `${tags.name || ''} ${tags.operator || ''}`;
        if (LOGI_RX.test(nm)) sh = 0.85; else if (FOOD_RX.test(nm)) sh = 0.8;
        const bk = `${Math.floor(y / 0.0025)}_${Math.floor(x / 0.004)}`;
        let b = jobB.get(bk); if (!b) jobB.set(bk, (b = { j: 0, s: 0, y: 0, x: 0 }));
        b.j += jobs; b.s += jobs * sh; b.y += y * jobs; b.x += x * jobs; bld++;
      }
    }
    if (!wanted(tags, type) || seen.has(k)) continue;
    let y, x, a = 0, b = null;
    if (g.type === 'Point') { x = g.coordinates[0]; y = g.coordinates[1]; }
    else {
      const B = bounds(g); y = (B[0] + B[2]) / 2; x = (B[1] + B[3]) / 2;
      b = B.map((v) => +v.toFixed(6));
      const pa = polyArea(g);
      a = Math.round(pa > 0 ? pa : (B[2] - B[0]) * 110540 * (B[3] - B[1]) * 111320 * Math.cos((y * Math.PI) / 180) * 0.6);
    }
    if (!inGrid(y, x)) continue;
    seen.add(k);
    const t = {}; for (const key in tags) if (KEEP.test(key)) t[key] = String(tags[key]).slice(0, 200);
    const el = { k, y: +y.toFixed(6), x: +x.toFixed(6), a, b, t };
    for (const id2 of padCells(y, x)) cell(id2).els.push(el);
    kept++;
  }
  for (const b of jobB.values()) {
    if (b.j < 3) continue;
    const y = b.y / b.j, x = b.x / b.j; if (!inGrid(y, x)) continue;
    cell(cellOf(y, x)).jobs.push(Math.round(y * 1e5), Math.round(x * 1e5), Math.round(b.j), Math.round((100 * b.s) / b.j));
  }
  console.log(`OSM: ${n} Objekte gelesen, ${kept} behalten, ${bld} Gewerbegebäude -> ${jobB.size} Arbeitsplatz-Kacheln`);
}

/* ------------------------------------------------------------ 2) Zensus 2022 (100 m) */
const laea3035 = (() => {
  const a = 6378137, e2 = 0.00669438002290, e = Math.sqrt(e2), R = Math.PI / 180;
  const q = (s) => (1 - e2) * (s / (1 - e2 * s * s) - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s)));
  const qp = q(1), p1 = 52 * R, l0 = 10 * R, s1 = Math.sin(p1);
  const b1 = Math.asin(q(s1) / qp), Rq = a * Math.sqrt(qp / 2);
  const m1 = Math.cos(p1) / Math.sqrt(1 - e2 * s1 * s1), D = (a * m1) / (Rq * Math.cos(b1));
  const c1 = e2 / 3 + 31 * e2 * e2 / 180 + 517 * e2 ** 3 / 5040, c2 = 23 * e2 * e2 / 360 + 251 * e2 ** 3 / 3780, c3 = 761 * e2 ** 3 / 45360;
  return (x, y) => {
    const xx = x - 4321000, yy = y - 3210000; const rho = Math.hypot(xx / D, D * yy);
    if (rho < 1e-9) return [52, 10];
    const Cc = 2 * Math.asin(rho / (2 * Rq));
    const bb = Math.asin(Math.cos(Cc) * Math.sin(b1) + (D * yy * Math.sin(Cc) * Math.cos(b1)) / rho);
    const lam = l0 + Math.atan2(xx * Math.sin(Cc), D * rho * Math.cos(b1) * Math.cos(Cc) - D * D * yy * Math.sin(b1) * Math.sin(Cc));
    return [(bb + c1 * Math.sin(2 * bb) + c2 * Math.sin(4 * bb) + c3 * Math.sin(6 * bb)) / R, lam / R];
  };
})();
if (args.zensus && fs.existsSync(args.zensus)) {
  let hdr = null, ix = {}, sep = ';', rows = 0, sum = 0, res = 100;
  for await (const line of lines(args.zensus)) {
    if (!hdr) {
      if (!/einwohner/i.test(line)) continue;
      sep = line.includes(';') ? ';' : ',';
      hdr = splitCsv(line, sep).map((s) => s.trim().replace(/^﻿/, '').toLowerCase());
      const fi = (rx) => hdr.findIndex((h) => rx.test(h));
      ix = { id: fi(/gitter_id/), x: fi(/^x_mp/), y: fi(/^y_mp/), ew: fi(/einwohner/) };
      const m = hdr.join(' ').match(/(100m|1km)/); if (m) res = m[1] === '100m' ? 100 : 1000;
      continue;
    }
    const c = line.split(sep); const ew = parseInt(c[ix.ew], 10); if (!(ew > 0)) continue;
    let x, y;
    if (ix.x >= 0 && ix.y >= 0) { x = +c[ix.x]; y = +c[ix.y]; } else { const m = String(c[ix.id]).match(/N(\d+)E(\d+)/); if (!m) continue; y = +m[1] + res / 2; x = +m[2] + res / 2; }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const [lat, lon] = laea3035(x, y); if (!inGrid(lat, lon)) continue;
    cell(cellOf(lat, lon)).pop.push(Math.round(lat * 1e5), Math.round(lon * 1e5), ew); rows++; sum += ew;
  }
  console.log(`Zensus: ${rows} Gitterzellen (${res} m), ${sum} Einwohner`);
}

/* ------------------------------------------------------- 3) Ladesäulenregister BNetzA */
if (args.bnetza && fs.existsSync(args.bnetza)) {
  const head = fs.readFileSync(args.bnetza).subarray(0, 200000);
  let enc = 'utf8'; try { new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - 4)); } catch { enc = 'latin1'; }
  let hdr = null, ix = {}, sep = ';', rows = 0; const parks = new Map();
  for await (const line of lines(args.bnetza, enc)) {
    if (!hdr) {
      if (/breitengrad/i.test(line) && /l(ä|ae)ngengrad/i.test(line)) {
        sep = (line.match(/;/g) || []).length >= (line.match(/,/g) || []).length ? ';' : ',';
        hdr = splitCsv(line, sep).map((s) => s.trim().replace(/^﻿/, ''));
        const fi = (rx) => hdr.findIndex((h) => rx.test(h));
        ix = { lat: fi(/^breitengrad/i), lon: fi(/^l(ä|ae)ngengrad/i), op: fi(/^betreiber/i), name: fi(/anzeigename/i), street: fi(/^stra(ß|ss)e/i), hn: fi(/^hausnummer/i), plz: fi(/^postleitzahl/i), ort: fi(/^ort$/i), kw: fi(/nennleistung ladeeinrichtung/i), n: fi(/anzahl ladepunkte/i), art: fi(/art der lade/i), status: fi(/^status/i), oh: fi(/öffnungszeiten/i) };
      }
      continue;
    }
    const c = splitCsv(line, sep); const g = (k) => (ix[k] >= 0 ? (c[ix[k]] || '').trim() : '');
    const lat = num(g('lat')), lon = num(g('lon'));
    if (!lat || !lon || !inGrid(lat, lon)) continue;
    if (g('status') && (/au(ß|ss)er|stillgelegt|geplant|planung/i.test(g('status')) || !/betrieb/i.test(g('status')))) continue;
    const key = (g('street') ? [g('op'), g('street'), g('hn'), g('plz')].join('|') : `${lat.toFixed(4)},${lon.toFixed(4)}`).toLowerCase();
    let p = parks.get(key);
    if (!p) parks.set(key, (p = { y: 0, x: 0, c: 0, pts: 0, kw: 0, fast: 0, op: g('op'), name: g('name'), addr: [`${g('street')} ${g('hn')}`.trim(), `${g('plz')} ${g('ort')}`.trim()].filter(Boolean).join(', '), oh: g('oh') }));
    p.y += lat; p.x += lon; p.c++; p.pts += num(g('n')) || 1;
    const kw = num(g('kw')) || 0; p.kw = Math.max(p.kw, kw); if (kw >= 50 || /schnell/i.test(g('art'))) p.fast = 1;
    rows++;
  }
  for (const p of parks.values()) {
    const y = p.y / p.c, x = p.x / p.c;
    const rec = [+y.toFixed(6), +x.toFixed(6), p.pts, Math.round(p.kw), p.fast, p.op.slice(0, 80), p.name.slice(0, 80), p.addr.slice(0, 120), p.oh.slice(0, 80)];
    for (const id2 of padCells(y, x)) cell(id2).ev.push(rec);
  }
  console.log(`Ladesäulenregister: ${hdr ? rows + ' Ladeeinrichtungen in ' + parks.size + ' Parks' : 'KEINE Kopfzeile gefunden'}`);
}

/* --------------------------------------------- 4) Fahrplan (GTFS): Abfahrten je Station */
if (args.gtfs && fs.existsSync(path.join(args.gtfs, 'stop_times.txt'))) {
  const G = args.gtfs;
  const csvRead = async (file, fn) => { let h = null; for await (const l of lines(path.join(G, file))) { const c = splitCsv(l, ','); if (!h) { h = c.map((s) => s.trim().replace(/^﻿/, '')); continue; } const o = {}; h.forEach((k, i) => { o[k] = c[i]; }); fn(o); } };
  // Werktag: Dienste, die mittwochs fahren
  const svc = new Set();
  if (fs.existsSync(path.join(G, 'calendar.txt'))) await csvRead('calendar.txt', (o) => { if (o.wednesday === '1') svc.add(o.service_id); });
  const routeType = new Map(); await csvRead('routes.txt', (o) => routeType.set(o.route_id, +o.route_type));
  const trip = new Map(); // trip_id -> rail?
  await csvRead('trips.txt', (o) => { if (!svc.size || svc.has(o.service_id)) { const rt = routeType.get(o.route_id); trip.set(o.trip_id, rt === 2 || (rt >= 100 && rt < 200) || rt === 1 || (rt >= 400 && rt < 500) ? 1 : 0); } });
  const stops = new Map(); // stop_id -> {lat, lon, name, parent}
  await csvRead('stops.txt', (o) => stops.set(o.stop_id, { y: num(o.stop_lat), x: num(o.stop_lon), name: o.stop_name || '', parent: o.parent_station || '' }));
  const dep = new Map(); let st = 0;
  let h = null, iT, iS, iD;
  for await (const l of lines(path.join(G, 'stop_times.txt'))) {
    const c = l.split(',');
    if (!h) { h = c.map((s) => s.trim().replace(/^﻿/, '')); iT = h.indexOf('trip_id'); iS = h.indexOf('stop_id'); iD = h.indexOf('departure_time'); continue; }
    const tid = c[iT].replace(/"/g, ''); const rail = trip.get(tid); if (rail === undefined) continue;
    let sid = c[iS].replace(/"/g, ''); const s = stops.get(sid); if (s && s.parent) sid = s.parent;
    let d = dep.get(sid); if (!d) dep.set(sid, (d = { n: 0, night: 0, rail: 0 }));
    d.n++; if (rail) d.rail++;
    const hh = parseInt((c[iD] || '').replace(/"/g, ''), 10) % 24; if (hh >= 22 || hh < 5) d.night++;
    st++;
  }
  // Haltepunkte gleichen Namens im Umkreis zusammenfassen
  const merged = new Map();
  for (const [sid, d] of dep) {
    const s = stops.get(sid); if (!s || !s.y || !inGrid(s.y, s.x)) continue;
    const key = `${s.name.toLowerCase()}|${Math.round(s.y * 200)}|${Math.round(s.x * 120)}`;
    let m = merged.get(key); if (!m) merged.set(key, (m = { y: 0, x: 0, w: 0, n: 0, night: 0, rail: 0, name: s.name }));
    m.y += s.y * d.n; m.x += s.x * d.n; m.w += d.n; m.n += d.n; m.night += d.night; m.rail += d.rail;
  }
  let cnt = 0;
  for (const m of merged.values()) {
    if (m.n < 20) continue;
    const y = m.y / m.w, x = m.x / m.w;
    const rec = [+y.toFixed(5), +x.toFixed(5), m.n, m.night, m.rail, m.name.slice(0, 60)];
    for (const id2 of padCells(y, x)) cell(id2).tr.push(rec);
    cnt++;
  }
  console.log(`GTFS: ${st} Halte (Werktag), ${cnt} Stationen mit >= 20 Abfahrten`);
}

/* --------------------------------------------------------------- Verschlüsseln & schreiben */
const pub = await crypto.subtle.importKey('raw', Buffer.from(PUB, 'base64'), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
async function seal(bytes) {
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256);
  const hk = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('radar-cell-v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const epub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  return Buffer.concat([Buffer.from(epub), Buffer.from(iv), Buffer.from(ct)]);
}
const ts = Date.now();
fs.mkdirSync(path.join(OUT, 'c'), { recursive: true });
const src = { osm: !!args.osm, zensus: [...C.values()].some((c) => c.pop.length), bnetza: [...C.values()].some((c) => c.ev.length), gtfs: [...C.values()].some((c) => c.tr.length), jobs: jobB.size > 0 };
const manifest = { v: 2, ts, src, cells: {} };
for (const [id, c] of C) {
  if (!c.els.length && !c.pop.length && !c.jobs.length && !c.ev.length && !c.tr.length) continue;
  manifest.cells[id] = c.els.length;
  const rec = { ts, els: c.els };
  if (c.pop.length) rec.pop = c.pop; if (c.jobs.length) rec.jobs = c.jobs; if (c.ev.length) rec.ev = c.ev; if (c.tr.length) rec.tr = c.tr;
  fs.writeFileSync(path.join(OUT, 'c', id + '.bin'), await seal(gzipSync(Buffer.from(JSON.stringify(rec)), { level: 9 })));
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));
console.log(`Quellen: ${JSON.stringify(src)} · ${Object.keys(manifest.cells).length} Zellen geschrieben`);
