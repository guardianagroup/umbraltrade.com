'use strict';
/* Robot de Umbral · paso 1: modo simulado (desde el 17-11-2026). Sin cuentas, sin claves y sin dinero.
   En cada pasada lee velas públicas (Binance, Deriv, Hyperliquid), calcula las mismas entradas de tendencia que la web (30 min, 1 h y 4 h,
   con el filtro de la media de 200 velas y, donde están activas, las ampliaciones a +0,5 y +1 vez el riesgo con el stop común) y anota lo
   que haría: cada entrada, con el precio que había al detectarla; cada ampliación; cada salida.
   estado.json solo guarda qué entradas ya se anotaron (lo mismo que las flechas de la web). Lo anotado (precios, salidas, resultados) va en
   eventos/, cifrado con la clave pública del proyecto: solo se lee fuera de GitHub, con la privada. El tamaño de cada operación, los topes
   por grupo y el resultado de la cuenta se calculan al leerlo. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
require('./algo.js'); const A = globalThis.U.algo;
const START = Date.UTC(2026, 10, 17, 21, 30) / 1000;   // 17-11-2026, 16:30 de Bogotá
const G = A.GRAN, HTF = A.WAVE_TF;                     // { M30: 'H4', H1: 'D1', H4: 'D1' }
const H14 = { H1: 1, H4: 1 }, ALL = { M30: 1, H1: 1, H4: 1 };
// los mercados y temporalidades de la web (17-11-2026, ced4559 + 58bc677), con el coste de cada uno (el de los estudios)
const MK = [
  { code: 'BTC', src: 'bn', sym: 'BTCUSDT', g: 'cripto', com: 0.0007, tfs: ['M30', 'H1', 'H4'], adds: H14 },
  { code: 'ETH', src: 'bn', sym: 'ETHUSDT', g: 'cripto', com: 0.001166, tfs: ['M30', 'H1', 'H4'], adds: ALL },
  { code: 'SOL', src: 'bn', sym: 'SOLUSDT', g: 'cripto', com: 0.001, tfs: ['H1', 'H4'], adds: H14 },
  { code: 'XRP', src: 'bn', sym: 'XRPUSDT', g: 'cripto', com: 0.001, tfs: ['H1', 'H4'], adds: H14 },
  { code: 'BNB', src: 'bn', sym: 'BNBUSDT', g: 'cripto', com: 0.001, tfs: ['M30', 'H1', 'H4'], adds: H14 },
  { code: 'DOGE', src: 'bn', sym: 'DOGEUSDT', g: 'cripto', com: 0.001, tfs: ['H1', 'H4'], adds: {} },
  { code: 'ADA', src: 'bn', sym: 'ADAUSDT', g: 'cripto', com: 0.001, tfs: ['M30', 'H1', 'H4'], adds: ALL },
  { code: 'LTC', src: 'bn', sym: 'LTCUSDT', g: 'cripto', com: 0.001, tfs: ['H1', 'H4'], adds: {} },
  { code: 'AVAX', src: 'bn', sym: 'AVAXUSDT', g: 'cripto', com: 0.001, tfs: ['H1', 'H4'], adds: H14 },
  { code: 'LINK', src: 'bn', sym: 'LINKUSDT', g: 'cripto', com: 0.001, tfs: ['H1', 'H4'], adds: H14 },
  { code: 'Oro', src: 'deriv', sym: 'frxXAUUSD', g: 'metal', com: 0.000179, tfs: ['M30', 'H1', 'H4'], adds: ALL },
  { code: 'Plata', src: 'deriv', sym: 'frxXAGUSD', g: 'metal', com: 0.000975, tfs: ['H4'], adds: { H4: 1 } },
  { code: 'WTI', src: 'hl', sym: 'CL', g: 'energia', com: 0.0005, tfs: ['M30', 'H1', 'H4'], adds: {} },
  { code: 'Brent', src: 'hl', sym: 'BRENTOIL', g: 'energia', com: 0.0005, tfs: ['M30', 'H1', 'H4'], adds: { H4: 1 } },
];
const need = m => [...new Set([...m.tfs, ...m.tfs.map(t => HTF[t]), 'D1', 'H4'])];

/* el cálculo, sin entrada ni salida: datos[código][temporalidad] = velas (la última puede estar abierta). Devuelve, para cada entrada
   desde START, su entrada, sus ampliaciones y su salida si ya terminó, y las abiertas. Lo mismo que hace la web en waves(). */
