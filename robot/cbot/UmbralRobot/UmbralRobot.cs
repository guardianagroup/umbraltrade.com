using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using cAlgo.API;
using cAlgo.API.Internals;
using Jint;

namespace cAlgo.Robots
{
    /* Robot de Umbral para cTrader, SOLO CUENTAS DEMO.
       Cada 30 minutos (20 s después de cerrar la vela) baja las velas de cTrader de los 14 mercados, calcula con el mismo motor de la web
       (JavaScript, dentro del robot) las entradas de tendencia de 30 min, 1 h y 4 h, y las gestiona:
       - abre cada entrada nueva con su stop, arriesgando el % del saldo elegido (como mucho 3 de cripto, 2 de metales y 2 de petróleo a la vez);
       - donde están activas, abre las ampliaciones a +0,5 y +1 vez el riesgo, con el mismo dinero en riesgo cada una;
       - sube el stop de todas a la vez cuando el motor lo sube, y cierra todo cuando el motor da la operación por terminada.
       En una cuenta real se detiene sin hacer nada. */
    [Robot(AccessRights = AccessRights.None, AddIndicators = false, TimeZone = TimeZones.UTC)]
    public class UmbralRobot : Robot
    {
        [Parameter("Riesgo por operación (% del saldo)", DefaultValue = 0.2, MinValue = 0.05, MaxValue = 1.0, Step = 0.05)]
        public double RiesgoPct { get; set; }

        [Parameter("Símbolos (código=símbolo de la cuenta)", DefaultValue = "BTC=BTCUSD,ETH=ETHUSD,SOL=SOLUSD,XRP=XRPUSD,BNB=BNBUSD,DOGE=DOGUSD,ADA=ADAUSD,LTC=LTCUSD,AVAX=AVAUSD,LINK=LNKUSD,Oro=XAUUSD,Plata=XAGUSD,WTI=US Oil,Brent=UK Brent Oil")]
        public string Simbolos { get; set; }

        const string ETIQ = "Umbral";
        static readonly Dictionary<string, long> G = new() { ["M30"] = 1800, ["H1"] = 3600, ["H4"] = 14400, ["D1"] = 86400 };
        static readonly Dictionary<string, string> HTF = new() { ["M30"] = "H4", ["H1"] = "D1", ["H4"] = "D1" };
        static readonly Dictionary<string, int> CAP = new() { ["cripto"] = 3, ["metal"] = 2, ["energia"] = 2 };

        // mercados y temporalidades para Deriv cTrader (estudio E94: sin Cardano 30 min y 1 h, Dogecoin 1 h ni Litecoin 1 h, que con sus costes no compensan)
        static readonly (string code, string nombre, string g, double com, string tfs, string adds)[] LISTA =
        {
            ("BTC", "Bitcoin", "cripto", 0.0007, "M30,H1,H4", "H1,H4"),
            ("ETH", "Ethereum", "cripto", 0.001166, "M30,H1,H4", "M30,H1,H4"),
            ("SOL", "Solana", "cripto", 0.001, "H1,H4", "H1,H4"),
            ("XRP", "XRP", "cripto", 0.001, "H1,H4", "H1,H4"),
            ("BNB", "BNB", "cripto", 0.001, "M30,H1,H4", "H1,H4"),
            ("DOGE", "Dogecoin", "cripto", 0.001, "H4", ""),
            ("ADA", "Cardano", "cripto", 0.001, "H4", "H4"),
            ("LTC", "Litecoin", "cripto", 0.001, "H4", ""),
            ("AVAX", "Avalanche", "cripto", 0.001, "H1,H4", "H1,H4"),
            ("LINK", "Chainlink", "cripto", 0.001, "H1,H4", "H1,H4"),
            ("Oro", "Oro", "metal", 0.000179, "M30,H1,H4", "M30,H1,H4"),
            ("Plata", "Plata", "metal", 0.000975, "H4", "H4"),
            ("WTI", "Petróleo WTI", "energia", 0.0005, "M30,H1,H4", ""),
            ("Brent", "Petróleo Brent", "energia", 0.0005, "M30,H1,H4", "H4"),
        };

