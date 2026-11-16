#!/usr/bin/env node
/* Umbral · el motor del modelo de 15 minutos y del Reto. Dinero ficticio; precios y pagos reales de Deriv.

   Cada vez que cierra una vela de :00, :15, :30 o :45 mira los cinco mercados del modelo (EUR/USD, GBP/USD, USD/JPY, EUR/JPY y oro) y calcula la
   probabilidad de que el precio esté más alto 15 minutos después. Las decisiones más seguras (el 5 % de arriba) se apuntan como señales: pide a Deriv
   lo que paga en ese instante por Sube y por Baja a 15 minutos y, al vencer, las resuelve con los precios de Deriv (entrada = primer precio tras la
   compra; salida = último precio hasta el vencimiento; un empate pierde, como en el contrato real).

   SEÑAL FUERTE: dos o más mercados dan a la vez una señal del 1 % más seguro. En 2021–2026 acertó el 61 % (la que va sola, el 56 %). Solo con las
   fuertes se juega dinero ficticio, en dos cuentas que usan las mismas señales para poder compararlas:
     · escalera (el Reto de siempre): 10 € y a todo; desde el 4.º peldaño guarda la mitad de cada ganancia; en el 9.º cobra; si falla, otra con 10 €;
     · plan por tramos (el reparto que mejor sale en 10.000 simulaciones): escalera corta de 3 peldaños (10 → 60 €) y, desde ahí, el 10 % del dinero
       en cada señal fuerte; si baja de 10 €, vuelve a la escalera.
   En las dos, lo apostado se reparte a partes iguales entre los mercados del grupo (hasta 3). No se entra si Deriv paga menos del 75 %.
   El marcador cuenta todas las señales, operadas o no: por confianza, por dirección, fuertes y solas, y por mercado.

   Uso:  node tools/reto.js datos/reto.json   (un paso con los datos de Deriv de ahora) */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const M = require('./modelo.js'), MODELO = require('./modelo15.json');
const URL_DERIV = 'wss://api.derivws.com/trading/v1/options/ws/public';
const CFG = {
  v: 2, plazo: 900, pagoMin: 0.75, min: 0.5, nivelApunta: 1, nivelFuerte: 3, grupoMin: 2, partesMax: 3, maxPago: null,   // maxPago: tope de pago por contrato (null = sin tope hasta confirmarlo en la cuenta)
  escalera: { inicio: 10, aTodo: 4, guarda: 0.5, tope: 9 },
  plan: { inicio: 10, escalera: 3, fraccion: 0.10, vuelve: 10 },
  codigos: { EURUSD: 'frxEURUSD', GBPUSD: 'frxGBPUSD', USDJPY: 'frxUSDJPY', EURJPY: 'frxEURJPY', XAUUSD: 'frxXAUUSD' },
  nombres: { EURUSD: 'EUR/USD', GBPUSD: 'GBP/USD', USDJPY: 'USD/JPY', EURJPY: 'EUR/JPY', XAUUSD: 'Oro/USD' },
  niveles: ['', '5 % más seguro', '2 % más seguro', '1 % más seguro', '0,5 % más seguro']
};
const r2 = (x, d) => { const p = Math.pow(10, d == null ? 2 : d); return Math.round(x * p) / p; };
const eur = x => x.toFixed(2).replace('.', ',') + ' €', pct = x => Math.round(x * 100) + ' %';

function nuevo(now) {
  return { v: CFG.v, creado: now, actualizado: now, huella: '', n: 0, abiertas: [], senales: [], marcador: {},
    pistas: {
      escalera: { intento: 0, peldano: 0, dinero: 0, guardado: 0, puesto: 0, mejor: 0, llegadas: {}, historia: [], jugada: null, curva: [[now, 0]] },
      plan: { fase: 0, intento: 0, peldano: 0, dinero: 0, puesto: 0, pico: 0, n: 0, ganadas: 0, historia: [], jugada: null, curva: [[now, 0]] }
    },
    eventos: [], ultimaDecision: 0, mirado: [], limites: {} };
}
function evento(st, now, tipo, txt, extra) { st.eventos.unshift(Object.assign({ t: now, tipo: tipo, txt: txt }, extra || {})); if (st.eventos.length > 250) st.eventos.length = 250; }
function suma(st, clave, gana, pago) {   // marcador: [señales, aciertos, suma de pagos, resultado por euro puesto]
  const m = st.marcador[clave] || (st.marcador[clave] = [0, 0, 0, 0]); m[0]++; if (gana) m[1]++; m[2] = r2(m[2] + pago, 4); m[3] = r2(m[3] + (gana ? pago : -1), 4);
}
function punto(curva, now, v) { curva.push([now, r2(v)]); if (curva.length > 500) curva.splice(1, 1); }

