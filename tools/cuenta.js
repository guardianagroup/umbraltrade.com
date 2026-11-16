/* Cuenta del algoritmo de Umbral Trade: una cuenta ficticia de 50 $ que opera sola con reglas fijas y deja cada operación a la vista.
   Uso:  node tools/cuenta.js datos/cuenta.json                  (lo ejecuta cada 15 minutos .github/workflows/cuenta.yml)
         node tools/cuenta.js estado.json --velas velas.json --ahora 1763337600   (sin red, para las pruebas)
   Versión 2 (16-11-2026): opera todos los mercados de Deriv que no son sintéticos (forex, metales, índices y cripto), en velas de 4 h.
   - Dos estrategias. «tortuga»: rotura de canal (cierre por encima del máximo o por debajo del mínimo de las 55 velas anteriores),
     stop a 2 ATR(20), suma una unidad cada 0,5 ATR a favor hasta 4 y sale cuando una vela cierra al otro lado del canal de 20.
     «giro» (las flechas): vela extrema tras un estiramiento (fuera de Bollinger o RSI 30/70, mínimo o máximo de 20 velas) confirmada
     por un cierre más allá de la vela anterior; stop 0,25 ATR más allá del extremo, take profit a 1,5 ATR y, como tarde, sale a las 40 velas.
   - Cada familia opera la estrategia que mejor le fue en el estudio (cripto y metales, tortuga; forex e índices, giro) con un nivel:
     «validada» arriesga el 0,5 % del saldo por unidad; «prueba», el 0,1 %; «apagada» y «observa» no operan. Todas las señales de las
     dos estrategias se miden en todos los mercados como si se operaran; con 30 señales de una familia, si la media es de +0,10 R o más
     con t ≥ 2 pasa a validada, y si t ≤ −2 se apaga. Queda escrito en el registro.
   - Riesgo abierto: 2 % como máximo en lo validado y 1 % en lo que está en prueba; en prueba, 3 operaciones por familia; en forex,
     2 por divisa. No abre más si pierde el 3 % en el día o el 6 % en la semana; se pausa si cae un 30 % desde su máximo.
   - Los stops, los take profit y los añadidos son órdenes que esperan en el bróker: se ejecutan a su precio aunque la tarea pase más
     tarde (se comprueban con velas de 5 minutos). Las entradas y las salidas por señal se hacen al precio del momento en que corre la
     tarea. Con el mercado cerrado no entra ni sale: espera a que abra, y una señal caduca cuando cierra la vela siguiente. Si la tarea
     llega más de una hora después del cierre de la vela con el mercado abierto, no entra (esa entrada ya no sería la de la señal).
   - Binarias: solo si una estrategia acierta el 58 % o más en una familia con el límite inferior por encima del 52,6 % (100 señales).
   Cada operación cerrada lleva una huella encadenada (SHA-256): cambiar una operación antigua rompe todas las siguientes. */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

/* Comisión de cada mercado, como fracción del tamaño de la posición. Con multiplicador en Deriv, la que cobraba el 16-11-2026 (medida con
   su API); sin multiplicador (m: 0: índices, cruces menores, platino y paladio) solo hay CFD en MT5 y se pone un diferencial prudente. */
