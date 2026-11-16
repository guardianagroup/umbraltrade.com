/* Cuenta del algoritmo de Umbral Trade: una cuenta ficticia de 50 $ que opera sola con reglas fijas y deja cada operación a la vista.
   Uso:  node tools/cuenta.js datos/cuenta.json                  (lo ejecuta cada 15 minutos .github/workflows/cuenta.yml)
         node tools/cuenta.js estado.json --velas velas.json --ahora 1763337600   (sin red, para las pruebas)
   Reglas (estudio del 16-11-2026 con 8 años de cripto, 25 de divisas y un año de Deriv; revisado con ChatGPT):
   - Opera CFD (multiplicador en Deriv) en BTC/USD y ETH/USD con la rotura de canal de las tortugas en velas de 4 horas: compra cuando
     una vela cierra por encima del máximo de las 55 anteriores (vende por debajo del mínimo). Stop a 2 ATR(20) de la entrada.
     Si el precio avanza 0,5 ATR suma otra unidad, hasta 4, y sube el stop a 2 ATR de la última. Sale cuando una vela cierra al otro
     lado del canal de 20 velas o cuando toca el stop.
   - Riesgo del 0,5 % del saldo por unidad y del 2 % como máximo entre todo lo abierto; no abre más si pierde el 3 % en el día o el
     6 % en la semana; se pausa si cae un 30 % desde su máximo.
   - Los stops y los añadidos son órdenes que esperan en el bróker: se ejecutan a su precio aunque la tarea pase más tarde (se
     comprueban con velas de 5 minutos). Las entradas y las salidas por señal se hacen al precio del momento en que corre la tarea.
   - El resto (forex, oro, plata, índices y los giros de las flechas) queda en observación: se mide cada señal como si se operara y,
     si una estrategia demuestra ventaja en un mercado (30 operaciones, +0,10 R de media y t ≥ 2), se enciende sola.
   - Binarias: solo si una estrategia acierta el 58 % o más en un mercado con el límite inferior por encima del 52,6 % (100 señales).
   Cada operación cerrada lleva una huella encadenada (SHA-256): cambiar una operación antigua rompe todas las siguientes. */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const CFG = {
  v: 1, saldo0: 50, gran: 14400, m5: 300,
  entrada: 55, salida: 20, stopN: 2, paso: 0.5, maxUnidades: 4,
  riesgoUnidad: 0.005, riesgoMax: 0.02, diaStop: 0.03, semanaStop: 0.06, ddPausa: 0.30,
  encender: { n: 30, r: 0.10, t: 2 }, binaria: { n: 100, p: 0.58, lo: 0.5263, pago: 0.9 },
  derivUrl: 'wss://api.derivws.com/trading/v1/options/ws/public',
  opera: [
    { code: 'cryBTCUSD', name: 'BTC/USD', group: 'cripto', dec: 2, rate: 0.0008, kraken: 'XBTUSD' },
    { code: 'cryETHUSD', name: 'ETH/USD', group: 'cripto', dec: 2, rate: 0.0008, kraken: 'ETHUSD' }
  ],
  observa: [
    { code: 'frxEURUSD', name: 'EUR/USD', group: 'forex', dec: 5, rate: 0.0002 },
    { code: 'frxGBPUSD', name: 'GBP/USD', group: 'forex', dec: 5, rate: 0.0002 },
    { code: 'frxUSDJPY', name: 'USD/JPY', group: 'forex', dec: 3, rate: 0.0002 },
    { code: 'frxAUDUSD', name: 'AUD/USD', group: 'forex', dec: 5, rate: 0.0002 },
    { code: 'frxXAUUSD', name: 'Oro / USD', group: 'metal', dec: 2, rate: 0.0002 },
    { code: 'frxXAGUSD', name: 'Plata / USD', group: 'metal', dec: 4, rate: 0.0002 },
    { code: 'OTC_SPC', name: 'EE. UU. 500', group: 'indice', dec: 2, rate: 0.0002 },
    { code: 'OTC_NDX', name: 'EE. UU. Tech 100', group: 'indice', dec: 2, rate: 0.0002 },
    { code: 'OTC_GDAXI', name: 'Alemania 40', group: 'indice', dec: 2, rate: 0.0002 }
  ]
};

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
// giro (las flechas de la web): vela extrema fuera de Bollinger o con RSI 30/70 y extremo de 20 velas, confirmada en 3 velas
function senalGiro(c, q, A, R) {
  for (let i = q - 1; i >= Math.max(21, q - 3); i--) {
    let m = 0, s = 0; for (let j = i - 19; j <= i; j++) m += c[j].c; m /= 20; for (let j = i - 19; j <= i; j++) s += (c[j].c - m) * (c[j].c - m); s = Math.sqrt(s / 20);
    const lo = c[i].l <= m - 2 * s || R[i] <= 30, hi = c[i].h >= m + 2 * s || R[i] >= 70; if (lo === hi) continue;
    const up = lo; let ext = true; for (let j = i - 20; j < i; j++) if (up ? c[j].l <= c[i].l : c[j].h >= c[i].h) { ext = false; break; }
    if (!ext) continue;
    let ok = true; for (let j = i + 1; j < q; j++) if (up ? c[j].l < c[i].l || c[j].c > c[j - 1].h : c[j].h > c[i].h || c[j].c < c[j - 1].l) { ok = false; break; }
    if (!ok) continue;
    if (up ? c[q].l >= c[i].l && c[q].c > c[q - 1].h : c[q].h <= c[i].h && c[q].c < c[q - 1].l) return { dir: up ? 1 : -1, extremo: up ? c[i].l : c[i].h, n: A[q], cierre: c[q].c, t0: c[i].t };
  }
  return null;
}