/* ---------- las señales de una vela (el modelo) ---------- */
function senales(velas, now, ultima) {
  const cache = {}, mirado = [], lista = []; let visto = ultima || 0;
  M.MER.forEach(mer => {
    const k = velas[mer]; if (!k || !k.t || k.t.length < 700) { mirado.push([mer, null, 'sin datos']); return; }
    const x = M.vector(MODELO, mer, velas, cache), X = cache[mer];
    if (!x || !X) { mirado.push([mer, null, 'sin datos']); return; }
    const cierre = X._t + 300, fresca = now - cierre <= 120;
    if (!M.momento(X)) { mirado.push([mer, null, 'fuera de hora']); return; }
    const p = M.prob(MODELO, x), nivel = M.nivel(MODELO, p);
    if (!fresca || cierre <= (ultima || 0)) { mirado.push([mer, r2(p, 4), !fresca ? 'tarde' : 'ya vista']); return; }
    mirado.push([mer, r2(p, 4), nivel]); if (cierre > visto) visto = cierre;
    if (nivel >= CFG.nivelApunta) lista.push({ mer: mer, p: p, nivel: nivel, t: cierre, precio: k.c[k.c.length - 1], x: { r3: r2(X.r3, 2), r12: r2(X.r12, 2), rsi: Math.round(X.rsi14), pos: r2(X.pos48, 2) } });
  });
  const nf = lista.filter(s => s.nivel >= CFG.nivelFuerte).length;
  lista.forEach(s => { s.grupo = nf; s.fuerte = s.nivel >= CFG.nivelFuerte && nf >= CFG.grupoMin; });
  return { lista: lista, mirado: mirado, visto: visto };
}

