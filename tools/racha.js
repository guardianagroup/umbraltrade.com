#!/usr/bin/env node
/* Umbral · La racha de 1 minuto. Dinero ficticio; ticks y pagos reales de Deriv (API pública, sin cuenta).

   Idea de Francisco (16-11-2026): operaciones cortas en sintéticos, empezar con 50 € y reinvertir todo, a ver cuántas seguidas salen. La meta: más de 9.
   · Sigue tick a tick 16 índices sintéticos de Deriv (Volatility, Jump y Step).
   · Forma de operar: soporte y resistencia de los últimos 5 minutos. Si un índice toca el mínimo de esos 5 minutos, Sube; si toca el máximo, Baja.
     Si hay varios a la vez, el más estirado (el que más lejos está de su media de 5 minutos, en desviaciones).
   · Dinero: 50 € a todo. Si acierta, todo a la siguiente; si falla, otra vez 50 €. A los 10 aciertos seguidos cobra («suena la campana») y empieza
     con 50 €, sin cortar la cuenta de aciertos seguidos.
   · Contrato: Sube/Baja de 1 minuto, como en Deriv: entrada = primer tick después de la compra; salida = último tick hasta el vencimiento; si la
     salida es igual a la entrada, pierde. El pago es el que Deriv ofrece (proposal), al día cada 10 minutos.
   · A la vez, sin dinero, mide tres formas en los 16 índices (una operación abierta por forma e índice): «sr5» (la de la racha), «impulso» (a favor
     de un movimiento de más de 2 desviaciones en 15 s) y «azar» (sentido al azar: la referencia con la que comparar).
   Uso: node tools/racha.js datos/racha.json [fin_epoch]   (corre hasta fin_epoch; guarda el estado cada 10 s y añade cada operación a racha-ops.jsonl) */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const URL_DERIV = process.env.RACHA_URL || 'wss://api.derivws.com/trading/v1/options/ws/public';
