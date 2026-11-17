#!/usr/bin/env bash
# Motor de Umbral: pone al día el calendario económico de la web (data/calendar.json, en la rama main) a los 17 minutos de cada hora.
# Es un bucle de unas 5 h 40 min dentro de una tarea de GitHub que, al acabar, lanza la siguiente: las tareas programadas de GitHub no
# se disparan con fiabilidad. Hasta el 16-11-2026 también movía el Reto y la cuenta del algoritmo, que ya no existen.
# Variables: MOTOR_MIN (minutos de bucle, 340 por defecto), MOTOR_NO_RELANZA (no lanzar la siguiente tarea), GH_TOKEN (para lanzarla).
set -u
DUR=${MOTOR_MIN:-340}; FIN=$(( $(date +%s) + DUR * 60 ))
relanza() {
  [ -n "${MOTOR_NO_RELANZA:-}" ] && return
  [ -z "${GH_TOKEN:-}" ] && { echo "sin GH_TOKEN: no se lanza la siguiente tarea"; return; }
  for i in 1 2 3; do gh workflow run motor.yml --ref main && { echo "siguiente tarea lanzada"; return; }; sleep 15; done
}
trap relanza EXIT
calendario() {
  git pull -q --rebase origin main || true
  timeout 90 node tools/calendar.js data/calendar.json || { echo "calendario: fallo"; return; }
  if git diff --quiet -- data/calendar.json; then echo "calendario: sin cambios"; return; fi
  git add data/calendar.json && git commit -q -m "Calendario económico al día" || return
  for i in 1 2 3; do git pull -q --rebase origin main && git push -q origin HEAD:main && { echo "calendario: guardado"; return; }; sleep 5; done; echo "calendario: no se pudo guardar"
}
echo "motor: empieza $(date -u +%H:%M) UTC, termina hacia $(date -u -d @$FIN +%H:%M) UTC"
while :; do
  calendario
  ahora=$(date +%s); prox=$(( (ahora / 3600 + 1) * 3600 + 17 * 60 )); [ $(( prox - ahora )) -gt 3600 ] && prox=$(( prox - 3600 ))
  [ "$prox" -ge "$FIN" ] && break
  sleep $(( prox - ahora ))
done
echo "motor: fin $(date -u +%H:%M) UTC"
