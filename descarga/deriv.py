# Velas de Deriv (API pública): todo lo que deje el servidor hacia atrás, hasta DIAS días.
#   python deriv.py OUT
import sys, os, json, asyncio, time
import numpy as np
import websockets
from comun import guarda, cierra, log

URL = 'wss://api.derivws.com/trading/v1/options/ws/public'
DIAS = int(os.environ.get('DIAS', '420'))
REALES = ('frxXAUUSD frxXAGUSD frxXPTUSD frxXPDUSD frxEURUSD frxGBPUSD frxUSDJPY frxAUDUSD frxUSDCAD frxUSDCHF frxNZDUSD frxEURJPY frxGBPJPY frxEURGBP '
          'frxAUDJPY frxEURAUD frxEURCAD frxEURCHF frxGBPAUD frxAUDCAD frxAUDCHF frxAUDNZD frxEURNZD frxGBPCAD frxGBPCHF frxGBPNZD frxNZDJPY frxUSDMXN frxUSDPLN '
          'OTC_NDX OTC_SPC OTC_DJI OTC_GDAXI OTC_FTSE OTC_FCHI OTC_SX5E OTC_AEX OTC_SSMI OTC_N225 OTC_HSI OTC_AS51 cryBTCUSD cryETHUSD').split()
M1_REALES = 'frxEURUSD frxGBPUSD frxUSDJPY frxXAUUSD OTC_SPC OTC_NDX OTC_GDAXI cryBTCUSD'.split()
SINT_M5 = 'R_10 R_25 R_50 R_75 R_100 1HZ10V 1HZ25V 1HZ50V 1HZ75V 1HZ100V BOOM500 BOOM1000 CRASH500 CRASH1000 stpRNG JD25 JD75'.split()
SINT_M1 = 'R_75 1HZ100V BOOM1000 CRASH1000'.split()
G = {'M1': 60, 'M5': 300, 'H1': 3600}


class Cliente:
    def __init__(self):
        self.ws = None
        self.id = 0

    async def abre(self):
        for k in range(6):
            try:
                self.ws = await websockets.connect(URL, max_size=None, open_timeout=20, ping_interval=20)
                return
            except Exception as e:
                await asyncio.sleep(2 * (k + 1))
        raise RuntimeError('Deriv no conecta')

    async def pide(self, msg, tries=6):
        for k in range(tries):
            try:
                if self.ws is None:
                    await self.abre()
                self.id += 1
                msg['req_id'] = self.id
                await self.ws.send(json.dumps(msg))
                while True:
                    d = json.loads(await asyncio.wait_for(self.ws.recv(), 40))
                    if d.get('req_id') == self.id:
                        break
                if 'error' in d:
                    code = d['error'].get('code', '')
                    if code in ('RateLimit', 'WrongResponse') or 'rate' in str(d['error'].get('message', '')).lower():
                        await asyncio.sleep(8 * (k + 1))
                        continue
                    return d
                return d
            except Exception:
                try:
                    await self.ws.close()
                except Exception:
                    pass
                self.ws = None
                await asyncio.sleep(2 * (k + 1))
        return {'error': {'code': 'sin respuesta'}}


async def serie(cl, code, tf, dec):
    g, fin, desde = G[tf], 'latest', int(time.time()) - DIAS * 86400
    filas, antes, vacias = [], None, 0
    while True:
        d = await cl.pide({'ticks_history': code, 'end': str(fin), 'count': 5000, 'style': 'candles', 'granularity': g})
        if 'error' in d:
            log('error', code, tf, d['error'].get('code'), str(d['error'].get('message', ''))[:80])
            break
        c = d.get('candles') or []
        if not c:
            break
        t0 = int(c[0]['epoch'])
        if antes is not None and t0 >= antes:
            break
        filas[0:0] = [(int(x['epoch']), float(x['open']), float(x['high']), float(x['low']), float(x['close'])) for x in c if antes is None or int(x['epoch']) < antes]
        antes = t0
        if t0 <= desde or len(c) < 50:
            break
        fin = t0 - 1
    if not filas:
        return 0
    a = np.array(filas, dtype=np.float64)
    t = a[:, 0].astype(np.int64)
    k = np.flatnonzero(np.r_[True, np.diff(t) > 0])
    a, t = a[k], t[k]
    esc = 10 ** dec
    q = np.round(a[:, 1:5] * esc).astype(np.int64)
    return guarda(OUT, 'deriv_' + code + '_' + tf, t, q[:, 0], q[:, 1], q[:, 2], q[:, 3], None, esc)


async def trabajador(cola):
    cl = Cliente()
    await cl.abre()
    while True:
        try:
            code, tf, dec = cola.get_nowait()
        except asyncio.QueueEmpty:
            break
        t0 = time.time()
        n = await serie(cl, code, tf, dec)
        log(code, tf, n, round(time.time() - t0, 1), 's')
    try:
        await cl.ws.close()
    except Exception:
        pass