        class Mk { public string Code, Nombre, Grupo; public double Com; public string[] Tfs; public string[] Adds; public Symbol S; }

        readonly List<Mk> mks = new();
        readonly Dictionary<string, Bars> velas = new();
        readonly HashSet<string> tomadas = new();
        Engine js;
        long proxima;

        protected override void OnStart()
        {
            if (Account.IsLive)
            {
                Print("Este robot solo funciona en cuentas demo, y esta cuenta es real. Se detiene sin hacer nada.");
                Stop();
                return;
            }
            var mapa = new Dictionary<string, string>();
            foreach (var par in (Simbolos ?? "").Split(','))
            {
                var p = par.Split('=');
                if (p.Length == 2) mapa[p[0].Trim()] = p[1].Trim();
            }
            foreach (var l in LISTA)
            {
                if (!mapa.TryGetValue(l.code, out var nombre)) continue;
                Symbol s = null;
                try { s = Symbols.GetSymbol(nombre); } catch { }
                if (s == null) { Print($"{l.nombre}: no encuentro el símbolo «{nombre}» en esta cuenta; ese mercado queda fuera."); continue; }
                mks.Add(new Mk { Code = l.code, Nombre = l.nombre, Grupo = l.g, Com = l.com, Tfs = l.tfs.Split(','), Adds = l.adds.Split(',', StringSplitOptions.RemoveEmptyEntries), S = s });
            }
            js = new Engine(o => o.TimeoutInterval(TimeSpan.FromMinutes(3)).LimitRecursion(10000));
            js.Execute(MotorJs.Codigo);
            try
            {
                var t = LocalStorage.GetString("umbral-tomadas", LocalStorageScope.Instance);
                if (!string.IsNullOrEmpty(t)) foreach (var k in t.Split(';')) if (k.Length > 0) tomadas.Add(k);
            }
            catch { }
            Print($"Robot de Umbral en marcha (cuenta demo): {mks.Count} mercados, arriesga el {RiesgoPct.ToString(CultureInfo.InvariantCulture)} % del saldo por operación.");
            proxima = 0;
            Timer.Start(TimeSpan.FromSeconds(15));
        }

        protected override void OnTimer()
        {
            long now = Unix(Server.Time);
            if (now < proxima) return;
            proxima = (now / 1800 + 1) * 1800 + 20;   // la siguiente, 20 s después de cerrar la próxima vela de 30 minutos
            try { Pasada(now); }
            catch (Exception e) { Print("Error en la pasada (se reintenta en la siguiente): " + e.Message); }
        }

        static long Unix(DateTime t) => (long)(DateTime.SpecifyKind(t, DateTimeKind.Utc) - DateTime.UnixEpoch).TotalSeconds;
        static string N(double v) => v.ToString("R", CultureInfo.InvariantCulture);

        IEnumerable<string> Necesita(Mk m)
        {
            var s = new HashSet<string>();
            foreach (var t in m.Tfs) { s.Add(t); s.Add(HTF[t]); }
            s.Add("D1"); s.Add("H4");
            return s;
        }

        Bars Velas(Mk m, string tf)
        {
            var clave = m.S.Name + "|" + tf;
            if (!velas.TryGetValue(clave, out var b))
            {
                var marco = tf == "M30" ? TimeFrame.Minute30 : tf == "H1" ? TimeFrame.Hour : tf == "H4" ? TimeFrame.Hour4 : TimeFrame.Daily;
                b = MarketData.GetBars(marco, m.S.Name);
                velas[clave] = b;
            }
            int quiero = tf == "D1" ? 400 : 1000, intentos = 0;
            while (b.Count < quiero && intentos++ < 30) { if (b.LoadMoreHistory() <= 0) break; }
            return b;
        }

