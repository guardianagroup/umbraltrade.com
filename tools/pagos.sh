#!/usr/bin/env bash
# Recolector de pagos de Deriv (prueba de una semana, del 16 al 23-11-2026): cada 5 minutos guarda lo que paga Deriv por Sube y por Baja
# (tools/pagos.js) y cada media hora lo sube a la rama «pagos» del repositorio. Es un bucle de unas 5 h 40 min dentro de una tarea de
# GitHub que, al acabar, lanza la siguiente. Al llegar el final de la prueba deja de relanzarse y desactiva la tarea.
# Variables: PAGOS_HASTA (fin de la prueba, segundos UNIX), PAGOS_MIN (minutos de bucle), PAGOS_NO_RELANZA, GH_TOKEN (para relanzar).
set -u
HASTA=${PAGOS_HASTA:-1795488300}   # 24-11-2026 02:45 UTC = 23-11 a las 21:45 en Bogotá
AHORA=$(date +%s)
if [ "$AHORA" -ge "$HASTA" ]; then
  echo "la prueba ya terminó: se desactiva la tarea"
  [ -n "${GH_TOKEN:-}" ] && gh workflow disable pagos.yml || true
  exit 0
fi
FIN=$(( AHORA + ${PAGOS_MIN:-340} * 60 )); [ "$FIN" -gt "$HASTA" ] && FIN=$HASTA
relanza() {
  [ -n "${PAGOS_NO_RELANZA:-}" ] && return
  [ -z "${GH_TOKEN:-}" ] && { echo "sin GH_TOKEN: no se lanza la siguiente tarea"; return; }
  if [ "$(date +%s)" -ge "$HASTA" ]; then echo "fin de la prueba: no se relanza"; gh workflow disable pagos.yml || true; return; fi
  for i in 1 2 3; do gh workflow run pagos.yml --ref main && { echo "siguiente tarea lanzada"; return; }; sleep 15; done
}
trap relanza EXIT
DATOS=$(mktemp -d)/pagos
git fetch -q origin pagos && git worktree add -q -B pagos "$DATOS" origin/pagos || { echo "no hay rama pagos"; exit 1; }
guarda() {
  ( cd "$DATOS" && git add -A && { git diff --cached --quiet || git commit -q -m "Pagos de Deriv $(date -u +%d-%m\ %H:%M) UTC"; } &&
    for i in 1 2 3; do git pull -q --rebase origin pagos && git push -q origin HEAD:pagos && { echo "guardado"; break; }; sleep 5; done ) || echo "no se pudo guardar"
}
echo "pagos: empieza $(date -u +%H:%M) UTC, termina hacia $(date -u -d @$FIN +%H:%M) UTC"
node tools/pagos.js "$DATOS" "$FIN" &
PID=$!
while kill -0 $PID 2>/dev/null; do
  for s in $(seq 1 180); do kill -0 $PID 2>/dev/null || break; sleep 10; done
  guarda
done
guarda
echo "pagos: fin $(date -u +%H:%M) UTC"
