// Descarga el calendario económico de la semana (Forex Factory) y lo guarda para la web: solo impacto alto y medio.
// Uso: node tools/calendar.js data/calendar.json   (lo ejecuta cada hora .github/workflows/calendario.yml)
const fs = require('fs'), path = require('path');
const out = process.argv[2] || 'data/calendar.json', SRC = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
async function get(url, tries) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': 'umbraltrade.com calendar' } }); if (r.ok) return await r.json(); console.log('HTTP ' + r.status); } catch (e) { console.log(e.message); }
    await new Promise(res => setTimeout(res, 5000 * (i + 1)));
  }
  throw new Error('sin respuesta de ' + url);
}
(async () => {
  const list = process.env.CAL_SRC_FILE ? JSON.parse(fs.readFileSync(process.env.CAL_SRC_FILE, 'utf8')) : await get(SRC, 4);   // CAL_SRC_FILE: probar con un archivo ya descargado
  if (!Array.isArray(list) || !list.length) throw new Error('calendario vacío o con otro formato');
  const keep = list.filter(e => e && e.date && e.country && (e.impact === 'High' || e.impact === 'Medium'))
    .map(e => ({ title: String(e.title || ''), country: String(e.country), date: e.date, impact: e.impact, forecast: e.forecast || '', previous: e.previous || '', actual: e.actual || '' }))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const txt = JSON.stringify(keep, null, 1) + '\n';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out) && fs.readFileSync(out, 'utf8') === txt) return console.log('sin cambios (' + keep.length + ' datos)');
  fs.writeFileSync(out, txt); console.log('guardado: ' + keep.length + ' datos de impacto alto y medio');
})().catch(e => { console.error(e.message); process.exit(1); });
