// Liest GeoJSON-Seq (osmium export) von stdin, bereitet Objekte pro Rasterzelle auf
// und verschlüsselt jede Zelle mit dem öffentlichen Schlüssel (ECDH P-256 + HKDF + AES-GCM).
// Nur der Besitzer des privaten Schlüssels (steckt verschlüsselt in index.html) kann die Daten lesen.
import { webcrypto as crypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const PUB = 'BMUw/I2PcV86M2IeV+CpMdQVLmzqYtW6uhrZDV8OYKTheFHtfpKBY0H9Ig5y0l28VD4Yp0eprMmud0USda5Onj8=';
const OUT = process.argv[2] || 'site/data';
const GRID = { lat0: 47.2, lon0: 5.8, dLat: 0.2, dLon: 0.3, nLat: 40, nLon: 31 };
const PAD = 0.012;
const KEEP = /^(name|operator|brand|opening_hours|capacity|capacity:hgv|beds|rooms|employees|population|amenity|shop|landuse|man_made|industrial|building|building:flats|railway|station|train|public_transport|highway|tourism|leisure|natural|place|social_facility|hgv|park_ride|access|vending|self_service|automated|socket:.*|addr:(street|housenumber|postcode|city)|website|description|check_date|check_date:opening_hours|survey:date)$/;
const SHOP = /^(supermarket|convenience|kiosk|bakery|pastry|beverages|variety_store|deli|butcher|farm|laundry|food|general)$/;
const AMEN = /^(hospital|nursing_home|charging_station|bus_station|police|fire_station|university|college|car_wash|vending_machine|fuel|fast_food|restaurant|cafe|bar|pub|biergarten|nightclub|cinema|canteen|ice_cream)$/;

function wanted(t, type) {
  if (t.landuse === 'industrial' || t.man_made === 'works' || t.industrial) return true;
  if (/^(warehouse|industrial|factory|manufacture)$/.test(t.building || '') && t.name) return true;
  if (AMEN.test(t.amenity || '')) return true;
  if (t.amenity === 'social_facility' && /nursing_home|assisted_living/.test(t.social_facility || '')) return true;
  if (t.amenity === 'parking' && (/^(yes|designated)$/.test(t.hgv || '') || (t.park_ride && t.park_ride !== 'no'))) return true;
  if (SHOP.test(t.shop || '')) return true;
  if (/^(station|halt)$/.test(t.railway || '')) return true;
  if (/^(rest_area|services)$/.test(t.highway || '')) return true;
  if (/^(hotel|motel|hostel|guest_house|camp_site|caravan_site)$/.test(t.tourism || '')) return true;
  if (/^(fitness_centre|swimming_area|water_park|marina|beach_resort)$/.test(t.leisure || '')) return true;
  if (t.natural === 'beach' || t.building === 'dormitory') return true;
  if (type === 'node' && /^(village|hamlet|suburb|quarter|neighbourhood)$/.test(t.place || '')) return true;
  return false;
}
function bounds(g) {
  let s = 90, w = 180, n = -90, e = -180;
  const walk = (c) => { if (typeof c[0] === 'number') { if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1]; if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; } else c.forEach(walk); };
  walk(g.coordinates);
  return [s, w, n, e];
}
const cellId = (i, j) => `${i}_${j}`;

const cells = new Map(); const seen = new Set(); let n = 0, kept = 0;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (let line of rl) {
  line = line.replace(/^\x1e/, '').trim(); if (!line) continue;
  n++;
  let f; try { f = JSON.parse(line); } catch { continue; }
  const p = f.properties || {}; const type = p['@type']; const id = p['@id'];
  if (!type || id == null || !f.geometry) continue;
  const tags = {}; for (const k in p) if (k[0] !== '@') tags[k] = p[k];
  if (!wanted(tags, type)) continue;
  const k = type[0] + id;
  if (seen.has(k)) continue;
  const g = f.geometry; let y, x, a = 0, b = null;
  if (g.type === 'Point') { x = g.coordinates[0]; y = g.coordinates[1]; }
  else {
    const B = bounds(g); y = (B[0] + B[2]) / 2; x = (B[1] + B[3]) / 2;
    b = B.map((v) => +v.toFixed(6));
    const raw = (B[2] - B[0]) * 110540 * (B[3] - B[1]) * 111320 * Math.cos((y * Math.PI) / 180);
    a = Math.round(raw * (tags.landuse ? 0.6 : type === 'relation' ? 0.5 : 0.75));
  }
  if (!(y >= GRID.lat0 && y < GRID.lat0 + GRID.dLat * GRID.nLat && x >= GRID.lon0 && x < GRID.lon0 + GRID.dLon * GRID.nLon)) continue;
  seen.add(k);
  const t = {}; for (const key in tags) if (KEEP.test(key)) t[key] = String(tags[key]).slice(0, 200);
  const el = { k, y: +y.toFixed(6), x: +x.toFixed(6), a, b, t };
  const i0 = Math.floor((y - PAD - GRID.lat0) / GRID.dLat), i1 = Math.floor((y + PAD - GRID.lat0) / GRID.dLat);
  const j0 = Math.floor((x - PAD - GRID.lon0) / GRID.dLon), j1 = Math.floor((x + PAD - GRID.lon0) / GRID.dLon);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    if (i < 0 || j < 0 || i >= GRID.nLat || j >= GRID.nLon) continue;
    const id2 = cellId(i, j); let arr = cells.get(id2); if (!arr) cells.set(id2, (arr = [])); arr.push(el);
  }
  kept++;
}

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
const manifest = { v: 1, ts, cells: {} };
for (let i = 0; i < GRID.nLat; i++) for (let j = 0; j < GRID.nLon; j++) {
  const id = cellId(i, j); const els = cells.get(id) || [];
  if (!els.length) continue;
  manifest.cells[id] = els.length;
  const bin = await seal(gzipSync(Buffer.from(JSON.stringify({ ts, els })), { level: 9 }));
  fs.writeFileSync(path.join(OUT, 'c', id + '.bin'), bin);
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));
console.log(`gelesen ${n}, behalten ${kept}, Zellen mit Daten ${[...cells.keys()].length}`);
