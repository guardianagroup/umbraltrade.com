/* Umbral · modelo de 15 minutos. Junta medio centenar de señales débiles de las velas de 5 minutos (movimiento reciente, posición en el rango,
   distancia a los niveles del día, forma de la vela, volatilidad, hora, y lo que acaban de hacer los otros mercados) y da la probabilidad de que el
   precio esté más alto 15 minutos después. Solo sirve cuando está muy seguro: en el 1 % de decisiones más seguras acertó el 57 % en 2021–2026
   (5 mercados, precio medio, años que no vio al ajustarse). El resto del tiempo no dice nada útil y hay que abstenerse.
   El mismo archivo vale para la web y para el motor (Node). Los árboles vienen de modelo15.json (estudio E15). */
(function (root) {
  'use strict';
  var MER = ['EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY', 'XAUUSD'];
  var PASO = { EURUSD: 0.05, GBPUSD: 0.05, USDJPY: 5, EURJPY: 5, XAUUSD: 50 };   // número redondo de referencia (el del ajuste)
  var KS = [1, 2, 3, 6, 12, 24, 48, 96, 288, 576];

  function rollMax(a, k, i) { var m = -Infinity; for (var j = i - k + 1; j <= i; j++) if (a[j] > m) m = a[j]; return m; }
  function rollMin(a, k, i) { var m = Infinity; for (var j = i - k + 1; j <= i; j++) if (a[j] < m) m = a[j]; return m; }
  function meanStd(a, k, i) { var s = 0, j; for (j = i - k + 1; j <= i; j++) s += a[j]; var m = s / k, v = 0; for (j = i - k + 1; j <= i; j++) v += (a[j] - m) * (a[j] - m); return [m, Math.sqrt(v / (k - 1))]; }
  function rsiLast(c, n) {   // RSI de Wilder, valor de la última vela (los huecos al principio cuentan como sin cambio)
    var N = c.length; if (N <= n) return NaN;
    var up = new Float64Array(N - 1), dn = new Float64Array(N - 1), i;
    for (i = 0; i < N - 1; i++) { var d = c[i + 1] - c[i]; if (d > 0) up[i] = d; else if (d < 0) dn[i] = -d; }
    var g = 0, l = 0; for (i = 0; i < n; i++) { g += up[i]; l += dn[i]; } g /= n; l /= n;
    for (i = n; i < N - 1; i++) { g = (g * (n - 1) + up[i]) / n; l = (l * (n - 1) + dn[i]) / n; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  /* desviación típica con media exponencial, como pandas ewm(span).std(), en la última vela */
  function ewmStdDirect(x, span) {   // suma directa sobre las últimas velas: clara y suficiente (el peso se agota en ~8 spans)
    var a = 2 / (span + 1), q = 1 - a, n = x.length, lim = Math.max(0, n - 12 * span), sw = 0, sw2 = 0, sx = 0, w = 1, i;
    for (i = n - 1; i >= lim; i--) { sw += w; sw2 += w * w; sx += w * x[i]; w *= q; }
    var m = sx / sw, v = 0; w = 1;
    for (i = n - 1; i >= lim; i--) { v += w * (x[i] - m) * (x[i] - m); w *= q; }
    var bias = v / sw, den = sw * sw - sw2;
    return den > 0 ? Math.sqrt(bias * sw * sw / den) : NaN;
  }
  function londres(t) {   // hora de Londres de un instante: { h (con decimales), dia (0 = lunes), fecha 'AAAA-MM-DD' }
    var d = new Date(t * 1000), y = d.getUTCFullYear();
    function ultDom(mes) { var x = new Date(Date.UTC(y, mes + 1, 0)); return Date.UTC(y, mes, x.getUTCDate() - x.getUTCDay(), 1) / 1000; }   // último domingo del mes, 01:00 UTC
    var bst = t >= ultDom(2) && t < ultDom(9), L = new Date((t + (bst ? 3600 : 0)) * 1000);
    return { h: L.getUTCHours() + L.getUTCMinutes() / 60, dia: (L.getUTCDay() + 6) % 7, fecha: L.toISOString().slice(0, 10), min: L.getUTCMinutes() };
  }

  /* variables propias de un mercado en su última vela cerrada. k: { t, o, h, l, c } (arrays, velas de 5 min, la última ya cerrada). null si no hay bastante. */
  function propias(sym, k) {
    var n = k.c.length, i = n - 1, j; if (n < 700) return null;
    var lc = new Float64Array(n), r1 = new Float64Array(n);
    for (j = 0; j < n; j++) { lc[j] = Math.log(k.c[j]); if (j) r1[j] = lc[j] - lc[j - 1]; }
    var sig = ewmStdDirect(r1, 288); if (!(sig > 0)) return null;
    var X = {};
    KS.forEach(function (q) { X['r' + q] = (lc[i] - lc[i - q]) / (sig * Math.sqrt(q)); });
    [12, 48, 288].forEach(function (q) { var hi = rollMax(k.h, q, i), lo = rollMin(k.l, q, i); X['pos' + q] = hi > lo ? (k.c[i] - lo) / (hi - lo) : NaN; X['ancho' + q] = Math.log(hi / lo) / (sig * Math.sqrt(q)); });
    [20, 100].forEach(function (q) { var ms = meanStd(k.c, q, i); X['z' + q] = ms[1] > 0 ? (k.c[i] - ms[0]) / ms[1] : NaN; });
    X.rsi14 = rsiLast(k.c, 14); X.rsi5 = rsiLast(k.c, 5); X.rsi2 = rsiLast(k.c, 2);
    var c3 = new Float64Array(n - 2); for (j = 2; j < n; j++) c3[j - 2] = (k.c[j] + k.c[j - 1] + k.c[j - 2]) / 3; X.rsi14_15 = rsiLast(c3, 42);
    var rng = k.h[i] - k.l[i];
    X.cuerpo = rng > 0 ? (k.c[i] - k.o[i]) / rng : NaN; X.mecha_arr = rng > 0 ? (k.h[i] - Math.max(k.o[i], k.c[i])) / rng : NaN; X.mecha_ab = rng > 0 ? (Math.min(k.o[i], k.c[i]) - k.l[i]) / rng : NaN; X.rango = Math.log(k.h[i] / k.l[i]) / sig;
    X.vol12 = meanStd(r1, 12, i)[1] / sig; X.vol48 = meanStd(r1, 48, i)[1] / sig;
    var racha = 0; for (j = 1; j < n; j++) { var s = r1[j] > 0 ? 1 : r1[j] < 0 ? -1 : 0; racha = s !== 0 && (racha === 0 || (racha > 0) === (s > 0)) ? racha + s : s; } X.racha = racha;
    var L = londres(k.t[i]); X.hora = L.h; X.dia = L.dia;
    // el día de hoy y el anterior (días de Londres que tienen velas)
    var hoyO = null, hoyH = -Infinity, hoyL = Infinity, ayH = -Infinity, ayL = Infinity, ayC = null, fAy = null;
    for (j = i; j >= 0; j--) {
      var f = londres(k.t[j]).fecha;
      if (f === L.fecha) { hoyO = k.o[j]; if (k.h[j] > hoyH) hoyH = k.h[j]; if (k.l[j] < hoyL) hoyL = k.l[j]; }
      else { if (fAy === null) { fAy = f; ayC = k.c[j]; } if (f !== fAy) break; if (k.h[j] > ayH) ayH = k.h[j]; if (k.l[j] < ayL) ayL = k.l[j]; }
    }
    var s1h = sig * Math.sqrt(12) * k.c[i], c = k.c[i];
    X.d_max_ayer = fAy ? (c - ayH) / s1h : NaN; X.d_min_ayer = fAy ? (c - ayL) / s1h : NaN; X.d_cie_ayer = fAy ? (c - ayC) / s1h : NaN; X.d_ap_hoy = (c - hoyO) / s1h;
    X.d_max_hoy = (c - hoyH) / s1h; X.d_min_hoy = (c - hoyL) / s1h;
    var p = PASO[sym];
    X.red1 = (c - Math.round(c / p) * p) / s1h; X.red2 = (c - Math.round(c / (p / 5)) * (p / 5)) / s1h; X.red3 = (c - Math.round(c / (p / 10)) * (p / 10)) / s1h;
    X._t = k.t[i]; X._h = L.h; X._min = L.min; X._cont = k.t[i] - k.t[i - 12] === 3600; X._sig = sig;
    return X;
  }

  /* ¿es momento de decidir? La vela que acaba de cerrar termina en :00, :15, :30 o :45, la última hora no tiene huecos y no es el cambio de día */
  function momento(X) { return !!X && X._min % 15 === 10 && X._cont && !(X._h >= 19.5 && X._h <= 23.25); }

  /* vector de variables de un mercado, con lo que acaban de hacer los cinco. velas: { EURUSD: {t,o,h,l,c}, … } */
  function vector(modelo, sym, velas, cache) {
    cache = cache || {};
    MER.forEach(function (s) { if (!(s in cache)) cache[s] = velas[s] ? propias(s, velas[s]) : null; });
    var X = cache[sym]; if (!X) return null;
    var out = new Float64Array(modelo.vars.length);
    for (var i = 0; i < modelo.vars.length; i++) {
      var v = modelo.vars[i], m = /^x_([A-Z]+)_(r\d+)$/.exec(v);
      if (m) { var o = cache[m[1]]; out[i] = o && o._t === X._t && o._cont ? o[m[2]] : NaN; }   // del otro mercado solo vale si tiene vela a esa misma hora y su última hora no tiene huecos (igual que al ajustar)
      else if (v === 'mer_id') out[i] = MER.indexOf(sym);
      else out[i] = X[v];
    }
    return out;
  }
  /* probabilidad de que el precio esté más alto dentro de 15 minutos */
  function prob(modelo, x) {
    var s = modelo.base, A = modelo.arboles;
    for (var a = 0; a < A.length; a++) {
      var T = A[a], j = 0;
      while (T.f[j] >= 0) { var v = x[T.f[j]]; j = (v !== v ? T.m[j] : v <= T.u[j]) ? T.l[j] : T.r[j]; }
      s += T.v[j];
    }
    return 1 / (1 + Math.exp(-s));
  }
  /* nivel de confianza: 0 (nada), 1 (5 % más seguro), 2 (2 %), 3 (1 %), 4 (0,5 %) */
  function nivel(modelo, p) { var c = Math.abs(p - 0.5), k = modelo.cortes; return c >= k['0.005'] ? 4 : c >= k['0.01'] ? 3 : c >= k['0.02'] ? 2 : c >= k['0.05'] ? 1 : 0; }

  var api = { MER: MER, propias: propias, momento: momento, vector: vector, prob: prob, nivel: nivel, londres: londres };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.U) root.U.modelo = api; else if (root) root.UmbralModelo = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