const mk = (group, lista, extra) => lista.map(x => Object.assign({ code: x[0], name: x[1], group: group, dec: x[2], rate: x[3], mult: x[4] !== 0 }, extra || {}, x[5] || {}));
const CFG = {
  v: 2, saldo0: 50, gran: 14400, m5: 300,
  entrada: 55, salida: 20, stopN: 2, paso: 0.5, maxUnidades: 4,
  giro: { stop: 0.25, objetivo: 1.5, velas: 40 },
  riesgo: { validada: 0.005, prueba: 0.001 }, riesgoMax: 0.02, riesgoPrueba: 0.01, porFamilia: 3, porDivisa: 2,
  diaStop: 0.03, semanaStop: 0.06, ddPausa: 0.30, tarde: 3600,
  nivel: { n: 30, r: 0.10, t: 2 }, binaria: { n: 100, p: 0.58, lo: 0.5263, pago: 0.9 },
  estrategias: ['tortuga', 'giro'],
  planes: { 'cripto|tortuga': 'validada', 'metal|tortuga': 'prueba', 'forex|giro': 'prueba', 'indice|giro': 'prueba' },
  derivUrl: 'wss://api.derivws.com/trading/v1/options/ws/public',
  mercados: [].concat(
    mk('cripto', [['cryBTCUSD', 'Bitcoin / USD', 3, 0.0007, 1, { kraken: 'XBTUSD' }], ['cryETHUSD', 'Ethereum / USD', 5, 0.001166, 1, { kraken: 'ETHUSD' }]], { bin: false }),   // Deriv no tiene binarias en cripto
    mk('metal', [['frxXAUUSD', 'Oro / USD', 2, 0.000179], ['frxXAGUSD', 'Plata / USD', 4, 0.000975], ['frxXPTUSD', 'Platino / USD', 2, 0.0025, 0], ['frxXPDUSD', 'Paladio / USD', 2, 0.004, 0]]),
    mk('forex', [['frxEURUSD', 'EUR/USD', 5, 0.000225], ['frxGBPUSD', 'GBP/USD', 5, 0.000221], ['frxUSDJPY', 'USD/JPY', 3, 0.00035], ['frxAUDUSD', 'AUD/USD', 5, 0.00045], ['frxUSDCAD', 'USD/CAD', 5, 0.000212], ['frxUSDCHF', 'USD/CHF', 5, 0.0003],
      ['frxNZDUSD', 'NZD/USD', 5, 0.0003, 0], ['frxEURJPY', 'EUR/JPY', 3, 0.000275], ['frxGBPJPY', 'GBP/JPY', 3, 0.000244], ['frxEURGBP', 'EUR/GBP', 5, 0.000244], ['frxAUDJPY', 'AUD/JPY', 3, 0.000435], ['frxEURAUD', 'EUR/AUD', 5, 0.000225], ['frxEURCAD', 'EUR/CAD', 5, 0.000243],
      ['frxEURCHF', 'EUR/CHF', 5, 0.000291], ['frxGBPAUD', 'GBP/AUD', 5, 0.000217], ['frxAUDCAD', 'AUD/CAD', 5, 0.0004, 0], ['frxAUDCHF', 'AUD/CHF', 5, 0.0004, 0], ['frxAUDNZD', 'AUD/NZD', 5, 0.0004, 0], ['frxEURNZD', 'EUR/NZD', 5, 0.0004, 0], ['frxGBPCAD', 'GBP/CAD', 5, 0.0004, 0],
      ['frxGBPCHF', 'GBP/CHF', 5, 0.0004, 0], ['frxGBPNZD', 'GBP/NZD', 5, 0.0005, 0], ['frxNZDJPY', 'NZD/JPY', 3, 0.0004, 0], ['frxUSDMXN', 'USD/MXN', 4, 0.0005, 0], ['frxUSDPLN', 'USD/PLN', 4, 0.0006, 0]]),
    mk('indice', [['OTC_NDX', 'US Tech 100', 2, 0.0002, 0], ['OTC_SPC', 'US 500', 2, 0.0002, 0], ['OTC_DJI', 'Wall Street 30', 2, 0.0002, 0], ['OTC_GDAXI', 'Alemania 40', 2, 0.0002, 0], ['OTC_FTSE', 'Reino Unido 100', 2, 0.0002, 0], ['OTC_FCHI', 'Francia 40', 2, 0.0002, 0],
      ['OTC_SX5E', 'Euro 50', 2, 0.0002, 0], ['OTC_AEX', 'Países Bajos 25', 2, 0.0002, 0], ['OTC_SSMI', 'Suiza 20', 2, 0.0002, 0], ['OTC_N225', 'Japón 225', 2, 0.0002, 0], ['OTC_HSI', 'Hong Kong 50', 2, 0.0002, 0], ['OTC_AS51', 'Australia 200', 2, 0.0002, 0]])
  )
};
const POR = {}; CFG.mercados.forEach(m => { POR[m.code] = m; });

/* ---------- indicadores ---------- */
function atr(c, n) {   // ATR de Wilder, como en la web
  const out = new Array(c.length).fill(NaN); let a = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? c[i].h - c[i].l : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    if (i < n) { a += tr; if (i === n - 1) { a /= n; out[i] = a; } } else { a = (a * (n - 1) + tr) / n; out[i] = a; }
  }
  return out;
}
function canal(c, a, b) { let hh = -Infinity, ll = Infinity; for (let j = Math.max(0, a); j < b; j++) { if (c[j].h > hh) hh = c[j].h; if (c[j].l < ll) ll = c[j].l; } return [hh, ll]; }
function rsi(c, n) {
  const out = new Array(c.length).fill(NaN); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i].c - c[i - 1].c, up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return out;
}
const r2 = (x, d) => { const p = Math.pow(10, d == null ? 2 : d); return Math.round(x * p) / p; };

/* ---------- señales sobre velas cerradas ---------- */
// tortuga: cierre por encima del máximo (o por debajo del mínimo) de las 55 velas anteriores
function senalTortuga(c, i, A) {
  if (i < CFG.entrada || !(A[i] > 0)) return null;
  const ch = canal(c, i - CFG.entrada, i), dir = c[i].c > ch[0] ? 1 : c[i].c < ch[1] ? -1 : 0;
  return dir ? { dir: dir, nivel: dir > 0 ? ch[0] : ch[1], n: A[i], cierre: c[i].c, cambio: r2((c[i].c / c[i - CFG.entrada].c - 1) * 100, 2) } : null;
}
// giro (las flechas de la web): vela extrema fuera de Bollinger o con RSI 30/70 y extremo de 20 velas, confirmada en 3 velas.
// preGiros dice si la vela q (todavía sin cerrar) puede confirmar un giro, y con qué niveles: gatillo (ha de cerrar más allá) y extremo (no
// puede pasarlo). Como mucho hay uno por sentido; van del más reciente al más antiguo.
function preGiros(c, q, R) {
  const out = [];
  for (let i = q - 1; i >= Math.max(21, q - 3); i--) {
    let m = 0, s = 0; for (let j = i - 19; j <= i; j++) m += c[j].c; m /= 20; for (let j = i - 19; j <= i; j++) s += (c[j].c - m) * (c[j].c - m); s = Math.sqrt(s / 20);
    const lo = c[i].l <= m - 2 * s || R[i] <= 30, hi = c[i].h >= m + 2 * s || R[i] >= 70; if (lo === hi) continue;
    const up = lo; let ext = true; for (let j = i - 20; j < i; j++) if (up ? c[j].l <= c[i].l : c[j].h >= c[i].h) { ext = false; break; }
    if (!ext) continue;
    let ok = true; for (let j = i + 1; j < q; j++) if (up ? c[j].l < c[i].l || c[j].c > c[j - 1].h : c[j].h > c[i].h || c[j].c < c[j - 1].l) { ok = false; break; }
    if (!ok) continue;
    out.push({ dir: up ? 1 : -1, extremo: up ? c[i].l : c[i].h, gatillo: up ? c[q - 1].h : c[q - 1].l, t0: c[i].t });
  }
  return out;
}
function senalGiro(c, q, A, R) {
  if (q < 22) return null;
  const gs = preGiros(c, q, R);
  for (const g of gs) {
    const up = g.dir > 0;
    if (up ? c[q].l >= g.extremo && c[q].c > g.gatillo : c[q].h <= g.extremo && c[q].c < g.gatillo) return { dir: g.dir, extremo: g.extremo, gatillo: g.gatillo, n: A[q], cierre: c[q].c, t0: g.t0 };
  }
  return null;
}
const SENAL = { tortuga: (c, i, A) => senalTortuga(c, i, A), giro: (c, i, A, R) => senalGiro(c, i, A, R) };
function stopDe(est, s, precio) { return est === 'giro' ? s.extremo - s.dir * CFG.giro.stop * s.n : precio - s.dir * CFG.stopN * s.n; }

