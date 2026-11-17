// Genera MotorJs.cs: el motor de JavaScript (algo.js + el cálculo de panel.js + umbral_cbot.js) dentro del cBot, en base64.
const fs = require('fs'), path = require('path'), d = path.join(__dirname, '..');
const js = [fs.readFileSync(path.join(d, 'algo.js'), 'utf8'), fs.readFileSync(path.join(d, 'panel.js'), 'utf8'), fs.readFileSync(path.join(__dirname, 'umbral_cbot.js'), 'utf8')].join('\n;\n');
const b64 = Buffer.from(js, 'utf8').toString('base64');
const cs = `// Generado por gen_motor.js: no editar a mano.
namespace cAlgo.Robots
{
    public static class MotorJs
    {
        public static string Codigo => System.Text.Encoding.UTF8.GetString(System.Convert.FromBase64String(B64));
        const string B64 = "${b64}";
    }
}
`;
for (const dir of ['UmbralRobot/UmbralRobot', 'prueba']) fs.writeFileSync(path.join(__dirname, dir, 'MotorJs.cs'), cs);
console.log('MotorJs.cs', (cs.length / 1024).toFixed(0), 'KB');