/* ---------- las dos cuentas ---------- */
function reparte(total, F, st) {   // reparte `total` a partes iguales entre las señales fuertes (hasta 3), respetando mínimo y tope por contrato
  let m = Math.min(F.length, CFG.partesMax); while (m > 1 && total / m < CFG.min) m--;
  if (!m || total < CFG.min) return [];
  return F.slice(0, m).map(op => { let a = Math.floor(total / m * 100 + 1e-6) / 100; if (CFG.maxPago) a = Math.min(a, Math.floor(CFG.maxPago / (1 + op.pago) * 100) / 100); return { id: op.id, mer: op.mer, apuesta: a, pago: op.pago }; });   // a la baja, al céntimo: nunca se apuesta más de lo que hay
}
function apostarEscalera(st, now, F) {
  const E = st.pistas.escalera, K = CFG.escalera; if (E.jugada) return null;
  if (E.dinero < CFG.min) { E.guardado = r2(E.guardado + E.dinero); E.intento++; E.peldano = 0; E.dinero = K.inicio; E.puesto = r2(E.puesto + K.inicio); }
  const partes = reparte(E.dinero, F, st); if (!partes.length) return null;
  const total = r2(partes.reduce((a, b) => a + b.apuesta, 0)), sobra = r2(E.dinero - total);
  if (sobra > 0.005) E.guardado = r2(E.guardado + sobra);                         // lo que el tope no deja apostar se guarda
  E.jugada = { t: now, partes: partes, total: total, peldano: E.peldano + 1 }; E.dinero = 0;
  return 'Escalera, peldaño ' + (E.peldano + 1) + ': ' + eur(total) + (partes.length > 1 ? ' repartidos en ' + partes.length : '') + '.';
}
function apostarPlan(st, now, F) {
  const P = st.pistas.plan, K = CFG.plan; if (P.jugada) return null;
  if (P.dinero < CFG.min) { P.intento++; P.fase = 0; P.peldano = 0; P.dinero = r2(P.dinero + K.inicio); P.puesto = r2(P.puesto + K.inicio); }
  const total0 = P.fase === 0 ? P.dinero : Math.min(P.dinero, Math.max(CFG.min, P.dinero * K.fraccion));
  const partes = reparte(total0, F, st); if (!partes.length) return null;
  const total = r2(partes.reduce((a, b) => a + b.apuesta, 0));
  P.jugada = { t: now, partes: partes, total: total, fase: P.fase, peldano: P.peldano + 1 }; P.dinero = r2(P.dinero - total);
  return 'Plan: ' + eur(total) + (P.fase === 0 ? ' (escalera corta, peldaño ' + (P.peldano + 1) + ')' : ' (el ' + pct(K.fraccion) + ' de lo que hay)') + '.';
}
function vuelta(jugada, cerradas) {   // lo que devuelve una jugada ya vencida: apuesta × (1 + pago) por cada parte acertada; una operación anulada devuelve la apuesta
  let v = 0, ok = 0; jugada.partes.forEach(p => { const op = cerradas[p.id]; if (!op || op.nula) v += p.apuesta; else if (op.gana) { v += p.apuesta * (1 + p.pago); ok++; } });
  return [r2(v), ok];
}
function liquidarEscalera(st, now, cerradas) {
  const E = st.pistas.escalera, K = CFG.escalera, J = E.jugada; if (!J || !J.partes.every(p => cerradas[p.id])) return;
  const v = vuelta(J, cerradas), dev = v[0]; E.jugada = null; E.dinero = r2(E.dinero + dev); let txt;
  if (dev > J.total + 0.005) {
    E.peldano++; E.llegadas[E.peldano] = (E.llegadas[E.peldano] || 0) + 1; if (E.peldano > E.mejor) E.mejor = E.peldano;
    txt = 'Escalera: peldaño ' + E.peldano + ' superado, ' + eur(E.dinero) + '.';
    if (E.peldano >= K.tope) { E.guardado = r2(E.guardado + E.dinero); txt += ' Tope alcanzado: se cobra todo.'; E.historia.unshift({ t: now, intento: E.intento, peldanos: E.peldano, cobrado: E.dinero }); E.dinero = 0; E.peldano = 0; }
    else if (E.peldano >= K.aTodo) { const g = r2(E.dinero * K.guarda); E.guardado = r2(E.guardado + g); E.dinero = r2(E.dinero - g); txt += ' Se guarda la mitad (' + eur(g) + ') y siguen ' + eur(E.dinero) + '.'; }
  } else if (E.dinero < CFG.min) {
    txt = 'Escalera: falla en el peldaño ' + (E.peldano + 1) + ' y se pierden ' + eur(J.total) + '. La siguiente señal fuerte empieza otra con ' + K.inicio + ' €.';
    E.historia.unshift({ t: now, intento: E.intento, peldanos: E.peldano, cobrado: 0 }); E.guardado = r2(E.guardado + E.dinero); E.dinero = 0; E.peldano = 0;
  } else txt = 'Escalera: ' + v[1] + ' de ' + J.partes.length + ' acertadas; quedan ' + eur(E.dinero) + ' y sigue en el peldaño ' + (E.peldano + 1) + '.';
  if (E.historia.length > 80) E.historia.length = 80;
  punto(E.curva, now, E.guardado + E.dinero - E.puesto); evento(st, now, 'escalera', txt);
}
function liquidarPlan(st, now, cerradas) {
  const P = st.pistas.plan, K = CFG.plan, J = P.jugada; if (!J || !J.partes.every(p => cerradas[p.id])) return;
  const v = vuelta(J, cerradas), dev = v[0]; P.jugada = null; P.dinero = r2(P.dinero + dev); P.n++; let txt;
  const gana = dev > J.total + 0.005; if (gana) P.ganadas++;
  if (J.fase === 0) {
    if (gana) { P.peldano++; txt = 'Plan: peldaño ' + P.peldano + ' de la escalera corta, ' + eur(P.dinero) + '.'; if (P.peldano >= K.escalera) { P.fase = 1; txt += ' Capital hecho: desde ahora, el ' + pct(K.fraccion) + ' en cada señal fuerte.'; } }
    else if (P.dinero < CFG.min) { txt = 'Plan: falla la escalera corta en el peldaño ' + (P.peldano + 1) + '. La siguiente empieza con ' + K.inicio + ' €.'; P.historia.unshift({ t: now, intento: P.intento, peldanos: P.peldano }); P.peldano = 0; }
    else txt = 'Plan: ' + v[1] + ' de ' + J.partes.length + ' acertadas; quedan ' + eur(P.dinero) + '.';
  } else {
    txt = 'Plan: ' + (gana ? 'gana ' + eur(dev - J.total) : dev < J.total - 0.005 ? 'pierde ' + eur(J.total - dev) : 'queda igual') + '; hay ' + eur(P.dinero) + '.';
    if (P.dinero < K.vuelve) { P.fase = 0; P.peldano = 0; txt += ' Baja de ' + K.vuelve + ' €: vuelve a la escalera corta.'; }
  }
  if (P.dinero > P.pico) P.pico = P.dinero; if (P.historia.length > 80) P.historia.length = 80;
  punto(P.curva, now, P.dinero - P.puesto); evento(st, now, 'plan', txt);
}