/* ---------- simulación de una operación sobre velas de 4 h (para medir cada señal) ---------- */
function simular(c, e, s, rate) {   // e: índice de la vela de entrada (se entra a su apertura); s: { estrategia, dir, stop, n }
  const dir = s.dir, E = c[e].o, N = s.n, risk = (E - s.stop) * dir; if (!(risk > 0)) return null;
  let stop = s.stop, units = [E], nextAdd = E + dir * CFG.paso * N, x = NaN, j, why = '';
  const tp = s.estrategia === 'giro' ? E + dir * CFG.giro.objetivo * N : NaN;
  for (j = e; j < c.length; j++) {
    const k = c[j], adv = dir > 0 ? k.l : k.h, fav = dir > 0 ? k.h : k.l;
    if ((adv - stop) * dir <= 0) { x = j > e && (k.o - stop) * dir <= 0 ? k.o : stop; why = 'stop'; break; }
    if (tp === tp && (fav - tp) * dir >= 0) { x = (k.o - tp) * dir >= 0 ? k.o : tp; why = 'objetivo'; break; }
    if (s.estrategia === 'tortuga' && units.length < CFG.maxUnidades && (fav - nextAdd) * dir >= 0) {
      const ap = (k.o - nextAdd) * dir >= 0 ? k.o : nextAdd; units.push(ap); nextAdd = ap + dir * CFG.paso * N;
      const ns = ap - dir * CFG.stopN * N; if ((ns - stop) * dir > 0) stop = ns;
      if ((adv - stop) * dir <= 0) { x = stop; why = 'stop'; break; }
    }
    if (s.estrategia === 'tortuga' && j >= CFG.salida) { const ch = canal(c, j - CFG.salida, j); if ((k.c - (dir > 0 ? ch[1] : ch[0])) * dir < 0) { if (j + 1 < c.length) { x = c[j + 1].o; why = 'canal'; } break; } }
    if (s.estrategia === 'giro' && j - e + 1 >= CFG.giro.velas) { if (j + 1 < c.length) { x = c[j + 1].o; why = 'tiempo'; } break; }
  }
  if (!why) return null;   // sigue abierta
  let R = 0; units.forEach(u => { R += (x - u) * dir / risk - rate * u / risk; });
  const bin = [1, 3, 5].map(h => e + h - 1 < c.length ? ((c[e + h - 1].c - E) * dir > 0 ? 1 : 0) : -1);
  return { R: r2(R, 3), bin: bin, unidades: units.length, why: why, salida: x, fin: c[Math.min(j, c.length - 1)].t };
}

