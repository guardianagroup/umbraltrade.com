// Une la plantilla, algo.js y panel.js en una sola página: robot/panel.html (se abre con doble clic, sin instalar nada).
const fs = require('fs'), path = require('path'), d = __dirname;
const plantilla = fs.readFileSync(path.join(d, 'panel_plantilla.html'), 'utf8');
const algo = fs.readFileSync(path.join(d, 'algo.js'), 'utf8'), panel = fs.readFileSync(path.join(d, 'panel.js'), 'utf8');
if (/<\/script/i.test(algo + panel)) throw new Error('</script> dentro del código');
const out = plantilla.replace('/*ALGO*/', () => algo).replace('/*PANEL*/', () => panel);
fs.writeFileSync(path.join(d, 'panel.html'), out);
console.log('panel.html', (out.length / 1024).toFixed(0), 'KB');
