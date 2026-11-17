/* Pantalla del robot de Umbral: cuenta simulada con dinero ficticio, en directo.
   Calcula en el navegador, con velas públicas (Binance, Deriv, Hyperliquid), las mismas entradas que las flechas de tendencia de la web
   y que el robot que corre en GitHub (robot.js): 30 min, 1 h y 4 h, filtro de la media de 200 velas, ampliaciones a +0,5 y +1 vez el
   riesgo con el stop común donde están activas, y salida por stop o por cambio de tendencia. No envía nada a ningún sitio. */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : globalThis;
  var A = W.U.algo, G = A.GRAN, HTF = A.WAVE_TF;
  var START = Date.UTC(2026, 10, 17, 21, 30) / 1000;   // 17-11-2026, 16:30 de Bogotá: cuando se encendió el robot
  var H14 = { H1: 1, H4: 1 }, ALL = { M30: 1, H1: 1, H4: 1 };
  var MK = [
    { code: 'BTC', nombre: 'Bitcoin', src: 'bn', sym: 'BTCUSDT', g: 'cripto', com: 0.0007, tfs: ['M30', 'H1', 'H4'], adds: H14 },
    { code: 'ETH', nombre: 'Ethereum', src: 'bn', sym: 'ETHUSDT', g: 'cripto', com: 0.001166, tfs: ['M30', 'H1', 'H4'], adds: ALL },
    { code: 'SOL', nombre: 'Solana', src: 'bn', sym: 'SOLUSDT', g: 'cripto', com: 0.001, tfs: ['H1', 'H4'], adds: H14 },
    { code: 'XRP', nombre: 'XRP', src: 'bn', sym: 'XRPUSDT', g: 'cripto', com: 0.001, tfs: ['H1', 'H4'], adds: H14 },
    { code: 'BNB', nombre: 'BNB', src: 'bn', sym: 'BNBUSDT', g: 'cripto', com: 0.001, tfs: ['M30', 'H1', 'H4'], adds: H14 },
    { code: 'DOGE', nombre: 'Dogecoin', src: 'bn', sym: 'DOGEUSDT', g: 'cripto', com: 0.001, tfs: ['H1', 'H4'], adds: {} },
    { code: 'ADA', nombre: 'Cardano', src: 'bn', sym: 'ADAUSDT', g: 'cripto', com: 0.001, tfs: ['M30', 'H1', 'H4'], adds: ALL },
    { code: 'LTC', nombre: 'Litecoin', src: 'bn', sym: 'LTCUSDT', g: 'cripto', com: 0.001, tfs: ['H1', 'H4'], adds: {} },
    { code: 'AVAX', nombre: 'Avalanche', src: 'bn', sym: 'AVAXUSDT', g: 'cripto', com: 0.001, tfs: ['H1', 'H4'], adds: H14 },
    { code: 'LINK', nombre: 'Chainlink', src: 'bn', sym: 'LINKUSDT', g: 'cripto', com: 0.001, tfs: ['H1', 'H4'], adds: H14 },
    { code: 'Oro', nombre: 'Oro', src: 'deriv', sym: 'frxXAUUSD', g: 'metal', com: 0.000179, tfs: ['M30', 'H1', 'H4'], adds: ALL },
    { code: 'Plata', nombre: 'Plata', src: 'deriv', sym: 'frxXAGUSD', g: 'metal', com: 0.000975, tfs: ['H4'], adds: { H4: 1 } },
    { code: 'WTI', nombre: 'Petróleo WTI', src: 'hl', sym: 'CL', g: 'energia', com: 0.0005, tfs: ['M30', 'H1', 'H4'], adds: {} },
    { code: 'Brent', nombre: 'Petróleo Brent', src: 'hl', sym: 'BRENTOIL', g: 'energia', com: 0.0005, tfs: ['M30', 'H1', 'H4'], adds: { H4: 1 } }
  ];
  var CAP = { cripto: 3, metal: 2, energia: 2 };
  function need(m) { var s = {}; m.tfs.forEach(function (t) { s[t] = 1; s[HTF[t]] = 1; }); s.D1 = 1; s.H4 = 1; return Object.keys(s); }
  // velas que se bajan: al menos 1000 (400 del diario) y, con el paso de las semanas, las que hagan falta para cubrir desde el 17-11 (hasta 5000)
  function nMax(tf) { if (tf === 'D1') return 400; var n = Math.ceil((Date.now() / 1000 - START) / G[tf]) + 450; return Math.max(1000, Math.min(5000, n)); }

  /* ---------- el cálculo (igual que robot.js), sin pantalla ---------- */
  // datos[código][temporalidad] = velas (la última puede estar abierta). Devuelve todas las operaciones con entrada desde T0.
  function calcula(datos, NOW, T0) {
    var ops = [], avisos = [], precio = {};
    MK.forEach(function (m) {
      var d = datos[m.code]; if (!d) { avisos.push(m.nombre + ': sin datos'); return; }
      var closed = function (tf) { return (d[tf] || []).filter(function (k) { return k.t + G[tf] <= NOW; }); };
      var px = null; ['M30', 'H1', 'H4', 'D1'].some(function (tf) { var a = d[tf]; if (a && a.length) { px = a[a.length - 1].c; return true; } return false; });
      precio[m.code] = px;
      var zl = []; [['D1', 86400], ['H4', 14400]].forEach(function (p) { var c = closed(p[0]); if (c.length >= 40) A.htfZoneList(c, p[1]).forEach(function (z) { z.tf = p[0]; zl.push(z); }); });
      zl.sort(function (a, b) { return a.t0 - b.t0; });
      m.tfs.forEach(function (tf) {
        var g = G[tf], htf = HTF[tf], gH = G[htf], cc = closed(tf), cH = closed(htf);
        if (cc.length < 300 || cH.length < 30) { avisos.push(m.nombre + ' ' + TFN[tf] + ': todavía pocas velas'); return; }
        var zH = A.zigzag(cH, 3), zL = A.zigzag(cc, 3), hd = A.waveDir(cc, g, cH, zH, gH), K = A.cols(cc), sm = A.sma(K.c, 200), at = A.atr(K, 14);
        A.waveEntries(cc, zL, cH, zH, g, gH).forEach(function (x) {
          var te = cc[x.e].t + g; if (te < T0) return;
          var mv = sm[x.e], a = at[x.e]; if (!(mv === mv) || !(a > 0)) return;
          var sg = x.up ? 1 : -1, E = cc[x.e].c, s = sg * (E - mv) / a; if (s < -3 || (tf !== 'M30' && s >= 8)) return;   // filtro E92
          var r0 = Math.abs(E - x.stop); if (!(r0 > 0)) return;
          var tg = A.waveTarget(zl, te, E, x.up, x.tf ? x.tf.ext : null, r0); if (tg) x.beAt = tg.p;   // stop a la entrada en el objetivo (E55)
          var ride = null, adds = [];
          if (m.adds[tf]) { var sq = A.waveSeq(cc, zL, hd, x, m.com, 0.5, 2); if (sq) { ride = sq.ride; adds = sq.adds; } } else ride = A.waveRide(cc, zL, hd, x, m.com);
          if (!ride) return;
          ops.push({
            key: m.code + '|' + tf + '|' + te + '|' + (x.up ? 'c' : 'v'), m: m.code, nombre: m.nombre, g: m.g, tf: tf, up: x.up, te: te, E: E, stop0: x.stop, r0: r0, com: m.com,
            adds: adds.map(function (q) { return { n: q.m, ta: cc[q.i].t + g, lv: q.px, st: q.stop, R: q.R }; }),
            done: !!ride.done, tx: ride.done ? cc[ride.xi].t + g : null, ex: ride.ex, stop: ride.stop, R: ride.R
          });
        });
      });
    });
    return { ops: ops, avisos: avisos, precio: precio };
  }

  // lo que va ganando o perdiendo una operación abierta, en veces lo arriesgado, al precio p (si ya tocó el stop, al stop)
  function rAbierta(o, p) {
    var sg = o.up ? 1 : -1; p = o.up ? Math.max(p, o.stop) : Math.min(p, o.stop);
    var R = (p - o.E) * sg / o.r0 - o.com * o.E / o.r0;
    o.adds.forEach(function (q) { var rk = (q.lv - q.st) * sg; if (rk > 0) R += (p - q.lv) * sg / rk - o.com * q.lv / rk; });
    return R;
  }

  // la cuenta: saldo inicial, cada entrada arriesga 'riesgo' del saldo de ese momento (y cada ampliación lo mismo), con tope por grupo
  function cuenta(ops, T0, saldo0, riesgo, precio, NOW) {
    var evs = [];
    ops.forEach(function (o0) { if (o0.te < T0) return; var o = Object.assign({}, o0); evs.push([o.te, 1, o]); if (o.done) evs.push([o.tx, 0, o]); });
    evs.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });   // a la misma hora, primero se cierra y luego se abre
    var bal = saldo0, rk = { cripto: 0, metal: 0, energia: 0 }, abiertas = [], cerradas = [], sinHueco = 0, curva = [{ t: T0, v: saldo0 }];
    evs.forEach(function (e) {
      var o = e[2];
      if (e[1] === 1) {
        var r = Math.min(riesgo, CAP[o.g] * riesgo - rk[o.g]); if (r <= riesgo * 1e-6) { sinHueco++; return; }
        o.r = r; o.usd = r * bal; rk[o.g] += r; abiertas.push(o);
      } else {
        if (!o.usd) return; rk[o.g] -= o.r; abiertas.splice(abiertas.indexOf(o), 1);
        o.Rtot = o.R + o.adds.reduce(function (a, q) { return a + q.R; }, 0); o.pl = o.usd * o.Rtot; bal += o.pl; cerradas.push(o);
        curva.push({ t: o.tx, v: bal, o: o });
      }
    });
    var abierto = 0;
    abiertas.forEach(function (o) { var p = precio[o.m]; o.Rnow = p == null ? 0 : rAbierta(o, p); o.px = p; o.pl = o.usd * o.Rnow; abierto += o.pl; });
    return { saldo: bal, patrimonio: bal + abierto, abierto: abierto, abiertas: abiertas, cerradas: cerradas, sinHueco: sinHueco, curva: curva, NOW: NOW };
  }

  var TFN = { M30: '30 min', H1: '1 hora', H4: '4 horas', D1: '1 día' };
  W.UMB = { calcula: calcula, cuenta: cuenta, rAbierta: rAbierta, MK: MK, START: START, need: need, nMax: nMax, TFN: TFN };
  if (typeof document === 'undefined') return;

  /* ---------- los datos ---------- */
  var IV = { M30: '30m', H1: '1h', H4: '4h', D1: '1d' };
  function getJSON(url, opt) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, tm = ctl ? setTimeout(function () { ctl.abort(); }, 20000) : 0;
    return fetch(url, Object.assign({ cache: 'no-store' }, opt || {}, ctl ? { signal: ctl.signal } : {})).then(function (r) {
      clearTimeout(tm); if (!r.ok) throw new Error('respuesta ' + r.status); return r.json();
    }, function (e) { clearTimeout(tm); throw new Error(e && e.name === 'AbortError' ? 'no responde' : 'sin conexión'); });
  }
  function bn(sym, tf, n) {   // de 1000 en 1000 hacia atrás si hacen falta más
    var url = function (lim, end) { return 'https://data-api.binance.vision/api/v3/klines?symbol=' + sym + '&interval=' + IV[tf] + '&limit=' + lim + (end ? '&endTime=' + end : ''); };
    var map = function (a) { return a.map(function (k) { return { t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4] }; }); };
    var out = [];
    function paso(end) {
      var lim = Math.min(1000, n - out.length);
      return getJSON(url(lim, end)).then(function (a) { var c = map(a); out = c.concat(out); return out.length >= n || c.length < lim || !c.length ? out : paso(c[0].t * 1000 - 1); });
    }
    return paso(0);
  }
  function hl(coin, tf, n) {
    var end = Date.now(), start = end - (n + 2) * G[tf] * 1000;
    return getJSON('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin: 'xyz:' + coin, interval: IV[tf], startTime: start, endTime: end } }) }).then(function (a) {
      return (a || []).map(function (k) { return { t: Math.floor(k.t / 1000), o: +k.o, h: +k.h, l: +k.l, c: +k.c }; }).filter(function (k) { return k.o > 0 && k.c > 0; }).slice(-n);
    });
  }
  function deriv(reqs) {   // una conexión para todas las velas de Deriv
    return new Promise(function (res) {
      var out = {}, pend = {}, left = reqs.length, id = 0, ws, done = false;
      function fin() { if (done) return; done = true; try { ws.close(); } catch (e) { } res(out); }
      if (!left) return res(out);
      var timer = setTimeout(fin, 30000);
      try { ws = new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public'); } catch (e) { clearTimeout(timer); out.error = 'sin conexión'; return res(out); }
      ws.onopen = function () { reqs.forEach(function (r) { var rid = ++id; pend[rid] = r; ws.send(JSON.stringify({ ticks_history: r.sym, end: 'latest', count: r.n, style: 'candles', granularity: G[r.tf], req_id: rid })); }); };
      ws.onmessage = function (ev) {
        var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
        var r = pend[d.req_id]; if (!r) return; delete pend[d.req_id]; left--;
        if (d.candles && !d.error) { var c = d.candles.map(function (k) { return { t: +k.epoch, o: +k.open, h: +k.high, l: +k.low, c: +k.close }; }); if (c.length && c[0].t % G[r.tf] !== 0) c.shift(); out[r.sym + '|' + r.tf] = c; }
        if (!left) { clearTimeout(timer); fin(); }
      };
      ws.onerror = function () { out.error = 'sin conexión'; clearTimeout(timer); fin(); };
    });
  }
  // une velas nuevas a las que ya hay; si falta un tramo, devuelve null para bajarlas enteras
  function une(old, nu, tf) {
    if (!old || !old.length) return null; if (!nu.length) return old;
    var out = old.slice(), g = G[tf];
    if (nu[0].t > out[out.length - 1].t + g) return null;
    nu.forEach(function (k) { var last = out[out.length - 1]; if (k.t === last.t) out[out.length - 1] = k; else if (k.t > last.t) out.push(k); });
    return out.slice(-nMax(tf));
  }

  var datos = {}, ultimaCompleta = 0;
  function cargar() {
    var completa = Date.now() - ultimaCompleta > 30 * 60 * 1000, avisos = [], trabajos = [];
    MK.forEach(function (m) {
      datos[m.code] = datos[m.code] || {};
      if (m.src === 'deriv') return;
      need(m).forEach(function (tf) {
        var cur = datos[m.code][tf], poco = !completa && cur && cur.length, n = poco ? 3 : nMax(tf);
        var baja = function (k) { return m.src === 'bn' ? bn(m.sym, tf, k) : hl(m.sym, tf, k); };
        trabajos.push(baja(n).then(function (nu) {
          var u = poco ? une(cur, nu, tf) : nu;
          return u ? u : baja(nMax(tf));
        }).then(function (u) { datos[m.code][tf] = u; }, function (e) { avisos.push(m.nombre + ' (' + TFN[tf] + '): ' + e.message); }));
      });
    });
    var dr = [];
    MK.filter(function (m) { return m.src === 'deriv'; }).forEach(function (m) {
      need(m).forEach(function (tf) { var cur = datos[m.code][tf]; dr.push({ code: m.code, nombre: m.nombre, sym: m.sym, tf: tf, n: !completa && cur && cur.length ? 3 : nMax(tf) }); });
    });
    trabajos.push(deriv(dr).then(function (out) {
      var falta = [];
      dr.forEach(function (r) {
        var c = out[r.sym + '|' + r.tf]; if (!c) { avisos.push(r.nombre + ' (' + TFN[r.tf] + '): ' + (out.error || 'sin respuesta')); return; }
        if (r.n === nMax(r.tf)) datos[r.code][r.tf] = c;
        else { var u = une(datos[r.code][r.tf], c, r.tf); if (u) datos[r.code][r.tf] = u; else falta.push(Object.assign({}, r, { n: nMax(r.tf) })); }
      });
      if (falta.length) return deriv(falta).then(function (o2) { falta.forEach(function (r) { var c = o2[r.sym + '|' + r.tf]; if (c) datos[r.code][r.tf] = c; }); });
    }));
    return Promise.all(trabajos).then(function () { if (completa) ultimaCompleta = Date.now(); return avisos; });
  }

  /* ---------- la pantalla ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var cfg = { desde: 'vivo', riesgo: 0.002 }, SALDO0 = 10000, ultimo = null, avisosDatos = [], cargando = false, errorTotal = null;
  try { var sv = JSON.parse(localStorage.getItem('umbral-robot-panel') || 'null'); if (sv && sv.desde) cfg.desde = sv.desde; if (sv && sv.riesgo) cfg.riesgo = sv.riesgo; } catch (e) { }
  function guarda() { try { localStorage.setItem('umbral-robot-panel', JSON.stringify(cfg)); } catch (e) { } }
  function desdeT(NOW) { return cfg.desde === '7d' ? NOW - 7 * 86400 : cfg.desde === '14d' ? NOW - 14 * 86400 : START; }

  function dinero(n, signo) {
    var s = Math.abs(n).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < -0.004 ? '−' : signo && n > 0.004 ? '+' : '') + s + ' $';
  }
  function pct(n) { var s = Math.abs(100 * n).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return (n < -0.00004 ? '−' : n > 0.00004 ? '+' : '') + s + ' %'; }
  function precioTxt(p) {
    if (p == null || !isFinite(p)) return '—'; var a = Math.abs(p), d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : 5;
    return p.toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function hora(t) { return new Date(t * 1000).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
  function duracion(s) {
    var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60), dd = Math.floor(h / 24);
    if (dd >= 3) return dd + ' días'; if (dd >= 1) return dd + (dd === 1 ? ' día' : ' días') + (h % 24 ? ' ' + (h % 24) + ' h' : '');
    if (h >= 1) return h + ' h' + (m ? ' ' + m + ' min' : ''); return m + ' min';
  }
  function marcas(lo, hi, n) {   // valores redondos para el eje
    var raw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), f = raw / mag, st = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
    var a = Math.floor(lo / st) * st, b = Math.ceil(hi / st) * st, out = []; for (var v = a; v <= b + st * 1e-6; v += st) out.push(v);
    return { lo: a, hi: b, v: out };
  }
  function clase(n) { return n > 0.004 ? 'gana' : n < -0.004 ? 'pierde' : 'cero'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function pinta() {
    if (!ultimo) return;
    var NOW = Math.floor(Date.now() / 1000), T0 = desdeT(ultimo.NOW);
    var C = cuenta(ultimo.ops, T0, SALDO0, cfg.riesgo, ultimo.precio, ultimo.NOW);
    var res = C.patrimonio - SALDO0;
    $('saldo').textContent = dinero(C.saldo);
    $('patrimonio').textContent = dinero(C.patrimonio);
    $('abierto').textContent = dinero(C.abierto, true); $('abierto').className = 'v ' + clase(C.abierto);
    $('resultado').textContent = dinero(res, true); $('resultado').className = 'v ' + clase(res);
    $('resultadoPct').textContent = pct(res / SALDO0); $('resultadoPct').className = 'sub ' + clase(res);
    var gan = C.cerradas.filter(function (o) { return o.pl > 0.004; }).length, per = C.cerradas.length - gan;
    $('ncerradas').textContent = C.cerradas.length; $('nganan').textContent = gan; $('npierden').textContent = per; $('nabiertas').textContent = C.abiertas.length;
    $('desdeTxt').textContent = cfg.desde === 'vivo' ? 'desde que se encendió, el 17 nov. a las 4:30 p. m.' : 'repaso de los últimos ' + (cfg.desde === '7d' ? '7' : '14') + ' días con las mismas reglas (desde ' + hora(T0) + ')';
    $('riesgoTxt').textContent = (100 * cfg.riesgo).toLocaleString('es-CO') + ' % del saldo (unos ' + Math.round(C.saldo * cfg.riesgo).toLocaleString('es-CO') + ' $)';
    $('sinHueco').textContent = C.sinHueco ? C.sinHueco + (C.sinHueco === 1 ? ' señal no se tomó' : ' señales no se tomaron') + ' porque ya estaba el máximo de operaciones abiertas en su grupo (3 de cripto, 2 de metales, 2 de petróleo).' : '';
    grafico(C, T0);
    // abiertas
    var ab = C.abiertas.slice().sort(function (a, b) { return b.te - a.te; });
    $('tAbiertas').innerHTML = ab.length ? ab.map(function (o) {
      return '<tr><td><b>' + esc(o.nombre) + '</b><span class="tf">' + TFN[o.tf] + '</span></td><td>' + (o.up ? '<span class="dir">▲ Compra</span>' : '<span class="dir">▼ Venta</span>') + '</td>' +
        '<td>' + hora(o.te) + '</td><td class="n">' + precioTxt(o.E) + '</td><td class="n">' + precioTxt(o.px) + '</td><td class="n">' + precioTxt(o.stop) + '</td>' +
        '<td class="n">' + dinero(o.usd) + (o.adds.length ? '<span class="amp">+' + o.adds.length + (o.adds.length === 1 ? ' ampliación' : ' ampliaciones') + '</span>' : '') + '</td>' +
        '<td class="n ' + clase(o.pl) + '"><b>' + dinero(o.pl, true) + '</b></td></tr>';
    }).join('') : '<tr><td colspan="8" class="vacio">Ninguna abierta ahora. El robot espera a que aparezca una flecha de tendencia en alguno de los 14 mercados.</td></tr>';
    // cerradas
    var ce = C.cerradas.slice().sort(function (a, b) { return b.tx - a.tx; });
    $('tCerradas').innerHTML = ce.length ? ce.map(function (o) {
      return '<tr><td><b>' + esc(o.nombre) + '</b><span class="tf">' + TFN[o.tf] + '</span></td><td>' + (o.up ? '<span class="dir">▲ Compra</span>' : '<span class="dir">▼ Venta</span>') + '</td>' +
        '<td>' + hora(o.te) + '</td><td>' + hora(o.tx) + '</td><td class="n">' + duracion(o.tx - o.te) + '</td><td class="n">' + precioTxt(o.E) + ' → ' + precioTxt(o.ex) + '</td>' +
        '<td class="n">' + dinero(o.usd) + (o.adds.length ? '<span class="amp">+' + o.adds.length + (o.adds.length === 1 ? ' ampliación' : ' ampliaciones') + '</span>' : '') + '</td>' +
        '<td class="n ' + clase(o.pl) + '"><b>' + dinero(o.pl, true) + '</b></td></tr>';
    }).join('') : '<tr><td colspan="8" class="vacio">' + (cfg.desde === 'vivo' ? 'Todavía no ha cerrado ninguna. Una operación de tendencia suele durar horas o días; mientras tanto puedes ver el repaso de los últimos 7 o 14 días.' : 'Ninguna cerrada en este periodo.') + '</td></tr>';
    var av = avisosDatos.concat(ultimo.avisos.filter(function (a) { return !/pocas velas/.test(a); }));
    $('avisos').textContent = av.length ? 'Avisos de datos: ' + av.slice(0, 4).join(' · ') + (av.length > 4 ? ' · …' : '') : '';
    estado();
  }

  function grafico(C, T0) {
    var el = $('grafico'), w = el.clientWidth || 800, h = 220, pl = 64, pr = 14, pt = 12, pb = 26;
    var pts = C.curva.slice(); pts.push({ t: Math.max(C.NOW, pts[pts.length - 1].t), v: C.patrimonio, ahora: true });
    var t0 = T0, t1 = Math.max(C.NOW, t0 + 3600), vs = pts.map(function (p) { return p.v; });
    var lo = Math.min.apply(null, vs.concat([SALDO0])), hi = Math.max.apply(null, vs.concat([SALDO0])), pad = Math.max((hi - lo) * 0.08, SALDO0 * 0.002);
    var mk = marcas(lo - pad, hi + pad, 4); lo = mk.lo; hi = mk.hi;
    var X = function (t) { return pl + (w - pl - pr) * (t - t0) / (t1 - t0); }, Y = function (v) { return pt + (h - pt - pb) * (1 - (v - lo) / (hi - lo)); };
    var ticks = mk.v;
    var dias = '', d0 = new Date(t0 * 1000); d0.setHours(24, 0, 0, 0);   // una marca por día (a medianoche), sin amontonarlas
    var nd = Math.floor((t1 - d0.getTime() / 1000) / 86400) + 1, cada = Math.max(1, Math.ceil(nd * 70 / Math.max(1, w - pl - pr)));
    for (var k = 0, dt = new Date(d0); k < nd; k++, dt.setDate(dt.getDate() + 1)) {
      var tt = dt.getTime() / 1000; if (k % cada || X(tt) < pl + 18 || X(tt) > w - pr - 60) continue;
      dias += '<line x1="' + X(tt).toFixed(1) + '" x2="' + X(tt).toFixed(1) + '" y1="' + (h - pb) + '" y2="' + (h - pb + 4) + '" class="rej"/><text x="' + X(tt).toFixed(1) + '" y="' + (h - 6) + '" class="eje" text-anchor="middle">' + dt.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }) + '</text>';
    }
    var d = 'M' + X(pts[0].t).toFixed(1) + ' ' + Y(pts[0].v).toFixed(1);
    for (var j = 1; j < pts.length; j++) { d += ' H' + X(pts[j].t).toFixed(1) + ' V' + Y(pts[j].v).toFixed(1); }
    var last = pts[pts.length - 1], col = last.v >= SALDO0 ? 'var(--gana)' : 'var(--pierde)';
    var svg = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Evolución del saldo">' +
      ticks.map(function (v) { return '<line x1="' + pl + '" x2="' + (w - pr) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '" class="rej"/><text x="' + (pl - 8) + '" y="' + (Y(v) + 4).toFixed(1) + '" class="eje" text-anchor="end">' + Math.round(v).toLocaleString('es-CO') + '</text>'; }).join('') +
      '<line x1="' + pl + '" x2="' + (w - pr) + '" y1="' + Y(SALDO0).toFixed(1) + '" y2="' + Y(SALDO0).toFixed(1) + '" class="base"/>' +
      (dias ? '' : '<text x="' + pl + '" y="' + (h - 6) + '" class="eje">' + hora(t0) + '</text>') + '<text x="' + (w - pr) + '" y="' + (h - 6) + '" class="eje" text-anchor="end">ahora</text>' + dias +
      '<path d="' + d + '" class="linea"/>' +
      C.curva.slice(1).map(function (p) { return '<circle cx="' + X(p.t).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="3.5" class="pt ' + clase(p.o.pl) + '"/>'; }).join('') +
      '<circle cx="' + X(last.t).toFixed(1) + '" cy="' + Y(last.v).toFixed(1) + '" r="5" fill="' + col + '" class="ahora"/>' +
      '<line id="cruz" y1="' + pt + '" y2="' + (h - pb) + '" class="cruz" style="display:none"/></svg><div id="tip" class="tip" hidden></div>';
    el.innerHTML = svg;
    var s = el.querySelector('svg'), cruz = el.querySelector('#cruz'), tip = el.querySelector('#tip');
    s.addEventListener('mousemove', function (ev) {
      var r = s.getBoundingClientRect(), x = ev.clientX - r.left, best = null, bd = 1e9;
      pts.forEach(function (p) { var dx = Math.abs(X(p.t) - x); if (dx < bd) { bd = dx; best = p; } });
      if (!best) return; cruz.setAttribute('x1', X(best.t)); cruz.setAttribute('x2', X(best.t)); cruz.style.display = '';
      tip.hidden = false;
      tip.innerHTML = best.ahora ? '<b>Ahora</b><br>' + dinero(best.v) + '<br><span class="m">con las abiertas a precio de ahora</span>'
        : best.o ? '<b>' + hora(best.t) + '</b><br>' + dinero(best.v) + '<br><span class="' + clase(best.o.pl) + '">' + esc(best.o.nombre) + ' ' + TFN[best.o.tf] + ': ' + dinero(best.o.pl, true) + '</span>'
          : '<b>Inicio</b><br>' + dinero(best.v);
      var tx = Math.min(Math.max(X(best.t) + 12, 0), w - 190); tip.style.left = tx + 'px'; tip.style.top = Math.max(Y(best.v) - 30, 0) + 'px';
    });
    s.addEventListener('mouseleave', function () { cruz.style.display = 'none'; tip.hidden = true; });
  }

  var proxima = 0;
  function estado() {
    var e = $('estado');
    if (errorTotal) { e.className = 'estado mal'; e.textContent = 'Sin datos: ' + errorTotal + '. Reintento en ' + Math.max(0, Math.ceil((proxima - Date.now()) / 1000)) + ' s'; return; }
    if (!ultimo) { e.className = 'estado'; e.textContent = 'Bajando velas de los 14 mercados…'; return; }
    e.className = 'estado ok';
    e.textContent = (cargando ? 'Actualizando… · ' : 'En directo · ') + 'precios de las ' + new Date(ultimo.NOW * 1000).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) + (cargando ? '' : ' · siguiente en ' + Math.max(0, Math.ceil((proxima - Date.now()) / 1000)) + ' s');
  }

  function ciclo() {
    if (cargando) return; cargando = true; estado();
    cargar().then(function (av) {
      avisosDatos = av;
      var NOW = Math.floor(Date.now() / 1000), hay = MK.some(function (m) { return datos[m.code] && Object.keys(datos[m.code]).length; });
      if (!hay) { errorTotal = av[0] || 'no responden Binance, Deriv ni Hyperliquid'; ultimo = null; }
      else { errorTotal = null; var R = calcula(datos, NOW, NOW - 15 * 86400); ultimo = { ops: R.ops, avisos: R.avisos, precio: R.precio, NOW: NOW }; }
    }).catch(function (e) { errorTotal = e && e.message || 'error'; }).then(function () {
      cargando = false; proxima = Date.now() + 60000; pinta(); estado();
    });
  }

  function botones() {
    [].forEach.call(document.querySelectorAll('[data-desde]'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-desde') === cfg.desde); b.onclick = function () { cfg.desde = b.getAttribute('data-desde'); guarda(); botones(); pinta(); }; });
    [].forEach.call(document.querySelectorAll('[data-riesgo]'), function (b) { b.setAttribute('aria-pressed', +b.getAttribute('data-riesgo') === cfg.riesgo); b.onclick = function () { cfg.riesgo = +b.getAttribute('data-riesgo'); guarda(); botones(); pinta(); }; });
  }

  function arranca() {
    botones(); estado(); ciclo();
    setInterval(function () { if (Date.now() >= proxima && !cargando) ciclo(); else estado(); }, 1000);
    var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(pinta, 150); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arranca); else arranca();
})();