/* ---------- la cuenta ---------- */
function nuevaCuenta(now) {
  return { v: CFG.v, inicio: now, saldo0: CFG.saldo0, saldo: CFG.saldo0, pico: CFG.saldo0, maxDD: 0, abiertas: [], cerradas: [], curva: [[now, CFG.saldo0]],
    ultimo: {}, medidas: {}, virtuales: [], planes: Object.assign({}, CFG.planes), espera: {}, niveles: {}, resumen: {}, binarias: [], eventos: [], ejecuciones: [], huella: '', pausa: false, dia: null, semana: null, sig: 1 };
}
function evento(st, now, tipo, txt, extra) { st.eventos.unshift(Object.assign({ t: now, tipo: tipo, txt: txt }, extra || {})); if (st.eventos.length > 300) st.eventos.length = 300; }
function migrar(st, now) {   // de la versión 1 (solo BTC y ETH) a la 2
  if (st.v >= 2) return;
  st.v = 2; st.planes = Object.assign({}, CFG.planes); st.espera = {}; st.niveles = {}; st.resumen = {}; st.binarias = []; delete st.encendidos;
  const u = {}; Object.keys(st.ultimo || {}).forEach(k => { const code = k.split('|')[0]; u[code] = Math.max(u[code] || 0, st.ultimo[k]); }); st.ultimo = u;
  st.abiertas.forEach(p => { p.nivel = 'validada'; });
  evento(st, now, 'version', 'Empieza a operar todos los mercados', { v: 2 });
}
const plan = (st, m, est) => st.planes[m.group + '|' + est] || 'observa';
const activo = (st, m, est) => { const e = plan(st, m, est); return e === 'validada' || e === 'prueba'; };
const cfdDe = (st, code) => st.abiertas.find(p => p.code === code && p.producto === 'cfd');
function riesgoDe(p) {   // lo que se perdería si la operación tocara su stop (en $)
  if (p.producto === 'bin') return p.importe;
  let r = 0; p.unidades.forEach(u => { const loss = -(p.stop - u.p) * p.dir / u.p * u.tam; if (loss > 0) r += loss; }); return r;
}
function riesgoAbierto(st, f) { let r = 0; st.abiertas.forEach(p => { if (!f || f(p)) r += riesgoDe(p); }); return r; }
function cabe(st, m, nivel, riesgo, nueva) {   // '' si cabe; si no, el motivo
  if (nivel === 'prueba') {
    if (riesgoAbierto(st, p => p.nivel === 'prueba') + riesgo > CFG.riesgoPrueba * st.saldo + 1e-9) return 'riesgo';
    if (nueva && st.abiertas.filter(p => p.nivel === 'prueba' && p.group === m.group && p.producto === 'cfd').length >= CFG.porFamilia) return 'familia';
  } else if (riesgoAbierto(st, p => p.nivel !== 'prueba') + riesgo > CFG.riesgoMax * st.saldo + 1e-9) return 'riesgo';
  if (nueva && m.group === 'forex') {
    for (const d of [m.code.slice(3, 6), m.code.slice(6, 9)]) if (st.abiertas.filter(p => p.group === 'forex' && p.producto === 'cfd' && (p.code.slice(3, 6) === d || p.code.slice(6, 9) === d)).length >= CFG.porDivisa) return 'divisa';
  }
  return '';
}
function bloqueada(st, now) {
  const dk = Math.floor(now / 86400), wk = Math.floor((now / 86400 + 3) / 7);
  if (!st.dia || st.dia.k !== dk) st.dia = { k: dk, s: st.saldo };
  if (!st.semana || st.semana.k !== wk) st.semana = { k: wk, s: st.saldo };
  if (st.pausa || st.saldo <= st.pico * (1 - CFG.ddPausa)) { st.pausa = true; return 'pausa'; }   // se queda en pausa hasta que se revise a mano
  if (st.saldo <= st.dia.s * (1 - CFG.diaStop)) return 'dia';
  if (st.saldo <= st.semana.s * (1 - CFG.semanaStop)) return 'semana';
  return '';
}
function apunta(st, t, now, base) {   // saldo, huella encadenada, historial y curva
  st.saldo = r2(st.saldo + t.resultado, 4); st.pico = Math.max(st.pico, st.saldo); st.maxDD = Math.max(st.maxDD, r2(1 - st.saldo / st.pico, 4));
  t.h = crypto.createHash('sha256').update(st.huella + JSON.stringify(base)).digest('hex'); st.huella = t.h;
  st.cerradas.unshift(t); st.curva.push([t.cierra, st.saldo]);
  const n = st.curva.length; if (n > 1 && st.curva[n - 1][0] < st.curva[n - 2][0]) st.curva.sort((a, b) => a[0] - b[0]);
}
function cerrar(st, p, now, precio, por) {
  let bruto = 0; p.unidades.forEach(u => { bruto += u.tam * (precio - u.p) / u.p * p.dir; });
  const res = bruto - p.comision;
  const t = Object.assign({}, p, { cierra: now, salida: precio, salidaPor: por, resultado: r2(res, 4), R: r2(res / p.riesgo0, 2) });
  delete t.revisado; delete t.siguiente; delete t.h4; delete t.salir; delete t.ahora;
  st.abiertas = st.abiertas.filter(x => x !== p);
  apunta(st, t, now, [t.id, t.code, t.dir, t.abre, t.precio, t.unidades, t.cierra, t.salida, t.resultado]);
  evento(st, now, 'cierre', (p.dir > 0 ? 'Cierra la compra' : 'Cierra la venta') + ' de ' + p.name, { id: p.id, salidaPor: por, resultado: t.resultado, R: t.R });
  return t;
}
function abrir(st, m, est, s, now, precio) {   // devuelve '' si abre; si no, el motivo
  const nivel = plan(st, m, est), riesgo = r2(CFG.riesgo[nivel] * st.saldo, 4), stop = stopDe(est, s, precio), dist = (precio - stop) * s.dir / precio;
  if (!(riesgo > 0) || !(dist > 0)) return 'precio';   // el precio ya pasó el stop: la señal no vale
  const no = cabe(st, m, nivel, riesgo, true); if (no) return no;
  const tam = Math.max(0.01, r2(riesgo / dist, 2)), id = 'U' + String(st.sig++).padStart(4, '0'), D = m.dec + 2;
  const p = { id: id, code: m.code, name: m.name, group: m.group, dec: m.dec, dir: s.dir, tf: 'H4', estrategia: est, producto: 'cfd', nivel: nivel, abre: now, precio: precio,
    mult: m.mult, n: r2(s.n, D), stop: r2(stop, D), stop0: r2(stop, D), unidades: [{ t: now, p: precio, tam: tam }], comision: r2(m.rate * tam, 6), riesgo0: riesgo, revisado: now,
    motivo: { senal: s.t, cierre: s.cierre, retraso: Math.max(0, Math.round(now - (s.t + CFG.gran))) } };
  if (est === 'giro') { p.tp = r2(precio + s.dir * CFG.giro.objetivo * s.n, D); p.velas = 0; p.motivo.extremo = r2(s.extremo, D); p.motivo.gatillo = r2(s.gatillo, D); p.motivo.t0 = s.t0; }
  else { p.siguiente = r2(precio + s.dir * CFG.paso * s.n, D); p.motivo.nivel = r2(s.nivel, D); p.motivo.cambio = s.cambio; }
  st.abiertas.push(p);
  evento(st, now, 'abre', (s.dir > 0 ? 'Compra ' : 'Venta ') + m.name, { id: id, precio: precio });
  return '';
}
function sumar(st, m, p, now, precio) {   // añadir una unidad al llegar al siguiente nivel; el stop solo se acerca
  const riesgo = p.riesgo0, ns = precio - p.dir * CFG.stopN * p.n, nuevoStop = (ns - p.stop) * p.dir > 0 ? ns : p.stop, dist = Math.abs(precio - nuevoStop) / precio;
  const tam = Math.max(0.01, r2(riesgo / Math.max(dist, 1e-9), 2));
  const antes = p.stop; p.stop = r2(nuevoStop, p.dec + 2);
  if (cabe(st, m, p.nivel, riesgo, false)) { p.stop = antes; return false; }
  p.unidades.push({ t: now, p: precio, tam: tam }); p.comision = r2(p.comision + m.rate * tam, 6);
  p.siguiente = r2(precio + p.dir * CFG.paso * p.n, p.dec + 2);
  evento(st, now, 'suma', 'Suma una unidad a ' + (p.dir > 0 ? 'la compra' : 'la venta') + ' de ' + p.name, { id: p.id, precio: precio, unidades: p.unidades.length });
  return true;
}
function omite(st, now, m, motivo) {   // una señal que no se opera; las del mismo motivo y el mismo día se juntan en una línea
  const dia = Math.floor(now / 86400), e = st.eventos.find(x => x.tipo === 'omite' && x.motivo === motivo && Math.floor(x.t / 86400) === dia);
  if (e) { e.n = (e.n || 1) + 1; e.lista = e.lista || [e.code]; if (e.lista.length < 8 && e.lista.indexOf(m.code) < 0) e.lista.push(m.code); return; }
  evento(st, now, 'omite', 'Señal en ' + m.name + ' sin operar', { motivo: motivo, code: m.code });
}