DUR = [(1, 'm'), (2, 'm'), (3, 'm'), (5, 'm'), (10, 'm'), (15, 'm'), (30, 'm'), (1, 'h'), (2, 'h'), (4, 'h'), (8, 'h'), (1, 'd')]


async def costes(cl, codes):
    """Lo que cuesta operar cada mercado en Deriv ahora mismo: comisión del multiplicador y pago de Sube/Baja por vencimiento."""
    out = {}
    for code in codes:
        r = {'tipos': {}, 'mult': None, 'pago': {}}
        d = await cl.pide({'contracts_for': code}, tries=2)
        av = (d.get('contracts_for') or {}).get('available') or []
        for x in av:
            k = x.get('contract_type')
            if k in ('CALL', 'PUT', 'MULTUP', 'MULTDOWN'):
                r['tipos'].setdefault(k, []).append([x.get('contract_category'), x.get('barrier_category'), x.get('start_type'), x.get('expiry_type'), x.get('min_contract_duration'), x.get('max_contract_duration'), x.get('barriers'), x.get('multiplier_range')])
        ms = None
        for x in av:
            if x.get('contract_type') == 'MULTUP' and x.get('multiplier_range'):
                ms = x['multiplier_range']
        if ms:
            p = await cl.pide({'proposal': 1, 'amount': 100, 'basis': 'stake', 'contract_type': 'MULTUP', 'currency': 'USD', 'underlying_symbol': code, 'multiplier': ms[0]}, tries=2)
            q = p.get('proposal') or {}
            r['mult'] = {'rango': ms, 'comision': q.get('commission'), 'tasa': (float(q['commission']) / (100 * ms[0])) if q.get('commission') else None, 'error': (p.get('error') or {}).get('code')}
        for n, u in DUR:
            fila = []
            for tipo in ('CALL', 'PUT'):
                p = await cl.pide({'proposal': 1, 'amount': 100, 'basis': 'stake', 'contract_type': tipo, 'currency': 'USD', 'underlying_symbol': code, 'duration': n, 'duration_unit': u}, tries=2)
                q = p.get('proposal') or {}
                fila.append(float(q['payout']) / 100 - 1 if q.get('payout') else (p.get('error') or {}).get('code'))
            r['pago'][str(n) + u] = fila
        out[code] = r
        log('costes', code, 'mult', (r['mult'] or {}).get('tasa'), 'pago 5m/15m/1h/1d', r['pago'].get('5m'), r['pago'].get('15m'), r['pago'].get('1h'), r['pago'].get('1d'))
    with open(os.path.join(OUT, 'deriv_costes.json'), 'w') as f:
        json.dump(out, f)


DUR_P = [(15, 'm'), (30, 'm'), (1, 'h'), (2, 'h'), (4, 'h'), (8, 'h'), (1, 'd'), (2, 'd'), (3, 'd'), (5, 'd'), (7, 'd'), (14, 'd'), (30, 'd'), (60, 'd'), (90, 'd'), (180, 'd'), (365, 'd')]
PAGOS = ('OTC_SPC OTC_NDX OTC_DJI OTC_GDAXI OTC_FTSE OTC_FCHI OTC_SX5E OTC_AEX OTC_SSMI OTC_N225 OTC_HSI OTC_AS51 '
         'frxEURUSD frxGBPUSD frxUSDJPY frxAUDUSD frxXAUUSD frxXAGUSD R_100 R_75 1HZ100V').split()


