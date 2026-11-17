// Compara lo que da el motor en Node y dentro de .NET (Jint).
const fs = require('fs'), path = require('path');
const a = JSON.parse(fs.readFileSync(path.join(__dirname, 'salida_node.json'), 'utf8')), b = JSON.parse(fs.readFileSync(path.join(__dirname, 'salida_jint.json'), 'utf8'));
let dif = 0, n = 0;
function cmp(x, y, p) {
  n++;
  if (typeof x === 'number' && typeof y === 'number') { if (Math.abs(x - y) > 1e-9 * Math.max(1, Math.abs(x))) { if (dif++ < 10) console.log('distinto', p, x, y); } return; }
  if (x === null || y === null || typeof x !== 'object') { if (x !== y) { if (dif++ < 10) console.log('distinto', p, x, y); } return; }
  const ks = new Set([...Object.keys(x), ...Object.keys(y)]); ks.forEach(k => cmp(x[k], y[k], p + '.' + k));
}
cmp(a, b, '');
console.log(`operaciones: Node ${a.ops.length}, Jint ${b.ops.length} · valores comparados ${n} · distintos ${dif}`);
if (dif) process.exit(1);