/* lo abierto en un mercado: órdenes que esperan (stop, take profit y añadidos) con velas de 5 minutos, y salidas por señal con las de 4 h */
function gestionar(st, m, d, now, c) {
  const p = cfdDe(st, m.code); if (!p) return;
  const price = d.precio, abierto = d.abierto !== false;
  const fin = (d.m5 || []).filter(k => k.t + CFG.m5 <= now && k.t + CFG.m5 > p.revisado).sort((a, b) => a.t - b.t);
  for (const k of fin) {
    const adv = p.dir > 0 ? k.l : k.h, fav = p.dir > 0 ? k.h : k.l;
    if ((adv - p.stop) * p.dir <= 0) { cerrar(st, p, k.t + CFG.m5, (k.o - p.stop) * p.dir <= 0 ? k.o : p.stop, 'stop'); return; }
    if (p.tp != null && (fav - p.tp) * p.dir >= 0) { cerrar(st, p, k.t + CFG.m5, (k.o - p.tp) * p.dir >= 0 ? k.o : p.tp, 'objetivo'); return; }
    if (p.siguiente != null && p.unidades.length < CFG.maxUnidades && (fav - p.siguiente) * p.dir >= 0 && activo(st, m, p.estrategia) && !bloqueada(st, now)) {
      const ap = (k.o - p.siguiente) * p.dir >= 0 ? k.o : p.siguiente;
      if (sumar(st, m, p, k.t, ap) && (adv - p.stop) * p.dir <= 0) { cerrar(st, p, k.t + CFG.m5, p.stop, 'stop'); return; }
    }
    p.revisado = k.t + CFG.m5;
  }
  if (price && abierto) {
    if ((price - p.stop) * p.dir <= 0) { cerrar(st, p, now, price, 'stop'); return; }
    if (p.tp != null && (price - p.tp) * p.dir >= 0) { cerrar(st, p, now, price, 'objetivo'); return; }
  }
  // salidas por señal: se mira cada vela de 4 h cerrada desde la entrada que aún no se había mirado
  for (let i = 0; i < c.length; i++) {
    if (c[i].t + CFG.gran <= p.abre || c[i].t <= (p.h4 || 0)) continue;
    p.h4 = c[i].t;
    if (p.estrategia === 'giro') { p.velas = (p.velas || 0) + 1; if (p.velas >= CFG.giro.velas) p.salir = p.salir || 'tiempo'; }
    else if (i >= CFG.salida) { const ch = canal(c, i - CFG.salida, i); if ((c[i].c - (p.dir > 0 ? ch[1] : ch[0])) * p.dir < 0) p.salir = p.salir || 'canal'; }
  }
  if (p.salir && price && abierto) cerrar(st, p, now, price, p.salir);
}

/* señales de la última vela cerrada: se apuntan para medirlas y, si el plan de la familia está activo, se operan */
function senales(st, m, d, now, c, A, R) {
  const i = c.length - 1, price = d.precio, abierto = d.abierto !== false;
  if ((st.ultimo[m.code] || 0) < c[i].t) {
    st.ultimo[m.code] = c[i].t;
    CFG.estrategias.forEach(est => {
      const s = SENAL[est](c, i, A, R); if (!s) return;
      s.t = c[i].t;
      const key = m.code + '|' + est;
      if (!st.virtuales.some(v => v.k === key)) st.virtuales.push({ k: key, code: m.code, est: est, dir: s.dir, t: c[i].t + CFG.gran, stop: stopDe(est, s, c[i].c), n: s.n });
      if (m.bin !== false && price && abierto) st.binarias.filter(b => b.indexOf(m.group + '|' + est + '|') === 0).forEach(b => abrirBinaria(st, m, est, s, +b.split('|')[2], now, price, c[i].t));
      if (activo(st, m, est) && !st.espera[m.code] && !cfdDe(st, m.code)) {
        if (abierto && now - (c[i].t + CFG.gran) > CFG.tarde) omite(st, now, m, 'tarde');   // la tarea llegó tarde: esa entrada ya no es la de la señal
        else st.espera[m.code] = { est: est, s: s };
      }
    });
  }
  const w = st.espera[m.code];
  if (!w) return;
  if (w.s.t !== c[i].t || cfdDe(st, m.code) || !activo(st, m, w.est)) { delete st.espera[m.code]; return; }   // caduca al cerrar la vela siguiente
  if (!abierto || !price) return;                                                    // mercado cerrado: espera a que abra
  delete st.espera[m.code];
  const no = bloqueada(st, now) || abrir(st, m, w.est, w.s, now, price);
  if (no) omite(st, now, m, no);
}