function pasada(datos, NOW, desde) {
  const ev = [], abiertas = [], avisos = [], T0 = desde || START;
  for (const m of MK) {
    const d = datos[m.code]; if (!d) { avisos.push(m.code + ': sin datos'); continue; }
    const closed = tf => (d[tf] || []).filter(k => k.t + G[tf] <= NOW);
    let px = null; for (const tf of ['M30', 'H1', 'H4', 'D1']) { const a = d[tf]; if (a && a.length) { px = a[a.length - 1].c; break; } }
    const zl = []; [['D1', 86400], ['H4', 14400]].forEach(([tf, gg]) => { const c = closed(tf); if (c.length >= 40) A.htfZoneList(c, gg).forEach(z => { z.tf = tf; zl.push(z); }); });
    zl.sort((a, b) => a.t0 - b.t0);
    for (const tf of m.tfs) {
      const g = G[tf], htf = HTF[tf], gH = G[htf], cc = closed(tf), cH = closed(htf);
      if (cc.length < 300 || cH.length < 30) { avisos.push(`${m.code} ${tf}: pocas velas (${cc.length} y ${cH.length})`); continue; }
      const zH = A.zigzag(cH, 3), zL = A.zigzag(cc, 3), hd = A.waveDir(cc, g, cH, zH, gH), K = A.cols(cc), sm = A.sma(K.c, 200), at = A.atr(K, 14);
      A.waveEntries(cc, zL, cH, zH, g, gH).forEach(x => {
        const te = cc[x.e].t + g; if (te < T0) return;
        const mv = sm[x.e], a = at[x.e]; if (!(mv === mv) || !(a > 0)) return;
        const sg = x.up ? 1 : -1, E = cc[x.e].c, s = sg * (E - mv) / a; if (s < -3 || (tf !== 'M30' && s >= 8)) return;   // filtro E92
        const risk = Math.abs(E - x.stop); if (!(risk > 0)) return;
        const tg = A.waveTarget(zl, te, E, x.up, x.tf ? x.tf.ext : null, risk); if (tg) x.beAt = tg.p;   // break-even en el objetivo (E55)
        const key = `${m.code}|${tf}|${te}|${x.up ? 'c' : 'v'}`;
        ev.push({ k: 'entrada', key, m: m.code, g: m.g, tf, up: x.up, te, E, stop: x.stop, beAt: x.beAt == null ? null : x.beAt, s: Math.round(s * 100) / 100, com: m.com, px, at: NOW });
        let ride = null, adds = [];
        if (m.adds[tf]) { const sq = A.waveSeq(cc, zL, hd, x, m.com, 0.5, 2); if (sq) { ride = sq.ride; adds = sq.adds; } } else ride = A.waveRide(cc, zL, hd, x, m.com);
        if (!ride) return;
        adds.forEach(q => ev.push({ k: 'ampliacion', key, n: q.m, ta: cc[q.i].t + g, lv: q.px, stop: q.stop, px, at: NOW }));
        if (ride.done) ev.push({ k: 'salida', key, tx: cc[ride.xi].t + g, ex: ride.ex, stop: ride.stop, R: ride.R, Ra: adds.map(q => q.R), px, at: NOW });
        else abiertas.push({ key, stop: ride.stop, n: adds.length });
      });
    }
  }
  return { ev, abiertas, avisos };
}

/* lo que se anota por primera vez: una entrada, cada ampliación y la salida, una sola vez cada una */
function nuevos(P, st) {
  const out = [];
  for (const e of P.ev) {
    if (e.k === 'entrada') { if (st.vistas[e.key]) continue; st.vistas[e.key] = 1; out.push(e); }
    else if (e.k === 'ampliacion') { const kk = e.key + '|a' + e.n; if (!st.vistas[e.key] || st.vistas[kk]) continue; st.vistas[kk] = 1; out.push(e); }
    else if (e.k === 'salida') { if (st.vistas[e.key] !== 1) continue; st.vistas[e.key] = 2; out.push(e); }
  }
  return out;
}

