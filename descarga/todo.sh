#!/usr/bin/env bash
# Descarga una parte de los datos del estudio, la cifra con la clave pública y la deja en la rama temporal datos-<parte>.
# "limpia" borra todas las ramas temporales; "fin" borra también la rama de estas herramientas.
set -euo pipefail
PARTE="${1:-h1a}"
cd "$(dirname "$0")"
REMOTO="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
if [ "$PARTE" = "limpia" ] || [ "$PARTE" = "fin" ]; then
  for r in $(git ls-remote "$REMOTO" 'refs/heads/datos-*' | cut -f2); do git push -q "$REMOTO" --delete "$r" && echo "borrada $r"; done
  if [ "$PARTE" = "fin" ]; then git push -q "$REMOTO" --delete refs/heads/estudio && echo "borrada la rama estudio"; fi
  exit 0
fi
OUT="$PWD/out"; rm -rf "$OUT"; mkdir -p "$OUT"
python3 -m pip install -q numpy websockets >/dev/null 2>&1 || python3 -m pip install -q --break-system-packages numpy websockets
case "$PARTE" in
  h1a) python3 duka.py h1 "$OUT" 2003 EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,NZDUSD ;;
  h1b) python3 duka.py h1 "$OUT" 2003 EURJPY,GBPJPY,EURGBP,AUDJPY,EURAUD,EURCAD,EURCHF ;;
  h1c) python3 duka.py h1 "$OUT" 2003 GBPAUD,AUDCAD,AUDCHF,AUDNZD,EURNZD,GBPCAD,GBPCHF ;;
  h1d) python3 duka.py h1 "$OUT" 2003 GBPNZD,NZDJPY,USDMXN,USDPLN,XAUUSD,XAGUSD,BTCUSD,ETHUSD ;;
  h1e) python3 duka.py h1 "$OUT" 2008 USATECHIDXUSD,USA500IDXUSD,USA30IDXUSD,DEUIDXEUR,GBRIDXGBP,FRAIDXEUR ;;
  h1f) python3 duka.py h1 "$OUT" 2008 EUSIDXEUR,NLDIDXEUR,CHEIDXCHF,JPNIDXJPY,HKGIDXHKD,AUSIDXAUD,XPTCMDUSD,XPDCMDUSD ;;
  m1-*) python3 duka.py m1 "$OUT" 2018-01-01 2025-01-01 "${PARTE#m1-}" ;;
  deriv) COSTES=0 python3 deriv.py "$OUT" ;;
  costes) SOLO_COSTES=1 python3 deriv.py "$OUT" ;;
  binance) HILOS=4 python3 binance.py "$OUT" ;;
  *) echo "parte desconocida: $PARTE"; exit 1 ;;
esac
ls -la "$OUT" | head -80
cp "$OUT/log.txt" /tmp/log.txt 2>/dev/null || echo "sin log" > /tmp/log.txt
# empaquetar y cifrar: clave aleatoria AES-256 cifrada con la clave pública (solo quien tiene la privada puede abrirlo)
tar -C "$OUT" -cf - . | xz -T0 -6 > /tmp/datos.tar.xz
openssl rand -hex 32 > /tmp/k.txt
openssl enc -aes-256-ctr -pbkdf2 -pass file:/tmp/k.txt -in /tmp/datos.tar.xz -out /tmp/datos.enc
openssl pkeyutl -encrypt -pubin -inkey pub.pem -pkeyopt rsa_padding_mode:oaep -in /tmp/k.txt -out /tmp/k.enc
sha256sum /tmp/datos.tar.xz | cut -d' ' -f1 > /tmp/suma.txt
rm -f /tmp/k.txt /tmp/datos.tar.xz
ls -la /tmp/datos.enc
TMP="$(mktemp -d)"; cd "$TMP"
git init -q; git config user.name "umbral-estudio"; git config user.email "umbral-estudio@users.noreply.github.com"
split -b 45m -d /tmp/datos.enc parte_
cp /tmp/k.enc /tmp/suma.txt .
git add -A; git commit -q -m "datos $PARTE (cifrados, temporales)"
RAMA="datos-$(echo "$PARTE" | tr -c 'A-Za-z0-9\n' '-')"
for i in 1 2 3; do git push -q -f "$REMOTO" "HEAD:refs/heads/$RAMA" && echo "subido $RAMA" && exit 0; sleep 10; done
exit 1