/* cada señal apuntada se resuelve con las velas de 4 h, como si se hubiera operado (la de entrada es la primera que abre después: fines de semana incluidos) */
function resolver(st, m, c) {
  st.virtuales.filter(v => v.code === m.code).forEach(v => {
    if (c.length && c[0].t > v.t) { v.perdida = true; return; }
    const e = c.findIndex(k => k.t >= v.t); if (e < 0 || c.length - e < 5) return;   // con 5 velas desde la entrada, para medir también las binarias a 1, 3 y 5 velas en todas las señales
    const r = simular(c, e, { estrategia: v.est, dir: v.dir, stop: v.stop, n: v.n }, m.rate); if (!r) return;
    const md = st.medidas[v.k] = st.medidas[v.k] || { n: 0, s: 0, s2: 0, g: 0, bin: [[0, 0], [0, 0], [0, 0]] };
    md.n++; md.s = r2(md.s + r.R, 4); md.s2 = r2(md.s2 + r.R * r.R, 4); if (r.R > 0) md.g++;
    r.bin.forEach((b, q) => { if (b >= 0) { md.bin[q][0]++; md.bin[q][1] += b; } });
    v.fin = true;
  });
  st.virtuales = st.virtuales.filter(v => !v.fin && !v.perdida);
}
/* binarias (solo cuando una estrategia las ha validado en esa familia): importe = riesgo de una unidad validada; vence a las h velas de 4 h */
function abrirBinaria(st, m, est, s, h, now, precio, sigT) {
  if (bloqueada(st, now) || st.abiertas.some(p => p.code === m.code && p.producto === 'bin' && p.estrategia === est && p.vence > now)) return;
  const imp = r2(CFG.riesgo.validada * st.saldo, 2);
  if (!(imp > 0) || cabe(st, m, 'validada', imp, false)) return;
  const id = 'U' + String(st.sig++).padStart(4, '0');
  st.abiertas.push({ id: id, code: m.code, name: m.name, group: m.group, dec: m.dec, dir: s.dir, tf: 'H4', estrategia: est, producto: 'bin', nivel: 'validada', abre: now, precio: precio,
    vence: now + h * CFG.gran, velas: h, importe: imp, pago: CFG.binaria.pago, riesgo0: imp, comision: 0, unidades: [], stop: null, motivo: { senal: sigT } });
  evento(st, now, 'abre', (s.dir > 0 ? 'Binaria Sube en ' : 'Binaria Baja en ') + m.name, { id: id, precio: precio, velas: h });
}
function resolverBinarias(st, m, d, now) {
  st.abiertas.filter(p => p.code === m.code && p.producto === 'bin' && p.vence <= now).forEach(p => {
    const g = d.m5 ? CFG.m5 : CFG.gran, fin = (d.m5 || d.h4 || []).filter(k => k.t + g <= p.vence).pop();   // el precio al vencer: cierre de la última vela que termina antes del vencimiento
    if (!fin || fin.t + 2 * g < p.vence) return;                                                              // aún no hay datos hasta el vencimiento
    const px = fin.c, gana = (px - p.precio) * p.dir > 0, res = gana ? p.importe * p.pago : -p.importe;
    const t = Object.assign({}, p, { cierra: p.vence, salida: px, salidaPor: 'vence', resultado: r2(res, 4), R: r2(res / p.importe, 2) });
    st.abiertas = st.abiertas.filter(x => x !== p);
    apunta(st, t, now, [t.id, t.code, t.dir, t.abre, t.precio, t.vence, t.salida, t.resultado]);
    evento(st, now, 'cierre', 'Vence la binaria de ' + p.name, { id: p.id, resultado: t.resultado });
  });
}
/* niveles de cada familia: con lo medido en todos sus mercados, una estrategia sube a validada, sigue en prueba o se apaga */
function decidirPlanes(st, now) {
  const fam = {};
  Object.keys(st.medidas).forEach(k => {
    const pr = k.split('|'), m = POR[pr[0]]; if (!m) return;
    const a = fam[m.group + '|' + pr[1]] = fam[m.group + '|' + pr[1]] || { n: 0, s: 0, s2: 0, g: 0, bin: [[0, 0], [0, 0], [0, 0]] }, md = st.medidas[k];
    a.n += md.n; a.s += md.s; a.s2 += md.s2; a.g += md.g; md.bin.forEach((b, q) => { a.bin[q][0] += b[0]; a.bin[q][1] += b[1]; });
  });
  st.resumen = {};
  Object.keys(fam).sort().forEach(k => {
    const a = fam[k], mean = a.s / a.n, sd = Math.sqrt(Math.max(1e-12, a.s2 / a.n - mean * mean)), t = a.n > 1 ? mean / sd * Math.sqrt(a.n) : 0, antes = st.planes[k] || 'observa';
    st.resumen[k] = { n: a.n, r: r2(mean, 3), t: r2(t, 2), g: a.g, bin: a.bin };
    let e = antes;
    if (a.n >= CFG.nivel.n && mean >= CFG.nivel.r && t >= CFG.nivel.t) e = 'validada';
    else if (a.n >= CFG.nivel.n && t <= -CFG.nivel.t && (antes === 'validada' || antes === 'prueba')) e = 'apagada';
    if (e !== antes) { st.planes[k] = e; evento(st, now, 'nivel', k + ': ' + antes + ' → ' + e, { plan: k, de: antes, a: e, n: a.n, r: r2(mean, 3), tStat: r2(t, 1) }); }
    if (k.split('|')[0] === 'cripto') return;   // Deriv no ofrece binarias en cripto
    a.bin.forEach((b, q) => {   // binarias: acierto al vencer 1, 3 o 5 velas
      if (b[0] < CFG.binaria.n) return;
      const p = b[1] / b[0], z = 1.645, lo = (p + z * z / (2 * b[0]) - z * Math.sqrt(p * (1 - p) / b[0] + z * z / (4 * b[0] * b[0]))) / (1 + z * z / b[0]);
      const key = k + '|' + [1, 3, 5][q];
      if (p >= CFG.binaria.p && lo > CFG.binaria.lo && st.binarias.indexOf(key) < 0) { st.binarias.push(key); evento(st, now, 'binaria', 'Binarias validadas: ' + key, { plan: k, velas: [1, 3, 5][q], p: r2(p * 100, 1), n: b[0] }); }
    });
  });
}
/* lo que hará cada mercado al cerrar la vela de 4 h en curso (para que la web lo enseñe antes de que pase) */
function nivelesDe(st, m, c, A, R) {
  const i = c.length - 1, D = m.dec + 1, out = { t: c[i].t, n: r2(A[i], m.dec + 2) };
  if (activo(st, m, 'tortuga')) { const ch = canal(c, i + 1 - CFG.entrada, i + 1), c2 = canal(c, i + 1 - CFG.salida, i + 1); out.r = [r2(ch[0], D), r2(ch[1], D), r2(c2[0], D), r2(c2[1], D)]; }
  if (activo(st, m, 'giro')) out.g = preGiros(c, i + 1, R).map(g => [g.dir, r2(g.extremo, D), r2(g.gatillo, D)]);
  st.niveles[m.code] = out;
}