function cifra(obj, pubPem) {   // AES-256-GCM con una clave al azar, y esa clave cifrada con RSA-OAEP (SHA-256) con la pública
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const d = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const k = crypto.publicEncrypt({ key: pubPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return { v: 1, k: k.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), d: d.toString('base64') };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, opt, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(20000) }, opt || {}));
      if (r.ok) return await r.json();
      if (r.status !== 429 && r.status < 500) throw new Error('HTTP ' + r.status);
    } catch (e) { if (i === tries - 1) throw e; }
    await sleep(1500 * (i + 1));
  }
  throw new Error('sin respuesta');
}
const IV = { M30: '30m', H1: '1h', H4: '4h', D1: '1d' };
async function bn(sym, tf, n) {
  const a = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${IV[tf]}&limit=${n}`);
  return a.map(k => ({ t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}
async function hl(coin, tf, n) {
  const end = Date.now(), start = end - (n + 2) * G[tf] * 1000;
  const a = await getJSON('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin: 'xyz:' + coin, interval: IV[tf], startTime: start, endTime: end } }) });
  return (a || []).map(k => ({ t: Math.floor(k.t / 1000), o: +k.o, h: +k.h, l: +k.l, c: +k.c })).filter(k => k.o > 0 && k.c > 0).slice(-n);
}
function deriv(reqs) {   // una conexión, todas las peticiones de velas; lo que no llegue en 60 s queda como aviso
  return new Promise(res => {
    const out = {}, pend = new Map(); let id = 0, ws;
    const fin = () => { try { ws.close(); } catch (e) { } res(out); };
    const timer = setTimeout(fin, 60000);
    try { ws = new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public'); } catch (e) { clearTimeout(timer); out.error = String(e); return res(out); }
    ws.onopen = () => reqs.forEach(r => { const rid = ++id; pend.set(rid, r); ws.send(JSON.stringify({ ticks_history: r.sym, end: 'latest', count: r.n, style: 'candles', granularity: G[r.tf], req_id: rid })); });
    ws.onmessage = ev => {
      let d; try { d = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
      const r = pend.get(d.req_id); if (!r) return; pend.delete(d.req_id);
      if (d.candles && !d.error) { const c = d.candles.map(k => ({ t: +k.epoch, o: +k.open, h: +k.high, l: +k.low, c: +k.close })); if (c.length && c[0].t % G[r.tf] !== 0) c.shift(); out[r.sym + '|' + r.tf] = c; }
      else out[r.sym + '|' + r.tf + '|error'] = d.error ? d.error.message || d.error.code : 'sin velas';
      if (!pend.size) { clearTimeout(timer); fin(); }
    };
    ws.onerror = () => { out.error = 'conexión'; clearTimeout(timer); fin(); };
  });
}

async function main() {
  const NOW = Math.floor(Date.now() / 1000), datos = {}, avisos = [], t0 = Date.now();
  for (const m of MK.filter(q => q.src !== 'deriv')) {
    datos[m.code] = {};
    for (const tf of need(m)) {
      try { datos[m.code][tf] = m.src === 'bn' ? await bn(m.sym, tf, tf === 'D1' ? 400 : 1000) : await hl(m.sym, tf, tf === 'D1' ? 400 : 1000); }
      catch (e) { avisos.push(`${m.code} ${tf}: ${e.message}`); }
    }
  }
  const dr = MK.filter(q => q.src === 'deriv').flatMap(m => need(m).map(tf => ({ code: m.code, sym: m.sym, tf, n: tf === 'D1' ? 400 : 1000 })));
  const out = await deriv(dr); if (out.error) avisos.push('deriv: ' + out.error);
  dr.forEach(r => { datos[r.code] = datos[r.code] || {}; const c = out[r.sym + '|' + r.tf]; if (c) datos[r.code][r.tf] = c; else avisos.push(`${r.code} ${r.tf}: ${out[r.sym + '|' + r.tf + '|error'] || 'sin respuesta'}`); });
  const P = pasada(datos, NOW);
  const EST = path.join(__dirname, 'estado.json');
  const st = fs.existsSync(EST) ? JSON.parse(fs.readFileSync(EST, 'utf8')) : { v: 1, desde: START, vistas: {} };
  const nv = nuevos(P, st);
  Object.keys(st.vistas).forEach(k => { const te = +k.split('|')[2]; if (te && te < NOW - 200 * 86400) delete st.vistas[k]; });
  st.ultima = new Date(NOW * 1000).toISOString();
  fs.writeFileSync(EST, JSON.stringify(st));
  if (nv.length) {
    const dir = path.join(__dirname, 'eventos'); fs.mkdirSync(dir, { recursive: true });
    const nombre = new Date(NOW * 1000).toISOString().replace(/[-:]/g, '').slice(0, 13) + '.json';
    fs.writeFileSync(path.join(dir, nombre), JSON.stringify(cifra({ at: NOW, ev: nv, avisos: avisos.concat(P.avisos) }, fs.readFileSync(path.join(__dirname, 'pub.pem'), 'utf8'))));
  }
  const n = k => nv.filter(e => e.k === k).length;
  console.log(`pasada ${new Date(NOW * 1000).toISOString()} · ${((Date.now() - t0) / 1000).toFixed(1)} s · nuevas: ${n('entrada')} entradas, ${n('ampliacion')} ampliaciones, ${n('salida')} salidas · abiertas ${P.abiertas.length}`);
  avisos.concat(P.avisos).forEach(a => console.log('aviso: ' + a));
}

module.exports = { pasada, nuevos, cifra, MK, START, need };
if (require.main === module) main().catch(e => { console.error('error:', e && e.stack || e); process.exit(1); });