        void Pasada(long now)
        {
            var mias = Positions.Where(p => p.Label == ETIQ).ToList();
            long t0 = now - 3 * 86400;   // desde cuándo calcular: 3 días, o desde la entrada más antigua que siga abierta
            foreach (var p in mias) { var te = TeDe(p.Comment); if (te > 0 && te - 86400 < t0) t0 = te - 86400; }

            var sb = new StringBuilder(1 << 22);
            sb.Append("{\"NOW\":").Append(now).Append(",\"T0\":").Append(t0).Append(",\"mk\":[");
            for (int i = 0; i < mks.Count; i++)
            {
                var m = mks[i];
                if (i > 0) sb.Append(',');
                sb.Append("{\"code\":\"").Append(m.Code).Append("\",\"nombre\":\"").Append(m.Nombre).Append("\",\"g\":\"").Append(m.Grupo).Append("\",\"com\":").Append(N(m.Com));
                sb.Append(",\"tfs\":[").Append(string.Join(",", m.Tfs.Select(t => "\"" + t + "\""))).Append("],\"adds\":{").Append(string.Join(",", m.Adds.Select(t => "\"" + t + "\":1"))).Append("}}");
            }
            sb.Append("],\"datos\":{");
            bool primero = true;
            foreach (var m in mks)
            {
                if (!primero) sb.Append(',');
                primero = false;
                sb.Append('"').Append(m.Code).Append("\":{");
                bool p1 = true;
                foreach (var tf in Necesita(m))
                {
                    var b = Velas(m, tf);
                    if (!p1) sb.Append(',');
                    p1 = false;
                    sb.Append('"').Append(tf).Append("\":[");
                    for (int j = 0; j < b.Count; j++)
                    {
                        if (j > 0) sb.Append(',');
                        sb.Append('[').Append(Unix(b.OpenTimes[j])).Append(',').Append(N(b.OpenPrices[j])).Append(',').Append(N(b.HighPrices[j])).Append(',').Append(N(b.LowPrices[j])).Append(',').Append(N(b.ClosePrices[j])).Append(']');
                    }
                    sb.Append(']');
                }
                sb.Append('}');
            }
            sb.Append("}}");

            string res = js.Invoke("umbralPasada", sb.ToString()).AsString();
            using var doc = JsonDocument.Parse(res);
            var raiz = doc.RootElement;

            // lo que hay abierto, por operación (la entrada y sus ampliaciones comparten la clave)
            var porClave = new Dictionary<string, List<Position>>();
            foreach (var p in mias) { var k = Clave(p.Comment); if (!porClave.TryGetValue(k, out var l)) porClave[k] = l = new List<Position>(); l.Add(p); }
            var enGrupo = new Dictionary<string, int> { ["cripto"] = 0, ["metal"] = 0, ["energia"] = 0 };
            foreach (var k in porClave.Keys) { var m = mks.FirstOrDefault(x => k.StartsWith(x.Code + "|")); if (m != null) enGrupo[m.Grupo]++; }

            int nuevas = 0, cerradas = 0, ampl = 0;
            foreach (var o in raiz.GetProperty("ops").EnumerateArray())
            {
                string key = o.GetProperty("key").GetString(), code = o.GetProperty("m").GetString(), tf = o.GetProperty("tf").GetString();
                bool up = o.GetProperty("up").GetBoolean(), done = o.GetProperty("done").GetBoolean();
                long te = o.GetProperty("te").GetInt64();
                double stop = o.GetProperty("stop").GetDouble();
                var m = mks.FirstOrDefault(x => x.Code == code);
                if (m == null) continue;
                porClave.TryGetValue(key, out var pos);

                if (pos != null && pos.Count > 0)
                {
                    if (done)
                    {
                        foreach (var p in pos) ClosePosition(p);
                        Print($"Cierra {m.Nombre} {tf} ({(up ? "compra" : "venta")}): el motor da la operación por terminada.");
                        cerradas++;
                        continue;
                    }
                    foreach (var p in pos) MueveStop(m, p, stop, up);
                    foreach (var a in o.GetProperty("adds").EnumerateArray())
                    {
                        string ka = key + "|a" + a.GetProperty("n").GetInt32();
                        if (tomadas.Contains(ka) || pos.Any(p => p.Comment == ka)) continue;
                        tomadas.Add(ka);
                        if (now - a.GetProperty("ta").GetInt64() > G[tf] + 900) continue;   // llegó tarde: no se amplía
                        if (Abre(m, up, stop, ka, Account.Balance * RiesgoPct / 100, "amplía")) ampl++;
                    }
                    continue;
                }
                if (done || tomadas.Contains(key)) continue;
                if (now - te > G[tf] + 900) continue;   // detectada tarde (el robot no estaba en marcha): no se toma, como en el simulado
                tomadas.Add(key);
                if (enGrupo[m.Grupo] >= CAP[m.Grupo]) { Print($"{m.Nombre} {tf}: hay señal, pero ya está el máximo de operaciones de {m.Grupo}; no abre."); continue; }
                if (Abre(m, up, stop, key, Account.Balance * RiesgoPct / 100, "abre")) { enGrupo[m.Grupo]++; nuevas++; }
            }
            foreach (var a in raiz.GetProperty("avisos").EnumerateArray()) { var s = a.GetString(); if (s != null && !s.Contains("pocas velas")) Print("Aviso: " + s); }
            Guarda();
            Print($"Pasada {Server.Time:dd/MM HH:mm} UTC · abiertas {Positions.Count(p => p.Label == ETIQ)} · nuevas {nuevas} · ampliaciones {ampl} · cerradas {cerradas} · saldo {Account.Balance:F2} · con lo abierto {Account.Equity:F2}");
        }

