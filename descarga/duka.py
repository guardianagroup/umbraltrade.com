# Velas históricas de Dukascopy (datafeed público), en UTC.
#   python duka.py h1 OUT 2003 EURUSD,GBPUSD,...            velas de 1 hora por meses, desde ese año
#   python duka.py m1 OUT 2018-01-01 2025-01-01 EURUSD,...   velas de 1 minuto por días -> guarda M5 de todo y M1 desde la segunda fecha
import sys, os, lzma, datetime as dt, calendar, time, threading, http.client, collections
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from comun import guarda, cierra, agrega, log, UA

HOST = 'datafeed.dukascopy.com'
BASE = '/datafeed/'
ERR = collections.Counter()
_tl = threading.local()
PAUSA = float(os.environ.get('PAUSA', '0'))


def baja(ruta, tries=8):
    """Una conexión por hilo, que se mantiene abierta (abrir una nueva en cada petición hace que el servidor frene)."""
    for k in range(tries):
        conn = getattr(_tl, 'c', None)
        try:
            if conn is None:
                conn = _tl.c = http.client.HTTPSConnection(HOST, timeout=30)
            conn.request('GET', ruta, headers=UA)
            r = conn.getresponse()
            body = r.read()
            if r.status == 200:
                ERR['ok'] += 1
                if PAUSA:
                    time.sleep(PAUSA)
                return body
            if r.status == 404:
                ERR['404'] += 1
                return b''
            ERR[str(r.status)] += 1
            time.sleep(min(20, 2 * (k + 1)))
        except Exception as e:
            ERR[type(e).__name__] += 1
            try:
                conn.close()
            except Exception:
                pass
            _tl.c = None
            time.sleep(min(20, 1 + k))
    return None
REC = np.dtype([('t', '>i4'), ('f1', '>i4'), ('f2', '>i4'), ('f3', '>i4'), ('f4', '>i4'), ('v', '>f4')])
HILOS = int(os.environ.get('HILOS', '4'))
LADO = os.environ.get('LADO', 'BID')   # BID (por defecto) o ASK: con las dos se saca el precio medio y el diferencial real
PRE = 'duka' if LADO == 'BID' else 'dukaask'
FALLOS = []
MAPA = {}   # por instrumento: qué columna es o, c, l, h


def lee(raw):
    if not raw:
        return np.empty(0, dtype=REC)
    try:
        data = lzma.decompress(raw)
    except Exception:
        return None
    n = len(data) // 24
    return np.frombuffer(data[:n * 24], dtype=REC)


def mapa(ins, a):
    """El orden de los campos es apertura, cierre, mínimo, máximo (comprobado en todos los instrumentos). Aquí solo se anota, con las velas
    que no son planas, si de verdad el cuarto campo es el máximo y el tercero el mínimo. (Antes se deducía del primer archivo y, si ese
    archivo solo tenía velas planas, salía mal: pasó con el oro y la plata.)"""
    if ins in MAPA:
        return
    cols = np.stack([a['f1'], a['f2'], a['f3'], a['f4']], axis=1).astype(np.int64)
    k = cols.max(axis=1) > cols.min(axis=1)
    if k.sum() < 100:
        return
    c = cols[k]
    MAPA[ins] = (0, 1, 2, 3)
    log('campos', ins, 'máximo en f4: %.4f' % (c[:, 3] == c.max(axis=1)).mean(), 'mínimo en f3: %.4f' % (c[:, 2] == c.min(axis=1)).mean(), 'velas planas: %.3f' % (1 - k.mean()))


def campos(ins, a):
    o, c, l, h = MAPA.get(ins, (0, 1, 2, 3))
    f = ['f1', 'f2', 'f3', 'f4']
    return a[f[o]].astype(np.int64), a[f[h]].astype(np.int64), a[f[l]].astype(np.int64), a[f[c]].astype(np.int64)


def trae(url):
    raw = baja(url)
    if raw is None:
        FALLOS.append(url)
        return np.empty(0, dtype=REC)
    a = lee(raw)
    if a is None:
        FALLOS.append(url)
        return np.empty(0, dtype=REC)
    return a


def junta(ins, piezas):
    """piezas: lista de (epoch_inicio, matriz). Devuelve t, o, h, l, c, v sin las velas sin movimiento."""
    ts, os_, hs, ls, cs, vs = [], [], [], [], [], []
    for t0, a in piezas:
        if len(a) == 0:
            continue
        mapa(ins, a)
    for t0, a in piezas:
        if len(a) == 0:
            continue
        a = a[a['v'] > 0]
        if len(a) == 0:
            continue
        o, h, l, c = campos(ins, a)
        ts.append(t0 + a['t'].astype(np.int64)); os_.append(o); hs.append(h); ls.append(l); cs.append(c); vs.append(a['v'].astype(np.float64))
    if not ts:
        z = np.empty(0, dtype=np.int64)
        return z, z, z, z, z, np.empty(0)
    t = np.concatenate(ts); k = np.argsort(t, kind='stable')
    return t[k], np.concatenate(os_)[k], np.concatenate(hs)[k], np.concatenate(ls)[k], np.concatenate(cs)[k], np.concatenate(vs)[k]