/* ---------- abrir y cerrar señales ---------- */
function abrir(st, now, s, q) {   // s: señal del modelo; q: [pago sube, pago baja, precio] de Deriv
  const sube = s.p > 0.5, pago = sube ? q[0] : q[1], otro = sube ? q[1] : q[0];
  const op = { id: ++st.n, t: now, vela: s.t, mer: s.mer, lado: sube ? 'sube' : 'baja', p: r2(s.p, 4), nivel: s.nivel, grupo: s.grupo, fuerte: !!s.fuerte, entrada: q[2] != null ? q[2] : s.precio,
    vence: now + CFG.plazo, pago: pago == null ? null : r2(pago, 4), pagoOtro: otro == null ? null : r2(otro, 4), x: s.x, opera: false, por: '' };
  if (pago == null) op.por = 'Deriv no dio precio';
  else if (!op.fuerte) op.por = s.nivel >= CFG.nivelFuerte ? 'va sola: solo se mide' : 'confianza baja: solo se mide';
  else if (pago < CFG.pagoMin) op.por = 'Deriv paga ' + pct(pago) + ': menos del ' + pct(CFG.pagoMin) + ' que hace falta';
  else op.opera = true;
  st.abiertas.push(op); return op;
}
function cerrar(st, now, op, salida, entrada) {
  if (entrada != null) op.entrada = entrada;
  const gana = op.lado === 'sube' ? salida > op.entrada : salida < op.entrada; op.salida = salida; op.gana = gana; op.cerrada = now;
  if (op.pago != null) {
    for (let n = CFG.nivelApunta; n <= op.nivel; n++) suma(st, 'n' + n, gana, op.pago);
    if (op.nivel >= CFG.nivelFuerte) { suma(st, op.fuerte ? 'fuerte' : 'sola', gana, op.pago); suma(st, op.lado, gana, op.pago); suma(st, 'm_' + op.mer, gana, op.pago); }
    if (op.opera) suma(st, 'operadas', gana, op.pago);
  }
  sella(st, op);
}
/* cadena de huellas: cada operación cerrada (o anulada) lleva la huella de la anterior; no se puede retocar el historial sin que se note */
function sella(st, op) {
  const base = { id: op.id, t: op.t, mer: op.mer, lado: op.lado, p: op.p, nivel: op.nivel, fuerte: op.fuerte, entrada: op.entrada, salida: op.salida == null ? null : op.salida, pago: op.pago, gana: op.gana == null ? null : op.gana, opera: op.opera };
  op.h = crypto.createHash('sha256').update(st.huella + JSON.stringify(base)).digest('hex'); st.huella = op.h;
  st.senales.unshift(op); if (st.senales.length > 400) st.senales.length = 400;
}

