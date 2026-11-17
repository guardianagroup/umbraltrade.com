# Velas de Binance (spot, API pública de datos de mercado).
#   python binance.py OUT
import sys, os, json, time, calendar, datetime as dt
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from comun import baja, guarda, cierra, log

BASES = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com']
import os as _os
H1 = (_os.environ.get('SIMBOLOS') or 'BTCUSDT ETHUSDT SOLUSDT BNBUSDT XRPUSDT ADAUSDT DOGEUSDT LTCUSDT LINKUSDT AVAXUSDT TRXUSDT DOTUSDT').split()
M5 = [] if _os.environ.get('SIMBOLOS') else 'BTCUSDT ETHUSDT'.split()
M1 = [] if _os.environ.get('SIMBOLOS') else 'BTCUSDT ETHUSDT'.split()
MS = {'1m': 60000, '5m': 300000, '1h': 3600000}
BASE = [None]


def pide(sym, itv, t0):
    for b in ([BASE[0]] if BASE[0] else BASES):
        raw = baja('%s/api/v3/klines?symbol=%s&interval=%s&startTime=%d&limit=1000' % (b, sym, itv, t0), tries=5 if BASE[0] else 2)
        if raw:
            try:
                j = json.loads(raw)
                if isinstance(j, list):
                    BASE[0] = b
                    return j
            except Exception:
                pass
    return None


def serie(pool, sym, itv, desde):
    ahora = int(time.time() * 1000)
    # la primera vela que existe
    j = pide(sym, itv, desde)
    if not j:
        log('sin datos', sym, itv)
        return 0
    ini = int(j[0][0])
    trozos = list(range(ini, ahora, 1000 * MS[itv]))
    res = list(pool.map(lambda t: pide(sym, itv, t), trozos))
    filas, fallos = [], 0
    for r in res:
        if r is None:
            fallos += 1
            continue
        filas.extend(r)
    if not filas:
        return 0
    a = np.array([[float(x[0]) / 1000, float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[7]), float(x[10]), float(x[8])] for x in filas], dtype=np.float64)
    t = a[:, 0].astype(np.int64)
    k = np.argsort(t, kind='stable'); a, t = a[k], t[k]
    k = np.flatnonzero(np.r_[True, np.diff(t) > 0]); a, t = a[k], t[k]
    k = (t + MS[itv] // 1000) * 1000 <= ahora; a, t = a[k], t[k]   # solo velas cerradas
    esc = 10 ** int(np.floor(np.log10(2e9 / a[:, 2].max())))
    esc = min(esc, 10 ** 8)
    q = np.round(a[:, 1:5] * esc).astype(np.int64)
    # volumen en dólares / 10 000 (se guarda *100); extra: volumen comprador (misma unidad *100) y número de operaciones
    n = guarda(OUT, 'binance_' + sym + '_' + {'1m': 'M1', '5m': 'M5', '1h': 'H1'}[itv], t, q[:, 0], q[:, 1], q[:, 2], q[:, 3], a[:, 5] / 1e4, esc, extra=[a[:, 6] / 100, a[:, 7]])
    log(sym, itv, n, dt.datetime.utcfromtimestamp(int(t[0])).date(), 'fallos', fallos, 'base', BASE[0])
    return n


if __name__ == '__main__':
    OUT = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    d2017 = calendar.timegm((2017, 1, 1, 0, 0, 0)) * 1000
    d2023 = calendar.timegm((2023, 1, 1, 0, 0, 0)) * 1000
    with ThreadPoolExecutor(int(os.environ.get('HILOS', '8'))) as pool:
        for s in H1:
            serie(pool, s, '1h', d2017)
        for s in M5:
            serie(pool, s, '5m', d2017)
        for s in M1:
            serie(pool, s, '1m', d2023)
    cierra(OUT)