/* una ejecución completa, sin red: datos = { code: { h4: [...], m5: [...], precio, abierto } } */
function paso(st, datos, now) {
  if (!st) st = nuevaCuenta(now);
  migrar(st, now);
  const vistos = [];
  CFG.mercados.forEach(m => {
    const d = datos[m.code]; if (!d || !d.h4) return;
    const c = d.h4.filter(k => k.t + CFG.gran <= now); if (c.length < 80) return;
    const A = atr(c, 20), R = rsi(c, 14);
    gestionar(st, m, d, now, c);
    resolverBinarias(st, m, d, now);
    senales(st, m, d, now, c, A, R);
    resolver(st, m, c);
    vistos.push([m, c, A, R]);
  });
  decidirPlanes(st, now);
  vistos.forEach(v => nivelesDe(st, v[0], v[1], v[2], v[3]));   // después de decidir los niveles, para publicar solo lo que de verdad se va a operar
  // valor de la cuenta con lo abierto a precio de ahora
  let vivo = 0; st.abiertas.forEach(p => { const pr = (datos[p.code] || {}).precio; if (pr && p.producto === 'cfd') p.unidades.forEach(u => { vivo += u.tam * (pr - u.p) / u.p * p.dir; }); p.ahora = pr || p.ahora; });
  st.valor = r2(st.saldo + vivo - st.abiertas.reduce((a, p) => a + p.comision, 0), 2);
  const day = Math.floor(now / 86400); if (!st.curva.length || Math.floor(st.curva[st.curva.length - 1][0] / 86400) !== day) st.curva.push([now, st.valor]);
  st.riesgo = r2(riesgoAbierto(st), 4);
  st.actualizado = now;
  return st;
}