/* un paso. datos: { salidas: { id: precio }, entradas: { id: precio }, lista: [señales], pagos: { MER: [sube, baja, precio] }, mirado, visto, limites } */
function paso(st, datos, now) {
  st = st || nuevo(now); datos = datos || {};
  // 1) lo que vence
  const sigue = [], cerradas = {};
  st.abiertas.forEach(op => {
    const x = datos.salidas && datos.salidas[op.id];
    if (now >= op.vence && x != null) { cerrar(st, now, op, x, datos.entradas && datos.entradas[op.id]); cerradas[op.id] = op; }
    else if (now > op.vence + 6 * 3600) { op.nula = true; op.cerrada = now; op.por = 'anulada: Deriv no dio el precio de salida'; cerradas[op.id] = op; sella(st, op); evento(st, now, 'aviso', CFG.nombres[op.mer] + ': operación anulada, Deriv no dio el precio de salida.'); }
    else sigue.push(op);
  });
  st.abiertas = sigue;
  // las jugadas se liquidan cuando todas sus partes han vencido (las partes cerradas en pasos anteriores están en st.senales)
  const todas = id => cerradas[id] || st.senales.find(o => o.id === id);
  ['escalera', 'plan'].forEach(k => { const J = st.pistas[k].jugada; if (!J) return; const c = {}; let ok = true; J.partes.forEach(p => { const o = todas(p.id); if (o && !st.abiertas.includes(o)) c[p.id] = o; else ok = false; }); if (ok) (k === 'escalera' ? liquidarEscalera : liquidarPlan)(st, now, c); });
  // 2) señales nuevas
  if (datos.lista && datos.lista.length) {
    const nuevas = datos.lista.filter(s => s.t > st.ultimaDecision && !st.abiertas.some(o => o.mer === s.mer)).map(s => abrir(st, now, s, (datos.pagos || {})[s.mer] || []));
    const F = nuevas.filter(o => o.opera).sort((a, b) => Math.abs(b.p - 0.5) - Math.abs(a.p - 0.5));
    const fuertes = nuevas.filter(o => o.fuerte);
    if (fuertes.length) {
      let txt = 'Señal fuerte (' + fuertes.length + ' mercados a la vez): ' + fuertes.map(o => CFG.nombres[o.mer] + ' ' + (o.lado === 'sube' ? 'Sube' : 'Baja') + ' ' + pct(o.lado === 'sube' ? o.p : 1 - o.p) + (o.pago != null ? ', Deriv paga ' + pct(o.pago) : '')).join(' · ') + '.';
      if (F.length) { const a = apostarEscalera(st, now, F), b = apostarPlan(st, now, F); if (a) txt += ' ' + a; if (b) txt += ' ' + b; }
      else txt += ' No se entra: ' + (fuertes[0].por || 'sin precio') + '.';
      evento(st, now, 'senal', txt, { ids: fuertes.map(o => o.id) });
    }
  }
  if (datos.visto && datos.visto > st.ultimaDecision) st.ultimaDecision = datos.visto;
  if (datos.mirado) st.mirado = [now, datos.mirado];
  if (datos.limites) Object.assign(st.limites, datos.limites);
  st.actualizado = now; return st;
}

/* ---------- datos en vivo ---------- */
const duerme = ms => new Promise(r => setTimeout(r, ms));
function cliente() {
  return new Promise((res, rej) => {
    let ws; try { ws = new WebSocket(URL_DERIV); } catch (e) { return rej(e); }
    let id = 0; const pend = {}, to = setTimeout(() => rej(new Error('Deriv no responde')), 12000);
    ws.onopen = () => { clearTimeout(to); res({ send(msg) { return new Promise(ok => { const rid = ++id; msg.req_id = rid; pend[rid] = ok; ws.send(JSON.stringify(msg)); setTimeout(() => { if (pend[rid]) { delete pend[rid]; ok({ error: { code: 'tarda' } }); } }, 12000); }); }, close() { try { ws.close(); } catch (e) { } } }); };
    ws.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch (x) { return; } const p = pend[d.req_id]; if (p) { delete pend[d.req_id]; p(d); } };
    ws.onerror = () => rej(new Error('no se pudo conectar con Deriv'));
  });
}
async function precios(cl, ops, now, datos, avisos) {   // entrada (primer precio tras la compra) y salida (último hasta el vencimiento) de las operaciones vencidas
  for (const op of ops) {
    if (now < op.vence || datos.salidas[op.id] != null) continue; const sym = CFG.codigos[op.mer];
    const rs = await Promise.all([cl.send({ ticks_history: sym, start: op.t, end: String(op.t + 30), count: 200, style: 'ticks' }), cl.send({ ticks_history: sym, end: String(op.vence), count: 1, style: 'ticks' })]);
    const a = rs[0].history, b = rs[1].history;
    if (a && a.times) { for (let i = 0; i < a.times.length; i++) if (+a.times[i] > op.t) { datos.entradas[op.id] = +a.prices[i]; break; } }
    if (b && b.prices && b.prices.length && op.vence - +b.times[b.times.length - 1] <= 120 && +b.times[b.times.length - 1] > op.t) datos.salidas[op.id] = +b.prices[b.prices.length - 1]; else avisos.push('sin salida de ' + op.mer);
  }
}
async function traer(st, now) {
  const cl = await cliente(), datos = { salidas: {}, entradas: {} }, avisos = [];
  try {
    await precios(cl, st ? st.abiertas : [], now, datos, avisos);
    const min = new Date(now * 1000).getUTCMinutes();
    if (min % 15 < 5 && now % 300 <= 120) {   // acaba de cerrar una vela de cuarto de hora
      const velas = {}, rs = await Promise.all(M.MER.map(mer => cl.send({ ticks_history: CFG.codigos[mer], end: 'latest', count: 1000, style: 'candles', granularity: 300 })));
      M.MER.forEach((mer, i) => {
        const c = (rs[i].candles || []).filter(x => +x.epoch % 300 === 0 && +x.epoch + 300 <= now);   // solo velas ya cerradas
        if (c.length >= 700) velas[mer] = { t: c.map(x => +x.epoch), o: c.map(x => +x.open), h: c.map(x => +x.high), l: c.map(x => +x.low), c: c.map(x => +x.close) };
      });
      const s = senales(velas, now, st ? st.ultimaDecision : 0); datos.lista = s.lista; datos.mirado = s.mirado; datos.visto = s.visto; datos.pagos = {};
      if (s.lista.length) {
        // si una operación anterior vence en los próximos segundos, se espera a resolverla: la apuesta siguiente depende de su resultado
        const prox = (st ? st.abiertas : []).filter(o => o.vence > now && o.vence <= now + 45);
        if (prox.length) { await duerme((Math.max.apply(null, prox.map(o => o.vence)) - now + 2) * 1000); now = Math.floor(Date.now() / 1000); await precios(cl, prox, now, datos, avisos); }
        await Promise.all(s.lista.map(async x => {
          const sym = CFG.codigos[x.mer], ab = await Promise.all(['CALL', 'PUT'].map(t => cl.send({ proposal: 1, amount: 10, basis: 'stake', contract_type: t, currency: 'USD', underlying_symbol: sym, duration: 15, duration_unit: 'm' })));
          const pg = q => q.proposal && q.proposal.payout ? +q.proposal.payout / 10 - 1 : null, sp = (ab[0].proposal && ab[0].proposal.spot) || (ab[1].proposal && ab[1].proposal.spot);
          datos.pagos[x.mer] = [pg(ab[0]), pg(ab[1]), sp != null ? +sp : null];
          if (pg(ab[0]) == null && ab[0].error) avisos.push(x.mer + ': ' + String(ab[0].error.message || ab[0].error.code).slice(0, 90));
        }));
        now = Math.floor(Date.now() / 1000);
        // una vez al día, el límite que Deriv declara por contrato (apuesta mínima y pago máximo)
        datos.limites = {};
        for (const x of s.lista) {
          const L = st && st.limites && st.limites[x.mer]; if (L && now - L.t < 86400) continue;
          const r = await cl.send({ proposal: 1, amount: 100000, basis: 'stake', contract_type: 'CALL', currency: 'USD', underlying_symbol: CFG.codigos[x.mer], duration: 15, duration_unit: 'm' });
          const m = r.error && String(r.error.message || '').match(/Minimum stake of ([\d.]+) and maximum payout of ([\d.]+)/); if (m) datos.limites[x.mer] = { t: now, min: +m[1], maxPago: +m[2] };
        }
      }
    }
  } finally { cl.close(); }
  return { datos, avisos, now };
}

