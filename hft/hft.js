// Prueba de alta frecuencia, solo simulada (no envía órdenes a ningún bróker).
// Precios: velas de 1 segundo de Binance (últimas 24 h). Costes: spread real de Deriv cTrader (E94, 17-11).
// Busca parámetros en las primeras 12 h y comprueba el mejor en las 12 h siguientes, que no ha visto.
// El resultado se guarda cifrado con la clave pública del proyecto; en el registro de GitHub solo salen recuentos.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const MK = [
  { s: 'BTCUSDT', n: 'BTC', spread: 18.42 },
  { s: 'ETHUSDT', n: 'ETH', spread: 1.60 },
  { s: 'XRPUSDT', n: 'XRP', spread: 0.0011 },
];
const HORAS = 24, NOTIONAL = 650, SALDO = 10000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  let err;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      err = new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    } catch (e) { err = e; }
    await sleep(500 * (i + 1));
  }
  throw err;
}

async function precios(sym, fin) {
  const ini = fin - HORAS * 3600 * 1000, starts = [];
  for (let t = ini; t < fin; t += 1000 * 1000) starts.push(t);
  const res = new Array(starts.length); let i = 0;
  const worker = async () => {
    while (i < starts.length) {
      const k = i++, t = starts[k];
      res[k] = await get(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1s&startTime=${t}&endTime=${Math.min(t + 999 * 1000, fin - 1)}&limit=1000`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const m = new Map();
  for (const a of res) for (const k of a) m.set(k[0], +k[4]);
  const px = []; let last = null;
  for (let t = ini; t < fin; t += 1000) { if (m.has(t)) last = m.get(t); if (last !== null) px.push(last); }
  return { px, velas: m.size };
}

// Una posición cada vez. Señal: movimiento de los últimos k segundos mayor que z veces su desviación típica.
// mom = a favor del movimiento, rev = en contra. Sale a los h segundos. Entra y sale al último precio
// (sin retrasos ni deslizamiento: lo más favorable posible) y paga el spread completo en cada operación.
function sim(px, spread, k, z, h, mo, sig, a, b) {
  let t = Math.max(a, k), n = 0, gross = 0, net = 0, gan = 0;
  const thr = z * sig, d0 = mo === 'mom' ? 1 : -1;
  while (t + h < b) {
    const r = px[t] / px[t - k] - 1;
    if (r !== 0 && Math.abs(r) > thr) {
      const g = d0 * Math.sign(r) * (px[t + h] / px[t] - 1), c = spread / px[t];
      gross += g; net += g - c; n++; if (g - c > 0) gan++;
      t += h;
    } else t++;
  }
  return { n, gross, net, gan };
}

function analiza(m, px, velas) {
  const N = px.length, half = Math.floor(N / 2), precio = px[N - 1];
  const K = [1, 2, 3, 5, 10, 20, 30, 60], Z = [0, 0.5, 1, 2, 3], H = [1, 2, 3, 5, 10, 20, 30, 60, 120], MO = ['mom', 'rev'];
  const sigma = {};
  for (const k of K) {
    let s = 0, s2 = 0, n = 0;
    for (let t = k; t < half; t++) { const r = px[t] / px[t - k] - 1; s += r; s2 += r * r; n++; }
    sigma[k] = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  }
  const filas = [];
  for (const k of K) for (const z of Z) for (const h of H) for (const mo of MO)
    filas.push({ k, z, h, mo, a: sim(px, m.spread, k, z, h, mo, sigma[k], 0, half), b: sim(px, m.spread, k, z, h, mo, sigma[k], half, N) });
  const usd = x => +(x * NOTIONAL).toFixed(2);
  const res = r => ({ n: r.n, bruto: usd(r.gross), neto: usd(r.net), ganadoras: r.n ? +(100 * r.gan / r.n).toFixed(1) : 0 });
  const par = f => ({ k: f.k, z: f.z, h: f.h, mo: f.mo, dentro: res(f.a), fuera: res(f.b) });
  const val = filas.filter(f => f.a.n >= 30);
  const mejor = (sel) => val.reduce((p, f) => sel(f) > sel(p) ? f : p, val[0]);
  const mov = {};
  for (const h of [1, 5, 30, 60, 120]) {
    const arr = [];
    for (let t = 0; t + h < N; t += 7) arr.push(Math.abs(px[t + h] / px[t] - 1));
    arr.sort((x, y) => x - y); mov[h] = +(100 * arr[Math.floor(arr.length / 2)]).toFixed(4);
  }
  // Muchas operaciones: los 10 ajustes con más operaciones en las 12 h vistas, y cómo les fue después
  const muchas = val.slice().sort((x, y) => y.a.n - x.a.n).slice(0, 10).map(par);
  return {
    n: m.n, precio, spread: m.spread, costePct: +(100 * m.spread / precio).toFixed(4), segundos: N, velas, movMedianoPct: mov,
    maxOps: res(sim(px, m.spread, 1, 0, 1, 'mom', sigma[1], 0, N)),
    maxOpsRev: res(sim(px, m.spread, 1, 0, 1, 'rev', sigma[1], 0, N)),
    mejorNeto: par(mejor(f => f.a.net)),
    mejorBruto: par(mejor(f => f.a.gross)),
    top: val.slice().sort((x, y) => y.a.net - x.a.net).slice(0, 8).map(par),
    muchas,
    combinaciones: val.length,
    positivasDentro: val.filter(f => f.a.net > 0).length, positivasFuera: val.filter(f => f.b.net > 0).length,
    positivasBrutoDentro: val.filter(f => f.a.gross > 0).length, positivasBrutoFuera: val.filter(f => f.b.gross > 0).length,
  };
}

function cifra(obj, pubPem) {   // AES-256-GCM con una clave al azar, y esa clave cifrada con RSA-OAEP (SHA-256) con la pública
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const d = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const k = crypto.publicEncrypt({ key: pubPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return { v: 1, k: k.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), d: d.toString('base64') };
}

(async () => {
  const t0 = Date.now(), fin = Math.floor(Date.now() / 1000) * 1000;
  const out = { at: new Date(fin).toISOString(), horas: HORAS, notional: NOTIONAL, saldo: SALDO, mercados: [] };
  for (const m of MK) {
    const { px, velas } = await precios(m.s, fin);
    console.log(m.n, 'segundos', px.length, 'velas', velas, ((Date.now() - t0) / 1000).toFixed(0) + ' s');
    out.mercados.push(analiza(m, px, velas));
  }
  fs.writeFileSync(path.join(__dirname, 'resultado.json'), JSON.stringify(cifra(out, fs.readFileSync(path.join(__dirname, 'pub.pem'), 'utf8'))));
  console.log('hecho en', ((Date.now() - t0) / 1000).toFixed(0), 's');
})().catch(e => { console.error('error:', e.message); process.exit(1); });
