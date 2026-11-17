// Baja velas reales (Binance) de 5 criptos, arma la entrada del motor como la arma el cBot y guarda lo que da Node.
const fs = require('fs'), path = require('path');
globalThis.window = undefined;
const R = path.join(__dirname, '..', '..');
eval(fs.readFileSync(path.join(R, 'algo.js'), 'utf8')); eval(fs.readFileSync(path.join(R, 'panel.js'), 'utf8')); eval(fs.readFileSync(path.join(__dirname, '..', 'umbral_cbot.js'), 'utf8') + ';globalThis.umbralPasada=umbralPasada;');
const IV = { M30: '30m', H1: '1h', H4: '4h', D1: '1d' };
const MK = [
  { code: 'BTC', nombre: 'Bitcoin', sym: 'BTCUSDT', g: 'cripto', com: 0.0007, tfs: ['M30', 'H1', 'H4'], adds: { H1: 1, H4: 1 } },
  { code: 'ETH', nombre: 'Ethereum', sym: 'ETHUSDT', g: 'cripto', com: 0.001166, tfs: ['M30', 'H1', 'H4'], adds: { M30: 1, H1: 1, H4: 1 } },
  { code: 'SOL', nombre: 'Solana', sym: 'SOLUSDT', g: 'cripto', com: 0.001, tfs: ['H1', 'H4'], adds: { H1: 1, H4: 1 } },
  { code: 'ADA', nombre: 'Cardano', sym: 'ADAUSDT', g: 'cripto', com: 0.001, tfs: ['H4'], adds: { H4: 1 } },
  { code: 'LTC', nombre: 'Litecoin', sym: 'LTCUSDT', g: 'cripto', com: 0.001, tfs: ['H4'], adds: {} },
];
(async () => {
  const datos = {};
  for (const m of MK) {
    datos[m.code] = {};
    for (const tf of ['M30', 'H1', 'H4', 'D1']) {
      const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${m.sym}&interval=${IV[tf]}&limit=${tf === 'D1' ? 400 : 1000}`);
      datos[m.code][tf] = (await r.json()).map(k => [Math.floor(k[0] / 1000), +k[1], +k[2], +k[3], +k[4]]);
    }
  }
  const NOW = Math.floor(Date.now() / 1000), entrada = JSON.stringify({ NOW, T0: NOW - 14 * 86400, mk: MK.map(({ sym, ...m }) => m), datos });
  fs.writeFileSync(path.join(__dirname, 'entrada.json'), entrada);
  const t = Date.now(), sal = globalThis.umbralPasada(entrada);
  fs.writeFileSync(path.join(__dirname, 'salida_node.json'), sal);
  const o = JSON.parse(sal); console.log(`Node: ${Date.now() - t} ms · ${o.ops.length} operaciones · avisos ${o.avisos.length}`);
})().catch(e => { console.error(e); process.exit(1); });
