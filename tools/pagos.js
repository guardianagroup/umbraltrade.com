#!/usr/bin/env node
/* Umbral · recolector de pagos de Deriv (prueba de una semana, del 16 al 23-11-2026, petición de Francisco).
   Pregunta: ¿se equivoca alguna vez el modelo de precios de Deriv? Deriv paga distinto por Sube y por Baja según cómo se ha movido el
   precio; lo que paga dice qué probabilidad le da a cada lado (1 / (1 + pago)). Para saber si hay momentos en que se equivoca, se guarda
   cada 5 minutos lo que paga por los dos lados a 15 minutos, 1 hora, 1 día y 1 semana, y después se comprueba con los precios de Deriv qué pasó.
   Solo lee la API pública (sin cuenta, sin operar). Una línea JSON por mercado y plazo:
     { t: hora de la cotización (s), s: mercado, d: plazo (15 y 60 = minutos; «1d» y «7d» = días), sube / baja: pago por euro (0,80 = paga 80 céntimos además del euro),
       spot / st: precio y hora de ese precio, e: código de error si Deriv no cotiza (mercado cerrado, plazo no disponible...) }
   Uso: node tools/pagos.js CARPETA FIN    (FIN = hora de parar, en segundos UNIX). Escribe CARPETA/AAAA-MM-DD.jsonl. */
'use strict';
const fs = require('fs'), path = require('path');
const URL_DERIV = 'wss://api.derivws.com/trading/v1/options/ws/public';
const SYMS = ['frxXAUUSD', 'frxXAGUSD', 'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD', 'OTC_SPC', 'OTC_NDX', 'OTC_DJI'];   // Bitcoin fuera: Deriv no vende Sube/Baja en cripto; entra la plata
const DURS = [[15, 'm'], [60, 'm'], [1, 'd'], [7, 'd']];   // 1 d y 7 d añadidos el 16-11 a las 22:30 (¿paga Deriv la subida de fondo de los índices?)
const dir = process.argv[2], fin = +process.argv[3];
if (!dir || !(fin > 0)) { console.error('uso: node pagos.js CARPETA FIN'); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
let ws = null, rid = 0;
const pend = {};
function conecta() {
  return new Promise(res => {
    let hecho = false; const ok = v => { if (!hecho) { hecho = true; res(v); } };
    try { ws = new WebSocket(URL_DERIV); } catch (e) { ws = null; return ok(false); }
    ws.onopen = () => ok(true);
    ws.onerror = () => ok(false);
    ws.onclose = () => { ws = null; ok(false); };
    ws.onmessage = ev => { let d; try { d = JSON.parse(ev.data); } catch (e) { return; } const f = d.req_id && pend[d.req_id]; if (f) { delete pend[d.req_id]; f(d); } };
    setTimeout(() => ok(false), 15000);
  });
}
function pide(msg) {
  return new Promise(ok => {
    if (!ws || ws.readyState !== 1) return ok({ error: { code: 'sin conexión' } });
    const id = ++rid; msg.req_id = id; pend[id] = ok;
    try { ws.send(JSON.stringify(msg)); } catch (e) { delete pend[id]; return ok({ error: { code: 'envío' } }); }
    setTimeout(() => { if (pend[id]) { delete pend[id]; ok({ error: { code: 'tarda' } }); } }, 15000);
  });
}
const r4 = x => Math.round(x * 1e4) / 1e4;
async function muestra() {
  if (!ws || ws.readyState !== 1) { for (let i = 0; i < 3 && !(await conecta()); i++) await new Promise(r => setTimeout(r, 5000)); }
  const t = Math.floor(Date.now() / 1000), out = [];
  for (const s of SYMS) {
    for (const [dv, du] of DURS) {
      const d = du === 'm' ? dv : dv + du;
      const rs = await Promise.all(['CALL', 'PUT'].map(ct => pide({ proposal: 1, amount: 10, basis: 'stake', contract_type: ct, currency: 'USD', underlying_symbol: s, duration: dv, duration_unit: du })));
      const q = rs.map(r => (r && r.proposal) || null), a = q[0] || q[1] || {}, err = rs.map(r => r && r.error && r.error.code).filter(Boolean)[0];
      const o = { t: t, s: s, d: d, sube: q[0] && q[0].payout ? r4(q[0].payout / 10 - 1) : null, baja: q[1] && q[1].payout ? r4(q[1].payout / 10 - 1) : null, spot: a.spot != null ? +a.spot : null, st: a.spot_time || null };
      if (err) o.e = err;
      out.push(o);
    }
  }
  const f = path.join(dir, new Date(t * 1000).toISOString().slice(0, 10) + '.jsonl');
  fs.appendFileSync(f, out.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log(new Date(t * 1000).toISOString().slice(11, 16) + ' UTC · ' + out.filter(x => x.sube != null && x.baja != null).length + ' de ' + out.length + ' con pago en los dos lados');
}
(async () => {
  setInterval(() => { if (ws && ws.readyState === 1) try { ws.send(JSON.stringify({ ping: 1 })); } catch (e) { } }, 30000);   // Deriv corta a los 2 minutos sin mensajes
  while (Date.now() / 1000 < fin) {
    const now = Date.now() / 1000, next = Math.ceil((now - 20) / 300) * 300 + 20;   // a los 20 s de cada múltiplo de 5 minutos
    if (next >= fin) break;
    await new Promise(r => setTimeout(r, Math.max(0, next - now) * 1000));
    try { await muestra(); } catch (e) { console.log('fallo: ' + e.message); }
  }
  try { if (ws) ws.close(); } catch (e) { }
  process.exit(0);
})();