        bool Abre(Mk m, bool up, double stop, string comentario, double riesgo, string verbo)
        {
            var s = m.S;
            double px = up ? s.Ask : s.Bid, dist = up ? px - stop : stop - px;
            if (!(dist > 0)) { Print($"{m.Nombre}: el precio ya está al otro lado del stop; no {verbo}."); return false; }
            double porUnidad = s.TickValue / s.TickSize;   // dinero que se gana o pierde por unidad cuando el precio se mueve 1
            double unidades = s.NormalizeVolumeInUnits(riesgo / (dist * porUnidad), RoundingMode.Down);
            if (unidades < s.VolumeInUnitsMin) { Print($"{m.Nombre}: con {riesgo:F2} de riesgo no llega al tamaño mínimo ({s.VolumeInUnitsMin} unidades); no {verbo}."); return false; }
            unidades = Math.Min(unidades, s.VolumeInUnitsMax);
            var r = ExecuteMarketOrder(up ? TradeType.Buy : TradeType.Sell, s.Name, unidades, ETIQ, dist / s.PipSize, null, comentario);
            if (!r.IsSuccessful) { Print($"{m.Nombre}: la orden no se ejecutó ({r.Error}); no {verbo}."); return false; }
            Print($"{(verbo == "abre" ? "Abre" : "Amplía")} {m.Nombre} {(up ? "compra" : "venta")} · {unidades} unidades a {r.Position.EntryPrice} · stop {Math.Round(stop, s.Digits)} · arriesga {riesgo:F2}");
            return true;
        }

        void MueveStop(Mk m, Position p, double stop, bool up)
        {
            stop = Math.Round(stop, m.S.Digits);
            var cur = p.StopLoss;
            if (cur.HasValue && (up ? stop <= cur.Value : stop >= cur.Value)) return;   // el stop solo se mueve a favor
            double px = up ? m.S.Bid : m.S.Ask;
            if (up ? stop >= px : stop <= px) { ClosePosition(p); Print($"Cierra {m.Nombre}: el precio ya cruzó el stop nuevo."); return; }
            var r = p.ModifyStopLossPrice(stop);
            if (!r.IsSuccessful) Print($"{m.Nombre}: no se pudo mover el stop a {stop} ({r.Error}).");
        }

        static string Clave(string c)
        {
            if (string.IsNullOrEmpty(c)) return "";
            int i = c.LastIndexOf("|a", StringComparison.Ordinal);
            return i > 0 && c.Split('|').Length == 5 ? c.Substring(0, i) : c;
        }

        static long TeDe(string c)
        {
            var p = (c ?? "").Split('|');
            return p.Length >= 4 && long.TryParse(p[2], out var te) ? te : 0;
        }

        void Guarda()
        {
            try
            {
                var lista = tomadas.Where(k => TeDe(k) > Unix(Server.Time) - 30 * 86400).ToList();
                LocalStorage.SetString("umbral-tomadas", string.Join(";", lista), LocalStorageScope.Instance);
            }
            catch { }
        }
    }
}