/* ---------- datos en vivo ---------- */
function derivCliente(url) {
  return new Promise((res, rej) => {
    let ws; try { ws = new WebSocket(url); } catch (e) { return rej(e); }
    let id = 0; const pend = {}, to = setTimeout(() => rej(new Error('Deriv no responde')), 15000);
    ws.onopen = () => { clearTimeout(to); res({
      send(msg) { return new Promise((ok, ko) => { const rid = ++id; msg.req_id = rid; pend[rid] = { ok, ko }; ws.send(JSON.stringify(msg)); setTimeout(() => { if (pend[rid]) { delete pend[rid]; ko(new Error('Deriv tarda demasiado')); } }, 20000); }); },
      close() { try { ws.close(); } catch (e) { } }
    }); };
    ws.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch (x) { return; } const p = pend[d.req_id]; if (!p) return; delete pend[d.req_id]; if (d.error) p.ko(new Error(d.error.message || d.error.code)); else p.ok(d); };
    ws.onerror = () => rej(new Error('no se pudo conectar con Deriv'));
  });
}
async function velasDeriv(cl, code, gran, count) {
  const r = await cl.send({ ticks_history: code, end: 'latest', count: count, style: 'candles', granularity: gran });
  return (r.candles || []).map(x => ({ t: +x.epoch, o: +x.open, h: +x.high, l: +x.low, c: +x.close })).filter(x => x.t % gran === 0);
}
async function velasKraken(pair, minutes) {
  const r = await fetch('https://api.kraken.com/0/public/OHLC?pair=' + pair + '&interval=' + minutes, { headers: { 'User-Agent': 'umbraltrade.com cuenta' } });
  const j = await r.json(); if (j.error && j.error.length) throw new Error(j.error.join(', '));
  const k = Object.keys(j.result).find(x => x !== 'last');
  return j.result[k].map(a => ({ t: +a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4] }));
}
async function traerDatos(st, now) {
  const datos = {}, errores = [];
  let cl = null; try { cl = await derivCliente(CFG.derivUrl); } catch (e) { errores.push('Deriv: ' + e.message); }
  let abiertos = null;   // qué mercados están abiertos ahora (con el mercado cerrado no se entra ni se sale por señal)
  if (cl) try { const r = await cl.send({ active_symbols: 'brief' }); abiertos = {}; (r.active_symbols || []).forEach(s => { abiertos[s.underlying_symbol || s.symbol] = !!s.exchange_is_open && !s.is_trading_suspended; }); } catch (e) { errores.push('Horarios: ' + e.message); }
  const pos = {}; (st ? st.abiertas : []).forEach(p => { pos[p.code] = Math.min(pos[p.code] == null ? Infinity : pos[p.code], p.revisado || p.abre); });
  const viejo = {}; (st ? st.virtuales : []).forEach(v => { viejo[v.code] = Math.min(viejo[v.code] == null ? Infinity : viejo[v.code], v.t); });
  for (const m of CFG.mercados) {
    const n4 = Math.min(1000, Math.max(300, viejo[m.code] != null ? Math.ceil((now - viejo[m.code]) / CFG.gran) + 40 : 0));
    const n5 = pos[m.code] != null ? Math.min(1000, Math.ceil((now - Math.min(now - 3600, pos[m.code] - 600)) / CFG.m5) + 3) : 0;
    try {
      if (!cl) throw new Error('sin conexión');
      const h4 = await velasDeriv(cl, m.code, CFG.gran, n4), d = datos[m.code] = { h4: h4, precio: h4.length ? h4[h4.length - 1].c : null, fuente: 'Deriv', abierto: abiertos ? !!abiertos[m.code] : m.group === 'cripto' };
      if (n5) { d.m5 = await velasDeriv(cl, m.code, CFG.m5, n5); if (d.m5.length) d.precio = d.m5[d.m5.length - 1].c; }
    } catch (e) {
      if (!m.kraken) { errores.push(m.code + ': ' + e.message); continue; }
      try { const h4 = await velasKraken(m.kraken, 240), m5 = await velasKraken(m.kraken, 5); datos[m.code] = { h4: h4.slice(-Math.max(300, n4)), m5: m5.slice(-Math.max(n5, 15)), precio: m5.length ? m5[m5.length - 1].c : null, fuente: 'Kraken', abierto: true }; errores.push(m.code + ': Deriv no respondió, precios de Kraken'); }
      catch (e2) { errores.push(m.code + ': ' + e2.message); }
    }
  }
  if (cl) cl.close();
  return { datos: datos, errores: errores };
}

/* ---------- línea de órdenes ---------- */
if (require.main === module) {
  (async () => {
    const file = process.argv[2] || 'datos/cuenta.json', arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
    const now = arg('--ahora') ? +arg('--ahora') : Math.floor(Date.now() / 1000);
    let st = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const before = st ? JSON.stringify(st) : null;
    let datos, errores = [];
    if (arg('--velas')) datos = JSON.parse(fs.readFileSync(arg('--velas'), 'utf8'));
    else { const r = await traerDatos(st, now); datos = r.datos; errores = r.errores; }
    st = paso(st, datos, now);
    st.ejecuciones.unshift([now, Object.keys(datos).length, errores.length]); if (st.ejecuciones.length > 60) st.ejecuciones.length = 60;
    st.errores = errores.slice(0, 12);
    st.fuente = Object.keys(datos).map(c => datos[c].fuente).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
    // solo se guarda si cambia algo de verdad, o una vez por hora para decir que sigue viva (así el historial público no se llena de ruido)
    const nucleo = s => JSON.stringify(Object.assign({}, s, { actualizado: 0, ejecuciones: 0, valor: 0, riesgo: 0, errores: 0, fuente: 0, guardado: 0, abiertas: (s.abiertas || []).map(p => Object.assign({}, p, { ahora: 0 })) }));
    const prev = before ? JSON.parse(before) : null;
    if (prev && nucleo(prev) === nucleo(st) && now - (prev.guardado || 0) < 3600 && !errores.length === !(prev.errores || []).length) { console.log('sin cambios que guardar'); return; }
    st.guardado = now;
    const txt = JSON.stringify(st) + '\n';
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file + '.tmp', txt); fs.renameSync(file + '.tmp', file);
    console.log('saldo ' + st.saldo + ' $, abiertas ' + st.abiertas.length + ', cerradas ' + st.cerradas.length + ', mercados ' + Object.keys(datos).length + (errores.length ? ', avisos: ' + errores.join(' | ') : '') + (prev && prev.cerradas.length !== st.cerradas.length ? ' (operación cerrada)' : ''));
  })().catch(e => { console.error(e.message); process.exit(1); });
}
module.exports = { CFG, paso, nuevaCuenta, simular, senalTortuga, senalGiro, preGiros, atr, rsi, canal, traerDatos };