/* ---------- simulación de una operación sobre velas de 4 h (para la observación) ---------- */
function simular(c, e, s, rate) {   // e: índice de la vela de entrada (se entra a su apertura); s: { estrategia, dir, stop, n, objetivo }
  const dir = s.dir, E = c[e].o, N = s.n, risk = (E - s.stop) * dir; if (!(risk > 0)) return null;
  let stop = s.stop, units = [E], nextAdd = E + dir * CFG.paso * N, x = NaN, j, why = '';
  const tp = s.estrategia === 'giro' ? E + dir * 1.5 * N : NaN;
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
    if (s.estrategia === 'giro' && j - e + 1 >= 40) { if (j + 1 < c.length) { x = c[j + 1].o; why = 'tiempo'; } break; }
  }
  if (!why) return null;   // sigue abierta
  let R = 0; units.forEach(u => { R += (x - u) * dir / risk - rate * u / risk; });
  const bin = [1, 3, 5].map(h => e + h - 1 < c.length ? ((c[e + h - 1].c - E) * dir > 0 ? 1 : 0) : -1);
  return { R: r2(R, 3), bin: bin, unidades: units.length, why: why, salida: x, fin: c[Math.min(j, c.length - 1)].t };
}

/* ---------- la cuenta ---------- */
function nuevaCuenta(now) {
  return { v: CFG.v, inicio: now, saldo0: CFG.saldo0, saldo: CFG.saldo0, pico: CFG.saldo0, maxDD: 0, abiertas: [], cerradas: [], curva: [[now, CFG.saldo0]],
    ultimo: {}, medidas: {}, virtuales: [], encendidos: [], binarias: [], eventos: [], ejecuciones: [], huella: '', pausa: false, dia: null, semana: null, sig: 1 };
}
function evento(st, now, tipo, txt, extra) { st.eventos.unshift(Object.assign({ t: now, tipo: tipo, txt: txt }, extra || {})); if (st.eventos.length > 300) st.eventos.length = 300; }
function riesgoAbierto(st) {   // lo que se perdería si todo lo abierto tocara su stop (en $)
  let r = 0; st.abiertas.forEach(p => { if (p.producto === 'bin') { r += p.importe; return; } p.unidades.forEach(u => { const loss = -(p.stop - u.p) * p.dir / u.p * u.tam; if (loss > 0) r += loss; }); });
  return r;
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
function cerrar(st, p, now, precio, por) {
  let bruto = 0; p.unidades.forEach(u => { bruto += u.tam * (precio - u.p) / u.p * p.dir; });
  const res = bruto - p.comision;
  const t = Object.assign({}, p, { cierra: now, salida: precio, salidaPor: por, resultado: r2(res, 2), R: r2(res / p.riesgo0, 2) });
  delete t.revisado; delete t.siguiente;
  st.saldo = r2(st.saldo + res, 2); st.pico = Math.max(st.pico, st.saldo); st.maxDD = Math.max(st.maxDD, r2(1 - st.saldo / st.pico, 4));
  const base = JSON.stringify([t.id, t.code, t.dir, t.abre, t.precio, t.unidades, t.cierra, t.salida, t.resultado]);
  t.h = crypto.createHash('sha256').update(st.huella + base).digest('hex'); st.huella = t.h;
  st.cerradas.unshift(t); st.abiertas = st.abiertas.filter(x => x !== p);
  st.curva.push([now, st.saldo]);
  evento(st, now, 'cierre', (p.dir > 0 ? 'Cierra la compra' : 'Cierra la venta') + ' de ' + p.name, { id: p.id, salidaPor: por, resultado: t.resultado, R: t.R });
  return t;
}
function abrir(st, m, s, now, precio, cfgEst) {
  const riesgo = r2(CFG.riesgoUnidad * st.saldo, 4), stop = precio - s.dir * CFG.stopN * s.n, dist = Math.abs(precio - stop) / precio;
  if (!(dist > 0) || riesgoAbierto(st) + riesgo > CFG.riesgoMax * st.saldo + 1e-9) return null;
  const tam = r2(riesgo / dist, 2), id = 'U' + String(st.sig++).padStart(4, '0');
  const p = { id: id, code: m.code, name: m.name, group: m.group, dec: m.dec, dir: s.dir, tf: 'H4', estrategia: 'tortuga', producto: 'cfd', abre: now, precio: precio,
    n: r2(s.n, m.dec + 2), stop: r2(stop, m.dec + 2), stop0: r2(stop, m.dec + 2), unidades: [{ t: now, p: precio, tam: tam }], comision: r2(m.rate * tam, 4), riesgo0: riesgo,
    siguiente: r2(precio + s.dir * CFG.paso * s.n, m.dec + 2), revisado: now,
    motivo: { senal: s.t, nivel: r2(s.nivel, m.dec + 2), cierre: s.cierre, cambio: s.cambio, retraso: Math.max(0, Math.round(now - (s.t + CFG.gran))) } };
  void cfgEst;
  st.abiertas.push(p);
  evento(st, now, 'abre', (s.dir > 0 ? 'Compra ' : 'Venta ') + m.name, { id: id, precio: precio });
  return p;
}
function sumar(st, p, now, precio) {   // añadir una unidad al llegar al siguiente nivel; el stop solo se acerca
  const riesgo = p.riesgo0, ns = precio - p.dir * CFG.stopN * p.n, nuevoStop = (ns - p.stop) * p.dir > 0 ? ns : p.stop, dist = Math.abs(precio - nuevoStop) / precio;
  const tam = r2(riesgo / Math.max(dist, 1e-9), 2);
  const antes = p.stop; p.stop = r2(nuevoStop, p.dec + 2);
  if (riesgoAbierto(st) + riesgo > CFG.riesgoMax * st.saldo + 1e-9) { p.stop = antes; return false; }
  p.unidades.push({ t: now, p: precio, tam: tam }); p.comision = r2(p.comision + rateOf(p) * tam, 4);
  p.siguiente = r2(precio + p.dir * CFG.paso * p.n, p.dec + 2);
  evento(st, now, 'suma', 'Suma una unidad a ' + (p.dir > 0 ? 'la compra' : 'la venta') + ' de ' + p.name, { id: p.id, precio: precio, unidades: p.unidades.length });
  return true;
}
function rateOf(p) { const m = CFG.opera.concat(CFG.observa).find(x => x.code === p.code); return m ? m.rate : 0.0003; }

/* gestiona un mercado que se opera: órdenes que esperan (stop y añadidos) con velas de 5 minutos, salidas por canal y entradas */
function gestionar(st, m, d, now) {
  const c = d.h4.filter(k => k.t + CFG.gran <= now), A = atr(c, 20), price = d.precio;
  let p = st.abiertas.find(x => x.code === m.code && x.producto === 'cfd');
  if (p) {
    const fin = (d.m5 || []).filter(k => k.t >= p.revisado - CFG.m5 + 1 && k.t + CFG.m5 <= now && k.t + CFG.m5 > p.revisado).sort((a, b) => a.t - b.t);
    for (const k of fin) {
      const adv = p.dir > 0 ? k.l : k.h, fav = p.dir > 0 ? k.h : k.l;
      if ((adv - p.stop) * p.dir <= 0) { cerrar(st, p, k.t + CFG.m5, (k.o - p.stop) * p.dir <= 0 ? k.o : p.stop, 'stop'); return; }
      if (p.unidades.length < CFG.maxUnidades && (fav - p.siguiente) * p.dir >= 0 && !bloqueada(st, now)) {
        const ap = (k.o - p.siguiente) * p.dir >= 0 ? k.o : p.siguiente;
        if (sumar(st, p, k.t, ap) && (adv - p.stop) * p.dir <= 0) { cerrar(st, p, k.t + CFG.m5, p.stop, 'stop'); return; }
      }
      p.revisado = k.t + CFG.m5;
    }
    if (price && (price - p.stop) * p.dir <= 0) { cerrar(st, p, now, price, 'stop'); return; }
    // salida: una vela de 4 h cierra al otro lado del canal de 20 (se mira cada vela cerrada desde la entrada que aún no se miró)
    for (let i = Math.max(CFG.salida, 0); i < c.length; i++) {
      if (c[i].t + CFG.gran <= p.abre || c[i].t <= (p.h4 || 0)) continue;
      p.h4 = c[i].t;
      const ch = canal(c, i - CFG.salida, i);
      if ((c[i].c - (p.dir > 0 ? ch[1] : ch[0])) * p.dir < 0) { cerrar(st, p, now, price || c[c.length - 1].c, 'canal'); return; }
    }
    return;
  }
  // entrada: solo con la última vela cerrada, y si no se había mirado ya
  const i = c.length - 1; if (i < 0) return;
  if ((st.ultimo[m.code] || 0) >= c[i].t) return;
  st.ultimo[m.code] = c[i].t;
  const s = senalTortuga(c, i, A); if (!s || !price) return;
  s.t = c[i].t;
  const b = bloqueada(st, now); if (b) { evento(st, now, 'omite', 'Señal en ' + m.name + ' sin operar', { motivo: b }); return; }
  if (!abrir(st, m, s, now, price)) evento(st, now, 'omite', 'Señal en ' + m.name + ' sin operar', { motivo: 'riesgo' });
}

/* observa un mercado: apunta cada señal como si se operara y la resuelve con las velas de 4 h */
function observar(st, m, d, now, estrategias) {
  const c = d.h4.filter(k => k.t + CFG.gran <= now); if (c.length < 80) return;
  const A = atr(c, 20), R = rsi(c, 14);
  estrategias.forEach(est => {
    const key = m.code + '|' + est, i = c.length - 1;
    if ((st.ultimo[key] || 0) >= c[i].t) return;
    st.ultimo[key] = c[i].t;
    const s = est === 'tortuga' ? senalTortuga(c, i, A) : senalGiro(c, i, A, R); if (!s) return;
    if (!st.virtuales.some(v => v.k === key)) {
      const stop = est === 'tortuga' ? c[i].c - s.dir * CFG.stopN * s.n : s.extremo - s.dir * 0.25 * s.n;
      st.virtuales.push({ k: key, code: m.code, est: est, dir: s.dir, t: c[i].t + CFG.gran, stop: stop, n: s.n });
    }
    if (d.precio) st.binarias.filter(b => b.indexOf(key + '|') === 0).forEach(b => abrirBinaria(st, m, est, s, +b.split('|')[2], now, d.precio, c[i].t));
  });
  resolverBinarias(st, m, d, now);
  // resolver las señales observadas con las velas cerradas (la de entrada es la primera que abre después de la señal: fines de semana incluidos)
  st.virtuales.filter(v => v.code === m.code).forEach(v => {
    if (c.length && c[0].t > v.t) { v.perdida = true; return; }
    const e = c.findIndex(k => k.t >= v.t); if (e < 0) return;
    const r = simular(c, e, { estrategia: v.est, dir: v.dir, stop: v.stop, n: v.n }, m.rate); if (!r) return;
    const md = st.medidas[v.k] = st.medidas[v.k] || { n: 0, s: 0, s2: 0, g: 0, bin: [[0, 0], [0, 0], [0, 0]] };
    md.n++; md.s = r2(md.s + r.R, 4); md.s2 = r2(md.s2 + r.R * r.R, 4); if (r.R > 0) md.g++;
    r.bin.forEach((b, q) => { if (b >= 0) { md.bin[q][0]++; md.bin[q][1] += b; } });
    v.fin = true;
  });
  st.virtuales = st.virtuales.filter(v => !v.fin && !v.perdida);
}
/* binarias (solo cuando una estrategia las ha validado en ese mercado): importe = riesgo de una unidad; vence a las h velas de 4 h */
function abrirBinaria(st, m, est, s, h, now, precio, sigT) {
  if (bloqueada(st, now) || st.abiertas.some(p => p.code === m.code && p.producto === 'bin' && p.estrategia === est && p.vence > now)) return;
  const imp = r2(CFG.riesgoUnidad * st.saldo, 2), id = 'U' + String(st.sig++).padStart(4, '0');
  st.abiertas.push({ id: id, code: m.code, name: m.name, group: m.group, dec: m.dec, dir: s.dir, tf: 'H4', estrategia: est, producto: 'bin', abre: now, precio: precio,
    vence: now + h * CFG.gran, velas: h, importe: imp, pago: CFG.binaria.pago, riesgo0: imp, comision: 0, unidades: [], stop: null, motivo: { senal: sigT } });
  evento(st, now, 'abre', (s.dir > 0 ? 'Binaria Sube en ' : 'Binaria Baja en ') + m.name, { id: id, precio: precio, velas: h });
}
function resolverBinarias(st, m, d, now) {
  st.abiertas.filter(p => p.code === m.code && p.producto === 'bin' && p.vence <= now).forEach(p => {
    const g = d.m5 ? CFG.m5 : CFG.gran, fin = (d.m5 || d.h4 || []).filter(k => k.t + g <= p.vence).pop();   // el precio al vencer: cierre de la última vela que termina antes del vencimiento
    if (!fin || fin.t + 2 * g < p.vence) return;                                                              // aún no hay datos hasta el vencimiento
    const px = fin.c;
    const gana = (px - p.precio) * p.dir > 0, res = gana ? p.importe * p.pago : -p.importe;
    const t = Object.assign({}, p, { cierra: p.vence, salida: px, salidaPor: 'vence', resultado: r2(res, 2), R: r2(res / p.importe, 2) });
    st.saldo = r2(st.saldo + res, 2); st.pico = Math.max(st.pico, st.saldo); st.maxDD = Math.max(st.maxDD, r2(1 - st.saldo / st.pico, 4));
    t.h = crypto.createHash('sha256').update(st.huella + JSON.stringify([t.id, t.code, t.dir, t.abre, t.precio, t.vence, t.salida, t.resultado])).digest('hex'); st.huella = t.h;
    st.cerradas.unshift(t); st.abiertas = st.abiertas.filter(x => x !== p); st.curva.push([p.vence, st.saldo]);
    evento(st, now, 'cierre', 'Vence la binaria de ' + p.name, { id: p.id, resultado: t.resultado });
  });
}
function decidirEncendidos(st, now) {   // una estrategia en observación que demuestra ventaja se enciende; una que pierde claramente, se apaga
  Object.keys(st.medidas).forEach(k => {
    const md = st.medidas[k], m = md.s / md.n, sd = Math.sqrt(Math.max(1e-12, md.s2 / md.n - m * m)), t = m / sd * Math.sqrt(md.n);
    const [code, est] = k.split('|');
    if (est === 'tortuga' && md.n >= CFG.encender.n && m >= CFG.encender.r && t >= CFG.encender.t && st.encendidos.indexOf(code) < 0) {
      st.encendidos.push(code); evento(st, now, 'enciende', 'Empieza a operar ' + code, { n: md.n, r: r2(m, 3), tStat: r2(t, 1) });
    }
    if (est === 'tortuga' && md.n >= CFG.encender.n && t <= -CFG.encender.t && st.encendidos.indexOf(code) >= 0) {
      st.encendidos = st.encendidos.filter(x => x !== code); evento(st, now, 'apaga', 'Deja de operar ' + code, { n: md.n, r: r2(m, 3), tStat: r2(t, 1) });
    }
    // binarias: acierto al vencer 1, 3 o 5 velas
    md.bin.forEach((b, q) => {
      if (b[0] < CFG.binaria.n) return;
      const p = b[1] / b[0], z = 1.645, lo = (p + z * z / (2 * b[0]) - z * Math.sqrt(p * (1 - p) / b[0] + z * z / (4 * b[0] * b[0]))) / (1 + z * z / b[0]);
      const key = k + '|' + [1, 3, 5][q];
      if (p >= CFG.binaria.p && lo > CFG.binaria.lo && st.binarias.indexOf(key) < 0) { st.binarias.push(key); evento(st, now, 'binaria', 'Binarias validadas en ' + code + ' a ' + [1, 3, 5][q] + ' velas', { p: r2(p * 100, 1), n: b[0] }); }
    });
  });
}

/* una ejecución completa, sin red: datos = { code: { h4: [...], m5: [...], precio } } */
function paso(st, datos, now) {
  if (!st) st = nuevaCuenta(now);
  const ops = CFG.opera.concat(CFG.observa.filter(m => st.encendidos.indexOf(m.code) >= 0));
  ops.forEach(m => { if (datos[m.code] && datos[m.code].h4) gestionar(st, m, datos[m.code], now); });
  CFG.opera.forEach(m => { if (datos[m.code] && datos[m.code].h4) observar(st, m, datos[m.code], now, ['giro']); });
  CFG.observa.forEach(m => { if (datos[m.code] && datos[m.code].h4) observar(st, m, datos[m.code], now, ['tortuga', 'giro']); });
  decidirEncendidos(st, now);
  // valor de la cuenta con lo abierto a precio de ahora
  let vivo = 0; st.abiertas.forEach(p => { const pr = (datos[p.code] || {}).precio; if (pr && p.producto === 'cfd') p.unidades.forEach(u => { vivo += u.tam * (pr - u.p) / u.p * p.dir; }); p.ahora = pr || p.ahora; });
  st.valor = r2(st.saldo + vivo - st.abiertas.reduce((a, p) => a + p.comision, 0), 2);
  const day = Math.floor(now / 86400); if (!st.curva.length || Math.floor(st.curva[st.curva.length - 1][0] / 86400) !== day) st.curva.push([now, st.valor]);
  st.riesgo = r2(riesgoAbierto(st), 2);
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
  const desde = Math.min(now - 3600, (st && st.abiertas.length ? Math.min.apply(null, st.abiertas.map(p => p.revisado)) : now) - 600);
  const n5 = Math.min(1000, Math.ceil((now - desde) / CFG.m5) + 3);
  const opera = CFG.opera.concat(CFG.observa.filter(m => st && st.encendidos.indexOf(m.code) >= 0).map(m => Object.assign({}, m)));
  for (const m of opera) {
    try {
      if (!cl) throw new Error('sin conexión');
      const h4 = await velasDeriv(cl, m.code, CFG.gran, 300), m5 = await velasDeriv(cl, m.code, CFG.m5, n5);
      datos[m.code] = { h4: h4, m5: m5, precio: m5.length ? m5[m5.length - 1].c : null, fuente: 'Deriv' };
    } catch (e) {
      if (!m.kraken) { errores.push(m.code + ': ' + e.message); continue; }
      try { const h4 = await velasKraken(m.kraken, 240), m5 = await velasKraken(m.kraken, 5); datos[m.code] = { h4: h4.slice(-300), m5: m5.slice(-n5), precio: m5.length ? m5[m5.length - 1].c : null, fuente: 'Kraken' }; errores.push(m.code + ': Deriv no respondió, precios de Kraken'); }
      catch (e2) { errores.push(m.code + ': ' + e2.message); }
    }
  }
  for (const m of CFG.observa) {
    if (!cl) break; if (datos[m.code]) continue;
    try { const h4 = await velasDeriv(cl, m.code, CFG.gran, 1000); datos[m.code] = { h4: h4, precio: h4.length ? h4[h4.length - 1].c : null, fuente: 'Deriv' }; }
    catch (e) { errores.push(m.code + ': ' + e.message); }
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
    console.log('saldo ' + st.saldo + ' $, abiertas ' + st.abiertas.length + ', cerradas ' + st.cerradas.length + (errores.length ? ', avisos: ' + errores.join(' | ') : '') + (before && JSON.parse(before).cerradas.length !== st.cerradas.length ? ' (operación cerrada)' : ''));
  })().catch(e => { console.error(e.message); process.exit(1); });
}
module.exports = { CFG, paso, nuevaCuenta, simular, senalTortuga, senalGiro, atr, canal, traerDatos };