async def pagos(cl, codes, info):
    """Lo que paga Deriv en cada contrato de opciones ahora mismo (apuesta de 10 USD): Sube/Baja por vencimiento (de 15 min a 365 días),
    Superior/Inferior con barrera y Toca/No toca. Sirve para ver si el pago tiene en cuenta la deriva del activo y la volatilidad."""
    out = {}

    async def una(code, tipo, n, u, barrera=None):
        m = {'proposal': 1, 'amount': 10, 'basis': 'stake', 'contract_type': tipo, 'currency': 'USD', 'underlying_symbol': code, 'duration': n, 'duration_unit': u}
        if barrera is not None:
            m['barrier'] = barrera
        p = await cl.pide(m, tries=2)
        q = p.get('proposal') or {}
        if q.get('payout'):
            return {'pago': float(q['payout']) / 10 - 1, 'spot': q.get('spot'), 'vence': q.get('date_expiry'), 'inicio': q.get('date_start'), 'texto': (q.get('longcode') or '')[:170]}
        e = p.get('error') or {}
        return {'error': e.get('code'), 'msg': str(e.get('message'))[:220]}

    for code in codes:
        r = {'tipos': [], 'callput': {}, 'barrera': {}, 'toca': {}, 'hora': int(time.time())}
        d = await cl.pide({'contracts_for': code}, tries=2)
        av = (d.get('contracts_for') or {}).get('available') or []
        vistos = set()
        for x in av:
            k = (x.get('contract_type'), x.get('contract_category'), x.get('expiry_type'), x.get('barrier_category'), x.get('min_contract_duration'), x.get('max_contract_duration'), x.get('barriers'))
            if k not in vistos:
                vistos.add(k)
                r['tipos'].append(list(k) + [x.get('barrier'), x.get('high_barrier'), x.get('low_barrier')])
        spot = None
        for n, u in DUR_P:
            fila = {}
            for tipo in ('CALL', 'PUT'):
                fila[tipo] = await una(code, tipo, n, u)
                if fila[tipo].get('spot'):
                    spot = float(fila[tipo]['spot'])
            r['callput'][str(n) + u] = fila
        dec = (info.get(code) or {}).get('dec', 2)
        if spot:
            for n, u in ((1, 'd'), (7, 'd'), (30, 'd')):
                for frac in (0.005, 0.01, 0.02):
                    for sg in ('+', '-'):
                        b = sg + ('%.*f' % (dec, spot * frac))
                        k = '%d%s %s%.3f' % (n, u, sg, frac)
                        r['barrera'][k] = {t: await una(code, t, n, u, b) for t in ('CALL', 'PUT')}
                        r['toca'][k] = {t: await una(code, t, n, u, b) for t in ('ONETOUCH', 'NOTOUCH')}
        out[code] = r
        g = lambda k, t: (r['callput'].get(k, {}).get(t, {}) or {}).get('pago')
        log('pagos', code, 'spot', spot, 'CALL/PUT 15m', g('15m', 'CALL'), g('15m', 'PUT'), '1h', g('1h', 'CALL'), g('1h', 'PUT'), '1d', g('1d', 'CALL'), g('1d', 'PUT'), '7d', g('7d', 'CALL'), g('7d', 'PUT'),
            '30d', g('30d', 'CALL'), g('30d', 'PUT'), '90d', g('90d', 'CALL'), g('90d', 'PUT'), '365d', g('365d', 'CALL'), g('365d', 'PUT'), '| error 1d', (r['callput'].get('1d', {}).get('CALL', {}) or {}).get('msg'))
        with open(os.path.join(OUT, 'deriv_pagos.json'), 'w') as f:
            json.dump(out, f)



async def main():
    cl = Cliente()
    await cl.abre()
    d = await cl.pide({'active_symbols': 'brief'})
    syms = d.get('active_symbols') or []
    log('simbolos activos', len(syms), 'error' if 'error' in d else '')
    info = {}
    for s in syms:
        code = s.get('underlying_symbol') or s.get('symbol')
        pip = float(s.get('pip_size') or s.get('pip') or 0.01)
        info[code] = {'dec': max(0, int(round(-np.log10(pip)))) if pip < 1 else int(pip), 'mercado': s.get('market'), 'sub': s.get('submarket'), 'nombre': s.get('underlying_symbol_name') or s.get('display_name'),
                      'abierto': bool(s.get('exchange_is_open')) and not s.get('is_trading_suspended')}
    with open(os.path.join(OUT, 'deriv_simbolos.json'), 'w') as f:
        json.dump(info, f)
    if os.environ.get('SOLO_PAGOS') == '1':
        await pagos(cl, PAGOS, info)
        try:
            await cl.ws.close()
        except Exception:
            pass
        return
    if os.environ.get('COSTES', '1') == '1':
        try:
            await costes(cl, REALES + [c for c in SINT_M5 if c in info])
        except Exception as e:
            log('costes: fallo', repr(e)[:200])
    try:
        await cl.ws.close()
    except Exception:
        pass
    if os.environ.get('SOLO_COSTES') == '1':
        return
    sint = [c for c, v in info.items() if v['mercado'] == 'synthetic_index']
    cola = asyncio.Queue()
    dec = lambda c: info.get(c, {}).get('dec', 5 if c.startswith('frx') else 2)
    for c in REALES:
        cola.put_nowait((c, 'H1', dec(c)))
    for c in sint:
        cola.put_nowait((c, 'H1', dec(c)))
    for c in REALES:
        cola.put_nowait((c, 'M5', dec(c)))
    for c in SINT_M5:
        if c in info:
            cola.put_nowait((c, 'M5', dec(c)))
    for c in M1_REALES + [c for c in SINT_M1 if c in info]:
        cola.put_nowait((c, 'M1', dec(c)))
    log('series', cola.qsize(), 'sinteticos', len(sint))
    await asyncio.gather(*[trabajador(cola) for _ in range(int(os.environ.get('HILOS', '4')))])


if __name__ == '__main__':
    OUT = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    asyncio.run(main())
    cierra(OUT)