const CFG = {
  v: 1, dur: 60, inicio: 50, meta: 10, ventana: 300, margen: 3, impSeg: 15, impZ: 2, minApuesta: 0.35, maxPagoContrato: 10000,
  syms: ['1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V', 'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'JD10', 'JD25', 'JD50', 'JD75', 'JD100', 'stpRNG'],
  nombres: { '1HZ10V': 'Volatility 10 (1s)', '1HZ25V': 'Volatility 25 (1s)', '1HZ50V': 'Volatility 50 (1s)', '1HZ75V': 'Volatility 75 (1s)', '1HZ100V': 'Volatility 100 (1s)',
    R_10: 'Volatility 10', R_25: 'Volatility 25', R_50: 'Volatility 50', R_75: 'Volatility 75', R_100: 'Volatility 100',
    JD10: 'Jump 10', JD25: 'Jump 25', JD50: 'Jump 50', JD75: 'Jump 75', JD100: 'Jump 100', stpRNG: 'Step 100' },
  familias: ['sr5', 'impulso', 'azar']
};
const r2 = (x, d) => { const p = Math.pow(10, d == null ? 2 : d); return Math.round(x * p) / p; };
const eur = x => x.toFixed(2).replace('.', ',') + ' €';

function nuevo(now) {
  return { v: CFG.v, creado: now, actualizado: now, n: 0, huella: '',
    cuenta: { intento: 0, peldano: 0, dinero: 0, guardado: 0, puesto: 0, campanas: 0, cobros: [], racha: 0, mejorRacha: 0, mejorT: 0, mejorPeldano: 0, rachas: {},
      n: 0, ganadas: 0, empates: 0, sym: {}, lado: {}, fuerza: {}, jugada: null, curva: [[now, 0]] },
    ops: [], medida: {}, eventos: [], conexion: { reconexiones: 0 }, avisos: [], cfg: cfgPublica() };
}
function cfgPublica() { return { dur: CFG.dur, inicio: CFG.inicio, meta: CFG.meta, ventana: CFG.ventana, impZ: CFG.impZ, syms: CFG.syms, nombres: CFG.nombres }; }
function evento(st, now, tipo, txt) { st.eventos.unshift({ t: now, tipo: tipo, txt: txt }); if (st.eventos.length > 150) st.eventos.length = 150; }
function suma(m, k, gana, emp) { const c = m[k] || (m[k] = [0, 0, 0]); c[0]++; if (gana) c[1]++; if (emp) c[2]++; }

/* ---------- ticks ---------- */
function mete(b, t, q) {   // añade un tick en su sitio (sin repetir) y olvida lo de hace más de 1.000 s
  const n = b.t.length;
  if (!n || t > b.t[n - 1]) { b.t.push(t); b.q.push(q); }
  else { let i = n - 1; while (i >= 0 && b.t[i] > t) i--; if (i >= 0 && b.t[i] === t) return false; b.t.splice(i + 1, 0, t); b.q.splice(i + 1, 0, q); }
  const lim = b.t[b.t.length - 1] - 1000; let k = 0; while (k < b.t.length && b.t[k] < lim) k++;
  if (k > 100) { b.t.splice(0, k); b.q.splice(0, k); }
  return true;
}
/* lo que se mira en el último tick: mínimo y máximo de los 5 minutos anteriores (sin los 3 últimos segundos), dónde está el precio y cómo se ha movido */
function rasgos(b, i) {
  if (!b || !b.t.length) return null; i = i == null ? b.t.length - 1 : i; if (i < 10) return null;
  const t = b.t[i], q = b.q[i], desde = t - CFG.ventana, hasta = t - CFG.margen;
  let j = i; while (j > 0 && b.t[j - 1] >= desde) j--;
  if (b.t[j] > desde + 15) return null;                                  // hace falta la ventana entera
  let lo = Infinity, hi = -Infinity, s = 0, s2 = 0, n = 0, rs2 = 0, rn = 0, hueco = 0;
  for (let k = j; k <= i; k++) {
    if (b.t[k] <= hasta) { const x = b.q[k]; if (x < lo) lo = x; if (x > hi) hi = x; s += x; s2 += x * x; n++; }
    if (k > j) { const r = Math.log(b.q[k] / b.q[k - 1]); rs2 += r * r; rn++; if (b.t[k] - b.t[k - 1] > hueco) hueco = b.t[k] - b.t[k - 1]; }
  }
  if (n < 20 || !rn || hueco > 10) return null;                          // pocos ticks o un hueco: no se decide
  const paso = (t - b.t[j]) / (i - j), sd1 = Math.sqrt(rs2 / rn / paso);  // desviación del rendimiento de 1 segundo
  const atras = sec => { let k = i; while (k > j && b.t[k] > t - sec) k--; return b.q[k]; };
  const zr = sec => sd1 > 0 ? Math.log(q / atras(sec)) / (sd1 * Math.sqrt(sec)) : 0;
  const media = s / n, sdp = Math.sqrt(Math.max(s2 / n - media * media, 0));
  return { t: t, q: q, lo: lo, hi: hi, z: sdp > 0 ? (q - media) / sdp : 0, pos: hi > lo ? (q - lo) / (hi - lo) : 0.5, sd1: sd1, paso: paso,
    z10: zr(10), z15: zr(CFG.impSeg), z30: zr(30), z60: zr(60) };
}
function senal(fam, f, rnd) {
  if (!f) return null;
  if (fam === 'sr5') return f.q <= f.lo ? 'sube' : f.q >= f.hi ? 'baja' : null;
  if (fam === 'impulso') return Math.abs(f.z15) >= CFG.impZ ? (f.z15 > 0 ? 'sube' : 'baja') : null;
  if (fam === 'azar') return (rnd || Math.random)() < 0.5 ? 'sube' : 'baja';
  return null;
}
function fuerzaDe(fam, f) { return fam === 'impulso' ? Math.abs(f.z15) : Math.abs(f.z); }
function tramo(fam, x) {
  if (fam === 'azar') return '-';
  const cortes = fam === 'impulso' ? [2.5, 3, 4] : [1.5, 2, 2.5, 3];
  for (let k = 0; k < cortes.length; k++) if (x < cortes[k]) return k === 0 ? '<' + cortes[0] : cortes[k - 1] + '-' + cortes[k];
  return '>=' + cortes[cortes.length - 1];
}
/* entrada = primer tick después de la compra; salida = último tick hasta el vencimiento. undefined: aún no ha vencido; null: hueco, no se sabe */
function resuelve(b, op) {
  if (!b || !b.t.length) return undefined;
  if (b.t[b.t.length - 1] < op.e) return undefined;
  let i = 0; while (i < b.t.length && b.t[i] <= op.s) i++;
  if (i >= b.t.length || b.t[i] > op.s + 5 || (i > 0 && op.s - b.t[i - 1] > 5) || i === 0) return null;
  let k = b.t.length - 1; while (k > i && b.t[k] > op.e) k--;
  if (op.e - b.t[k] > 4 || b.t[k] > op.e) return null;
  const en = b.q[i], sa = b.q[k];
  return { entrada: en, salida: sa, te: b.t[i], ts: b.t[k], gana: op.lado === 'sube' ? sa > en : sa < en, emp: sa === en };
}

/* ---------- la cuenta de la racha ---------- */
function elige(B, now, pago) {   // la señal sr5 más estirada entre los 16 índices, con su pago
  let mejor = null;
  CFG.syms.forEach(s => {
    const b = B[s]; if (!b || !b.t.length || now - b.t[b.t.length - 1] > 3) return;
    const f = rasgos(b), l = senal('sr5', f); if (!l) return;
    const p = pago(s, l); if (p == null) return;
    const fz = Math.abs(f.z); if (!mejor || fz > mejor.fz) mejor = { s: s, l: l, f: f, p: p, fz: fz };
  });
  return mejor;
}
function abre(st, now, m) {
  const C = st.cuenta;
  if (C.dinero < CFG.minApuesta) { C.intento++; C.peldano = 0; C.dinero = CFG.inicio; C.puesto = r2(C.puesto + CFG.inicio); }
  const ap = r2(C.dinero), f = m.f;
  C.jugada = { id: ++st.n, s: now, e: now + CFG.dur, sym: m.s, lado: m.l, pago: m.p, apuesta: ap, peldano: C.peldano + 1, intento: C.intento,
    contratos: Math.max(1, Math.ceil(ap * (1 + m.p) / CFG.maxPagoContrato)),
    x: { z: r2(f.z, 2), pos: r2(f.pos, 2), z10: r2(f.z10, 2), z30: r2(f.z30, 2), z60: r2(f.z60, 2), sd: r2(f.sd1 * 1e4, 3), p: f.q, lo: f.lo, hi: f.hi } };
  C.dinero = 0; return C.jugada;
}
function cierra(st, now, r) {
  const C = st.cuenta, J = C.jugada; if (!J) return null; C.jugada = null;
  const op = Object.assign({}, J, { entrada: r.entrada, salida: r.salida, te: r.te, ts: r.ts, gana: !!r.gana, emp: !!r.emp, cerrada: now });
  C.n++; if (op.gana) C.ganadas++; if (op.emp) C.empates++;
  suma(C.sym, J.sym, op.gana, op.emp); suma(C.lado, J.lado, op.gana, op.emp); suma(C.fuerza, tramo('sr5', Math.abs(J.x.z)), op.gana, op.emp);
  if (op.gana) {
    C.racha++; C.peldano++; C.dinero = r2(J.apuesta * (1 + J.pago));
    if (C.racha > C.mejorRacha) { C.mejorRacha = C.racha; C.mejorT = now; }
    if (C.peldano > C.mejorPeldano) C.mejorPeldano = C.peldano;
    if (C.peldano >= CFG.meta) {
      C.campanas++; C.guardado = r2(C.guardado + C.dinero); C.cobros.unshift({ t: now, intento: C.intento, cobrado: C.dinero });
      evento(st, now, 'campana', '¡Suena la campana! ' + C.peldano + ' aciertos seguidos en este intento: se cobran ' + eur(C.dinero) + '. La racha sigue contando.');
      C.dinero = 0; C.peldano = 0;
    } else if (C.peldano >= 5) evento(st, now, 'peldano', 'Peldaño ' + C.peldano + ' (' + CFG.nombres[J.sym] + ', ' + (J.lado === 'sube' ? 'Sube' : 'Baja') + '): hay ' + eur(C.dinero) + '.');
  } else {
    C.rachas[C.racha] = (C.rachas[C.racha] || 0) + 1;
    if (C.peldano >= 4) evento(st, now, 'cae', 'Cae en el peldaño ' + (C.peldano + 1) + ' (' + CFG.nombres[J.sym] + ', ' + (J.lado === 'sube' ? 'Sube' : 'Baja') + (op.emp ? ', empate' : '') + '): se pierden ' + eur(J.apuesta) + '.');
    C.racha = 0; C.peldano = 0; C.dinero = 0;
  }
  if (C.racha === C.mejorRacha && C.racha >= 3 && op.gana && C.mejorT === now) evento(st, now, 'record', 'Nueva mejor racha: ' + C.racha + ' aciertos seguidos.');
  op.racha = C.racha; sella(st, op);
  st.ops.unshift(op); if (st.ops.length > 300) st.ops.length = 300;
  (st._nuevas || (st._nuevas = [])).push(op);
  C.curva.push([now, r2(C.guardado + C.dinero - C.puesto)]); if (C.curva.length > 1500) C.curva.splice(1, 1);
  return op;
}
function anula(st, now, motivo) {   // sin precio de salida: se devuelve lo puesto y se sigue en el mismo peldaño
  const C = st.cuenta, J = C.jugada; if (!J) return; C.jugada = null; C.dinero = r2(C.dinero + J.apuesta);
  const op = Object.assign({}, J, { nula: true, por: motivo, cerrada: now }); sella(st, op); st.ops.unshift(op); (st._nuevas || (st._nuevas = [])).push(op);
  evento(st, now, 'aviso', 'Operación anulada (' + motivo + '): se devuelven ' + eur(J.apuesta) + '.');
}
function sella(st, op) {   // cadena de huellas: no se puede retocar el historial sin que se note
  const base = { id: op.id, s: op.s, sym: op.sym, lado: op.lado, pago: op.pago, apuesta: op.apuesta, entrada: op.entrada == null ? null : op.entrada, salida: op.salida == null ? null : op.salida, gana: op.gana == null ? null : op.gana, nula: !!op.nula };
  op.h = crypto.createHash('sha256').update(st.huella + JSON.stringify(base)).digest('hex'); st.huella = op.h;
}

/* ---------- las mediciones (sin dinero) ---------- */
function mide(st, med, sym, b, rnd, pago) {   // abre lo que toque en este índice (una operación por forma e índice)
  const f = rasgos(b); if (!f) return;
  CFG.familias.forEach(fam => {
    const k = fam + '|' + sym; if (med[k]) return;
    const l = senal(fam, f, rnd); if (!l) return;
    med[k] = { fam: fam, sym: sym, lado: l, s: f.t, e: f.t + CFG.dur, pago: pago(sym, l), fz: fam === 'azar' ? 0 : fuerzaDe(fam, f), h: new Date(f.t * 1000).getUTCHours() };
  });
}
function anota(st, op, r) {
  const M = st.medida[op.fam] || (st.medida[op.fam] = { total: [0, 0, 0], res: 0, sym: {}, lado: {}, fuerza: {}, hora: {} });
  suma(M, 'total', r.gana, r.emp); M.total = M.total; suma(M.sym, op.sym, r.gana, r.emp); suma(M.lado, op.lado, r.gana, r.emp);
  suma(M.fuerza, tramo(op.fam, op.fz), r.gana, r.emp); suma(M.hora, String(op.h), r.gana, r.emp);
  if (op.pago != null) M.res = r2(M.res + (r.gana ? op.pago : -1), 3);
}
function vence(st, med, sym, b, now) {   // resuelve lo que ha vencido en este índice
  const C = st.cuenta;
  if (C.jugada && C.jugada.sym === sym) { const r = resuelve(b, C.jugada); if (r) cierra(st, now, r); else if (r === null) C.jugada.hueco = true; }
  CFG.familias.forEach(fam => {
    const k = fam + '|' + sym, op = med[k]; if (!op) return;
    const r = resuelve(b, op); if (r === undefined) return;
    delete med[k]; if (r) anota(st, op, r); else { const M = st.medida[fam] || (st.medida[fam] = { total: [0, 0, 0], res: 0, sym: {}, lado: {}, fuerza: {}, hora: {} }); M.huecos = (M.huecos || 0) + 1; }
  });
}

/* ---------- en vivo ---------- */
function main() {
  const file = process.argv[2] || 'racha.json', fin = +(process.argv[3] || (Date.now() / 1000 + 345 * 60)), opsFile = path.join(path.dirname(path.resolve(file)), 'racha-ops.jsonl');
  let st = null; try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { }
  if (!st || st.v !== CFG.v) st = nuevo(Math.floor(Date.now() / 1000));
  st.cfg = cfgPublica(); st.avisos = [];
  const B = {}, med = {}, PAGO = {}; let ws = null, rid = 0, pend = {}, desfase = 0, ultimoTick = 0, cambios = true, cerrando = false, conectado = false;
  CFG.syms.forEach(s => { B[s] = { t: [], q: [] }; });
  const ahora = () => Math.floor(Date.now() / 1000 + desfase);
  const pago = (s, l) => PAGO[s] && PAGO[s][l] != null ? PAGO[s][l] : null;
  const pide = msg => new Promise(ok => { if (!ws || ws.readyState !== 1) return ok({ error: { code: 'sin conexión' } }); const id = ++rid; msg.req_id = id; pend[id] = ok; try { ws.send(JSON.stringify(msg)); } catch (e) { delete pend[id]; return ok({ error: { code: 'envío' } }); } setTimeout(() => { if (pend[id]) { delete pend[id]; ok({ error: { code: 'tarda' } }); } }, 15000); });
  const aviso = txt => { st.avisos.unshift(new Date().toISOString().slice(11, 19) + ' ' + txt); if (st.avisos.length > 10) st.avisos.length = 10; console.log('racha: ' + txt); };
  function guarda() {
    const nuevas = st._nuevas || []; delete st._nuevas;
    if (nuevas.length) try { fs.appendFileSync(opsFile, nuevas.map(o => JSON.stringify(o)).join('\n') + '\n'); } catch (e) { aviso('no se pudo apuntar en racha-ops.jsonl'); }
    st.actualizado = ahora(); st.vivo = { t: st.actualizado, conectado: conectado, ticks: CFG.syms.filter(s => B[s].t.length && st.actualizado - B[s].t[B[s].t.length - 1] < 10).length, abiertasMedida: Object.keys(med).length };
    try { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(st) + '\n'); fs.renameSync(file + '.tmp', file); } catch (e) { aviso('no se pudo guardar: ' + e.message); }
    cambios = false;
  }
  async function pagos() {
    for (const s of CFG.syms) {
      const rs = await Promise.all(['CALL', 'PUT'].map(ct => pide({ proposal: 1, amount: 10, basis: 'stake', contract_type: ct, currency: 'USD', underlying_symbol: s, duration: CFG.dur / 60, duration_unit: 'm' })));
      const pg = r => r && r.proposal && r.proposal.payout ? r2(+r.proposal.payout / 10 - 1, 4) : null;
      if (pg(rs[0]) != null || pg(rs[1]) != null) PAGO[s] = { sube: pg(rs[0]), baja: pg(rs[1]), t: ahora() };
      else if (rs[0].error) aviso('sin pago de ' + s + ': ' + String(rs[0].error.message || rs[0].error.code).slice(0, 80));
    }
    st.pagos = PAGO; cambios = true;
  }
  async function rellena(s) {   // los últimos ticks de Deriv, para tener la ventana entera al empezar o tras un corte
    const r = await pide({ ticks_history: s, end: 'latest', count: 700, style: 'ticks' });
    if (r.history && r.history.times) r.history.times.forEach((t, i) => mete(B[s], +t, +r.history.prices[i]));
  }
  async function pendiente() {   // una jugada sin resolver (la dejó abierta la tarea anterior o hubo un corte): se resuelve con el historial de ticks de Deriv
    const J = st.cuenta.jugada; if (!J || J.pidiendo || ahora() < J.e + 2) return;
    J.pidiendo = true;
    const r = await pide({ ticks_history: J.sym, start: J.s - 10, end: String(J.e + 10), count: 500, style: 'ticks' });
    delete J.pidiendo; if (st.cuenta.jugada !== J) return;                       // ya se resolvió por otro lado
    if (!r.history || !r.history.times) { if (ahora() > J.e + 3600) anula(st, ahora(), 'Deriv no dio los ticks'); return; }
    const b = { t: [], q: [] }; r.history.times.forEach((t, i) => mete(b, +t, +r.history.prices[i]));
    const x = resuelve(b, J); if (x) cierra(st, ahora(), x); else if (x === null) anula(st, ahora(), 'hueco en los ticks'); cambios = true;
  }
  function conecta() {
    if (cerrando) return;
    try { ws = new WebSocket(URL_DERIV); } catch (e) { aviso('no se pudo abrir la conexión'); return setTimeout(conecta, 5000); }
    ws.onopen = async () => {
      conectado = true; st.conexion.ultima = Math.floor(Date.now() / 1000); cambios = true;
      CFG.syms.forEach(s => { try { ws.send(JSON.stringify({ ticks: s, subscribe: 1 })); } catch (e) { } });
      await Promise.all(CFG.syms.map(rellena)); await pagos(); await pendiente();
    };
    ws.onmessage = e => {
      let d; try { d = JSON.parse(e.data); } catch (x) { return; }
      if (d.msg_type === 'tick' && d.tick) {
        const s = d.tick.underlying_symbol || d.tick.symbol, t = +d.tick.epoch, q = +d.tick.quote; if (!B[s] || !isFinite(t) || !isFinite(q)) return;
        desfase = t - Date.now() / 1000; ultimoTick = Date.now();
        if (!mete(B[s], t, q)) return;
        vence(st, med, s, B[s], t); if (!cerrando) mide(st, med, s, B[s], Math.random, pago); cambios = true;
        return;
      }
      const p = d.req_id && pend[d.req_id]; if (p) { delete pend[d.req_id]; p(d); }
    };
    ws.onclose = () => { conectado = false; if (cerrando) return; st.conexion.reconexiones++; aviso('conexión cortada; se vuelve a conectar'); Object.keys(med).forEach(k => delete med[k]); setTimeout(conecta, 3000); };
    ws.onerror = () => { try { ws.close(); } catch (e) { } };
  }
  conecta();
  // cada segundo: la racha decide si está libre; cada 10 s se guarda; cada 10 min, los pagos al día
  setInterval(() => {
    const now = ahora();
    if (cerrando) return;
    if (ultimoTick && Date.now() - ultimoTick > 25000 && ws) { aviso('sin ticks en 25 s'); ultimoTick = Date.now(); try { ws.close(); } catch (e) { } }
    const C = st.cuenta;
    if (C.jugada && now > C.jugada.e + 20) { pendiente(); }
    if (!C.jugada && conectado && now < fin - CFG.dur - 15) { const m = elige(B, now, pago); if (m) { abre(st, now, m); cambios = true; } }
    if (!C.jugada && now >= fin - CFG.dur - 15) { cerrando = true; guarda(); try { ws.close(); } catch (e) { } console.log('racha: fin del tramo · ' + resumen(st)); setTimeout(() => process.exit(0), 500); }
  }, 1000);
  setInterval(() => { if (cambios) guarda(); }, 10000);
  setInterval(() => { if (conectado) pagos(); }, 600000);
  setInterval(() => console.log('racha: ' + resumen(st)), 300000);
  setTimeout(() => { aviso('tiempo agotado'); guarda(); process.exit(0); }, Math.max(60, fin - Date.now() / 1000 + 90) * 1000);
  process.on('SIGTERM', () => { cerrando = true; guarda(); process.exit(0); });
}
function resumen(st) {
  const C = st.cuenta, m = st.medida, pc = k => m[k] && m[k].total[0] ? (100 * m[k].total[1] / m[k].total[0]).toFixed(1) + ' % de ' + m[k].total[0] : '–';
  return 'jugadas ' + C.n + ' (' + C.ganadas + ' aciertos) · racha ' + C.racha + ', mejor ' + C.mejorRacha + ' · intento ' + C.intento + ', peldaño ' + C.peldano + ' · campanas ' + C.campanas +
    ' · resultado ' + r2(C.guardado + C.dinero + (C.jugada ? C.jugada.apuesta : 0) - C.puesto) + ' · medida: sr5 ' + pc('sr5') + ', impulso ' + pc('impulso') + ', azar ' + pc('azar');
}
if (require.main === module) main();
module.exports = { CFG, nuevo, mete, rasgos, senal, resuelve, elige, abre, cierra, anula, mide, vence, anota, tramo, resumen, main };