def dias_m1(ins, d0, d1, pool, cripto=False):
    dias = []
    d = d0
    while d <= d1:
        if cripto or d.weekday() != 5:
            dias.append(d)
        d += dt.timedelta(days=1)
    urls = [('%s%s/%04d/%02d/%02d/' + LADO + '_candles_min_1.bi5') % (BASE, ins, d.year, d.month - 1, d.day) for d in dias]
    res = list(pool.map(trae, urls))
    return junta(ins, [(calendar.timegm(d.timetuple()), a) for d, a in zip(dias, res)])


def modo_h1(out, desde, lista):
    hoy = dt.datetime.utcnow().date()
    with ThreadPoolExecutor(HILOS) as pool:
        for ins in lista:
            meses = [(y, m) for y in range(desde, hoy.year + 1) for m in range(1, 13) if (y, m) <= (hoy.year, hoy.month)]
            urls = [('%s%s/%04d/%02d/' + LADO + '_candles_hour_1.bi5') % (BASE, ins, y, m - 1) for y, m in meses]
            res = list(pool.map(trae, urls))
            t, o, h, l, c, v = junta(ins, [(calendar.timegm((y, m, 1, 0, 0, 0)), a) for (y, m), a in zip(meses, res)])
            # lo más reciente (el mes en curso puede no estar): se completa con velas de 1 minuto de los últimos 45 días
            ult = int(t[-1]) if len(t) else 0
            d0 = max(hoy - dt.timedelta(days=45), dt.datetime.utcfromtimestamp(ult).date() if ult else hoy - dt.timedelta(days=45))
            cri = ins in ('BTCUSD', 'ETHUSD')
            if len(t):
                t2, o2, h2, l2, c2, v2 = dias_m1(ins, d0, hoy - dt.timedelta(days=1), pool, cri)
                t2, o2, h2, l2, c2, v2 = agrega(t2, o2, h2, l2, c2, v2, 3600)
                k = t2 > ult
                if k.any():
                    t, o, h, l, c, v = [np.concatenate([a, b[k]]) for a, b in ((t, t2), (o, o2), (h, h2), (l, l2), (c, c2), (v, v2))]
            n = guarda(out, PRE + '_' + ins + '_H1', t, o, h, l, c, v)
            log('H1', ins, n, round(time.time() - T0), 's', dict(ERR), dt.datetime.utcfromtimestamp(int(t[0])).date() if n else '-', dt.datetime.utcfromtimestamp(int(t[-1])) if n else '-', 'fallos', len(FALLOS))


def modo_m1(out, desde, m1desde, lista):
    hoy = dt.datetime.utcnow().date()
    d0 = dt.date.fromisoformat(desde)
    k1 = calendar.timegm(dt.date.fromisoformat(m1desde).timetuple()) if m1desde != '-' else None
    with ThreadPoolExecutor(HILOS) as pool:
        for item in lista:
            ins, guarda_m1 = (item[:-1], True) if item.endswith('+') else (item, False)
            t, o, h, l, c, v = dias_m1(ins, d0, hoy - dt.timedelta(days=1), pool, ins in ('BTCUSD', 'ETHUSD'))
            n5 = guarda(out, PRE + '_' + ins + '_M5', *agrega(t, o, h, l, c, v, 300))
            n1 = 0
            if guarda_m1 and k1 is not None and len(t):
                k = t >= k1
                n1 = guarda(out, PRE + '_' + ins + '_M1', t[k], o[k], h[k], l[k], c[k], v[k])
            log('M1', ins, round(time.time() - T0), 's', dict(ERR), 'm1', len(t), 'M5', n5, 'M1 guardadas', n1, dt.datetime.utcfromtimestamp(int(t[0])).date() if len(t) else '-', 'fallos', len(FALLOS))


T0 = time.time()

if __name__ == '__main__':
    modo, out = sys.argv[1], sys.argv[2]
    if modo == 'h1':
        modo_h1(out, int(sys.argv[3]), sys.argv[4].split(','))
    else:
        modo_m1(out, sys.argv[3], sys.argv[4], sys.argv[5].split(','))
    log('fallos definitivos', len(FALLOS), FALLOS[:5])
    cierra(out)
