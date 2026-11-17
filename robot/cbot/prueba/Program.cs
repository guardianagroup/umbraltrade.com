// Prueba del motor dentro de .NET (Jint): mismas velas que Node, mismo resultado esperado.
using System;
using System.Diagnostics;
using System.IO;
using Jint;

namespace cAlgo.Robots
{
    public static class Program
    {
        public static int Main(string[] a)
        {
            var sw = Stopwatch.StartNew();
            var js = new Engine(o => o.TimeoutInterval(TimeSpan.FromMinutes(5)).LimitRecursion(10000));
            js.Execute(MotorJs.Codigo);
            Console.WriteLine($"motor cargado en {sw.ElapsedMilliseconds} ms");
            var entrada = File.ReadAllText(a[0]);
            for (int i = 0; i < 2; i++)
            {
                sw.Restart();
                var res = js.Invoke("umbralPasada", entrada).AsString();
                Console.WriteLine($"pasada {i + 1}: {sw.ElapsedMilliseconds} ms, {res.Length} caracteres");
                if (i == 1) File.WriteAllText(a[1], res);
            }
            return 0;
        }
    }
}
