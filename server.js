// Serveur local du radar : sert radar.html et va chercher les avions côté serveur
// (aucun blocage de navigateur, bloqueur de pub ou CORS).
//
//   1. Installez Node.js 18 ou plus récent : https://nodejs.org
//   2. Mettez server.js et radar.html dans le même dossier
//   3. Lancez :   node server.js
//   4. Ouvrez :   http://localhost:3000
//
// Aucune dépendance à installer. La console affiche quelle source répond et combien d'avions.

const http = require('http');
const fs = require('fs');
const path = require('path');

// Le serveur ne doit jamais s'arrêter à cause d'une erreur réseau passagère
process.on('uncaughtException', e => console.log('Erreur ignorée :', e.message));
process.on('unhandledRejection', e => console.log('Erreur ignorée :', (e && e.message) || e));

const PORT = process.env.PORT || 3000;
const FT = 0.3048;

const SOURCES = [
  { name: 'adsb.lol',       url: (la, lo, r) => `https://api.adsb.lol/v2/point/${la}/${lo}/${r}` },
  { name: 'airplanes.live', url: (la, lo, r) => `https://api.airplanes.live/v2/point/${la}/${lo}/${r}` },
  { name: 'adsb.fi',        url: (la, lo, r) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${r}` },
  { name: 'OpenSky',        url: (la, lo, r) => {
      const d = r / 60, e = d / Math.cos(la * Math.PI / 180);
      return `https://opensky-network.org/api/states/all?lamin=${la - d}&lamax=${la + d}&lomin=${lo - e}&lomax=${lo + e}`;
  } }
];

const cache = new Map();   // évite de réinterroger les sources plus d'une fois toutes les 3 s

async function getPlanes(la, lo, r) {
  const key = [la.toFixed(2), lo.toFixed(2), r].join();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 3000) return Object.assign({}, hit.v, { age: Date.now() - hit.t });   // age = ancienneté des données (ms)

  const errors = [];
  for (const s of SOURCES) {
    try {
      const res = await fetch(s.url(la, lo, r), {
        headers: { 'User-Agent': 'radar-local/1.0' },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      let ac = j.ac || j.aircraft || [];
      if (j.states) {      // OpenSky → même format que adsb.lol
        ac = j.states.map(x => ({
          hex: x[0], flight: x[1] || '', lon: x[5], lat: x[6],
          alt_baro: x[8] ? 'ground' : (x[7] || 0) / FT,
          gs: (x[9] || 0) * 1.94384, track: x[10] || 0, t: '',
          seen_pos: Math.max(0, Date.now() / 1000 - (x[3] || Date.now() / 1000))
        }));
      }
      if (!ac.length && s !== SOURCES[SOURCES.length - 1]) { errors.push(`${s.name}: 0 avion`); continue; }
      console.log(new Date().toLocaleTimeString(), '·', s.name, '·', ac.length, 'avions');
      const v = { source: s.name, ac };
      cache.set(key, { t: Date.now(), v });
      return Object.assign({}, v, { age: 0 });
    } catch (e) {
      errors.push(`${s.name}: ${e.message}`);
    }
  }
  console.log('Aucune source disponible →', errors.join(' | '));
  return { source: null, ac: [], errors };
}

// ---------- Origine / destination d'un vol (par indicatif, ex. RYR64BJ) ----------
const routeCache = new Map();

async function getJson(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method, body: opts.body,
    headers: Object.assign({ 'User-Agent': 'radar-local/1.0' }, opts.headers || {}),
    signal: AbortSignal.timeout(7000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
const airport = a => ({
  city: a.location || a.municipality || '',
  name: a.name || a.airport || '',
  iata: a.iata || '', icao: a.icao || '',
  country: String(a.countryiso2 || a.country_code || '').toUpperCase()
});

async function getRoute(callsign, la, lo) {
  const hit = routeCache.get(callsign);
  if (hit && Date.now() - hit.t < hit.ttl) return hit.v;
  let v = null;

  try {   // 1) adsb.lol
    const j = await getJson('https://api.adsb.lol/api/0/routeset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planes: [{ callsign, lat: la, lng: lo }] })
    });
    const a = (Array.isArray(j) ? j[0] : j)?.airports;
    if (a && a.length >= 2) v = { source: 'adsb.lol', origin: airport(a[0]), dest: airport(a[a.length - 1]) };
  } catch (e) { console.log('route adsb.lol', callsign, '→', e.message); }

  if (!v) try {   // 2) hexdb.io
    const j = await getJson('https://hexdb.io/api/v1/route/icao/' + encodeURIComponent(callsign));
    const parts = String(j.route || '').split('-').filter(Boolean);
    if (parts.length >= 2) {
      const get = icao => getJson('https://hexdb.io/api/v1/airport/icao/' + icao).catch(() => ({ icao }));
      const [o, d] = await Promise.all([get(parts[0]), get(parts[parts.length - 1])]);
      v = { source: 'hexdb', origin: airport(o), dest: airport(d) };
    }
  } catch (e) { console.log('route hexdb', callsign, '→', e.message); }

  if (v) console.log(callsign, ':', v.origin.iata || v.origin.icao, '→', v.dest.iata || v.dest.icao, '(' + v.source + ')');
  const out = v || { source: null };
  routeCache.set(callsign, { t: Date.now(), ttl: v ? 3600000 : 120000, v: out });   // vols inconnus : on réessaie après 2 min
  return out;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/api/route') {
    const cs = (u.searchParams.get('callsign') || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(cs)) { res.writeHead(400); return res.end('indicatif invalide'); }
    const v = await getRoute(cs, parseFloat(u.searchParams.get('lat')) || 0, parseFloat(u.searchParams.get('lon')) || 0);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(v));
  }

  if (u.pathname === '/api/planes') {
    const la = parseFloat(u.searchParams.get('lat'));
    const lo = parseFloat(u.searchParams.get('lon'));
    const r = Math.min(250, Math.max(5, parseInt(u.searchParams.get('r'), 10) || 50));
    if (Number.isNaN(la) || Number.isNaN(lo)) { res.writeHead(400); return res.end('lat/lon invalides'); }
    const v = await getPlanes(la, lo, r);
    res.writeHead(v.source ? 200 : 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(v));
  }

  const STATIC = {   // fichiers de l'application mobile (installable depuis le téléphone)
    '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'text/javascript',
    '/icon-192.png': 'image/png', '/icon-512.png': 'image/png'
  };
  if (STATIC[u.pathname]) {
    return fs.readFile(path.join(__dirname, u.pathname.slice(1)), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': STATIC[u.pathname], 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  if (u.pathname === '/' || u.pathname === '/radar.html') {
    return fs.readFile(path.join(__dirname, 'radar.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('radar.html introuvable : mettez-le à côté de server.js'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  res.writeHead(404);
  res.end('Not found');
}).listen(PORT, () => console.log(`Radar prêt : http://localhost:${PORT}`));
