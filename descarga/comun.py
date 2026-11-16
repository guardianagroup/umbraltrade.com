# Formato común de las series: matriz int32 (N, 6+k) con diferencias, que comprime bien.
#   col 0: t[0] y luego t[i]-t[i-1] (segundos)      col 1: o[0] y luego o[i]-o[i-1] (puntos)
#   col 2: h-o   col 3: o-l   col 4: c-o             col 5: volumen*100   resto: columnas extra tal cual
import json, os, time, urllib.request, urllib.error
import numpy as np

UA = {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'}
META = {}
LOG = []


def log(*a):
    s = ' '.join(str(x) for x in a)
    LOG.append(s)
    print(s, flush=True)


def baja(url, tries=7, timeout=40):
    """Descarga una URL. Devuelve bytes (vacío si 404) o None si falla del todo."""
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return b''
            time.sleep(min(30, 1.5 * (k + 1) * (4 if e.code in (429, 418, 503) else 1)))
        except Exception:
            time.sleep(1.5 * (k + 1))
    return None


def guarda(carpeta, nombre, t, o, h, l, c, v=None, escala=1, extra=None, **mas):
    n = len(t)
    if n == 0:
        META[nombre] = {'n': 0}
        return 0
    t = np.asarray(t, dtype=np.int64); o = np.asarray(o, dtype=np.int64); h = np.asarray(h, dtype=np.int64)
    l = np.asarray(l, dtype=np.int64); c = np.asarray(c, dtype=np.int64)
    k = len(extra) if extra else 0
    a = np.zeros((n, 6 + k), dtype=np.int64)
    a[0, 0] = t[0]; a[1:, 0] = np.diff(t)
    a[0, 1] = o[0]; a[1:, 1] = np.diff(o)
    a[:, 2] = h - o; a[:, 3] = o - l; a[:, 4] = c - o
    if v is not None:
        a[:, 5] = np.clip(np.round(np.asarray(v, dtype=np.float64) * 100), 0, 2 ** 31 - 1)
    for j in range(k):
        a[:, 6 + j] = np.clip(np.round(np.asarray(extra[j], dtype=np.float64)), -2 ** 31 + 1, 2 ** 31 - 1)
    assert np.abs(a).max() < 2 ** 31, nombre + ': no cabe en int32'
    os.makedirs(carpeta, exist_ok=True)
    np.save(os.path.join(carpeta, nombre + '.npy'), a.astype(np.int32))
    m = {'n': int(n), 't0': int(t[0]), 't1': int(t[-1]), 'escala': escala}
    m.update(mas)
    META[nombre] = m
    return n


def cierra(carpeta):
    """Guarda el índice y el registro (se suman a lo que ya hubiera en la carpeta)."""
    os.makedirs(carpeta, exist_ok=True)
    f1, f2 = os.path.join(carpeta, 'meta.json'), os.path.join(carpeta, 'log.txt')
    todo = {}
    if os.path.exists(f1):
        with open(f1) as f:
            todo = json.load(f)
    todo.update(META)
    with open(f1, 'w') as f:
        json.dump(todo, f)
    with open(f2, 'a') as f:
        f.write('\n'.join(LOG) + '\n')


def agrega(t, o, h, l, c, v, g):
    """Agrupa velas ordenadas en velas de g segundos."""
    if len(t) == 0:
        return t, o, h, l, c, v
    b = (t // g) * g
    idx = np.flatnonzero(np.r_[True, b[1:] != b[:-1]])
    fin = np.r_[idx[1:] - 1, len(t) - 1]
    return b[idx], o[idx], np.maximum.reduceat(h, idx), np.minimum.reduceat(l, idx), c[fin], np.add.reduceat(v, idx)
