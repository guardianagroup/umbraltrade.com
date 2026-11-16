#!/usr/bin/env bash
# La racha de 1 minuto: corre tools/racha.js unas 5 h 45 min dentro de una tarea de GitHub, guarda racha.json y racha-ops.jsonl en la rama «cuenta»
# cada minuto y, al acabar, lanza la tarea siguiente. Para pararla: desactivar la tarea Racha en Actions (y cancelar la que esté en marcha).
set -u
DUR=${RACHA_MIN:-345}; FIN=$(( $(date +%s) + DUR * 60 ))
relanza() {
  [ -n "${RACHA_NO_RELANZA:-}" ] && return
  [ -z "${GH_TOKEN:-}" ] && { echo "sin GH_TOKEN: no se lanza la siguiente tarea"; return; }
  for i in 1 2 3; do gh workflow run racha.yml --ref main && { echo "siguiente tarea lanzada"; return; }; sleep 15; done
}
guarda() {
  ( cd datos || exit 0
    git add -A; git diff --cached --quiet && exit 0
    git commit -q -m "Racha $(date -u +%Y-%m-%dT%H:%MZ)"
    for i in 1 2 3 4; do git push -q origin HEAD:cuenta && exit 0; git pull -q --rebase --autostash origin cuenta || true; sleep 2; done; exit 1 ) || echo "no se pudo guardar el estado"
}
trap 'guarda; relanza' EXIT
echo "racha: empieza $(date -u +%H:%M) UTC, termina hacia $(date -u -d @$FIN +%H:%M) UTC"
node tools/racha.js datos/racha.json "$FIN" &
PID=$!
while kill -0 "$PID" 2>/dev/null; do sleep 60; guarda; done
wait "$PID"; echo "racha: node terminó ($?)"
