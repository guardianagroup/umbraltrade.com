/* Motor del cBot de Umbral: lo llama UmbralRobot.cs (con Jint) en cada pasada, con las velas de cTrader en JSON.
   Usa el mismo cálculo que la pantalla (panel.js) y que el robot simulado (robot.js), que a su vez es el de las flechas de la web.
   Entrada: { NOW, T0, mk: [{ code, nombre, g, com, tfs: [...], adds: { M30: 1, ... } }], datos: { código: { M30: [[t, o, h, l, c], ...], ... } } }
   Salida: { ops: [{ key, m, g, tf, up, te, E, stop, done, tx, ex, R, adds: [{ n, ta, lv, st, R }] }], avisos: [...], precio: { código: último } } */
function umbralPasada(json) {
  var I = JSON.parse(json), datos = {};
  Object.keys(I.datos).forEach(function (code) {
    var d0 = I.datos[code], d = datos[code] = {};
    Object.keys(d0).forEach(function (tf) {
      var a = d0[tf], out = new Array(a.length);
      for (var i = 0; i < a.length; i++) { var r = a[i]; out[i] = { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] }; }
      d[tf] = out;
    });
  });
  var R = globalThis.UMB.calcula(datos, I.NOW, I.T0, I.mk);
  return JSON.stringify({
    ops: R.ops.map(function (o) { return { key: o.key, m: o.m, g: o.g, tf: o.tf, up: o.up, te: o.te, E: o.E, stop: o.stop, done: o.done, tx: o.tx, ex: o.ex, R: o.R, adds: o.adds }; }),
    avisos: R.avisos, precio: R.precio
  });
}