if (require.main === module) {
  (async () => {
    const file = process.argv[2] || 'reto.json';
    let st = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    if (st && st.v !== CFG.v) st = null;                                         // cambio de reglas: cuenta nueva
    const limpia = s => JSON.stringify(Object.assign({}, s, { actualizado: 0, mirado: 0, guardado: 0, avisos: 0 })), antes = st ? limpia(st) : '';
    const r = await traer(st, Math.floor(Date.now() / 1000)); st = paso(st, r.datos, r.now); st.avisos = r.avisos.slice(0, 8);
    const cambia = limpia(st) !== antes, toca = !st.guardado || r.now - st.guardado >= 900 || !!r.datos.mirado;   // se guarda al cambiar algo, en cada decisión, o cada 15 min para decir que sigue vivo
    if (!cambia && !toca) { console.log('reto: sin cambios'); return; }
    st.guardado = r.now; fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(st) + '\n'); fs.renameSync(file + '.tmp', file);
    const f = st.marcador.fuerte || [0, 0], n3 = st.marcador.n3 || [0, 0], E = st.pistas.escalera, P = st.pistas.plan;
    console.log('reto: abiertas ' + st.abiertas.length + ' · medidas ' + st.n + ' · 1 %: ' + n3[1] + '/' + n3[0] + ' · fuertes: ' + f[1] + '/' + f[0] + ' · escalera: intento ' + E.intento + ', peldaño ' + E.peldano + ', guardado ' + E.guardado + ' · plan: ' + P.dinero + (r.avisos.length ? ' · avisos: ' + r.avisos.join(' | ') : ''));
  })().catch(e => { console.error('reto: ' + e.message); process.exit(1); });
}
module.exports = { CFG, paso, nuevo, senales, abrir, cerrar, sella, traer };
