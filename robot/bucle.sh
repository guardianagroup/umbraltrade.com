#!/usr/bin/env bash
# Bucle del robot de Umbral (modo simulado): una pasada a los 6, 21, 36 y 51 minutos de cada hora durante unas 5 h 40 min; al acabar lanza
# la tarea siguiente (las tareas programadas de GitHub no se disparan con fiabilidad; la programada es solo una red por si la cadena se corta).
# Variables: ROBOT_MIN (minutos de bucle, 340 por defecto), ROBOT_NO_RELANZA (no lanzar la siguiente), GH_TOKEN (para lanzarla).
set -u
DUR=${ROBOT_MIN:-340}; FIN=$(( $(date +%s) + DUR * 60 ))
relanza() {
  [ -n "${ROBOT_NO_RELANZA:-}" ] && return
  [ -z "${GH_TOKEN:-}" ] && { echo "sin GH_TOKEN: no se lanza la siguiente tarea"; return; }
  for i in 1 2 3; do gh workflow run robot.yml --ref main && { echo "siguiente tarea lanzada"; return; }; sleep 15; done
}
trap relanza EXIT
pasada() {
  git pull -q --rebase origin robot || true
  timeout 240 node robot/robot.js || echo "pasada: fallo"
  git add robot/estado.json robot/eventos 2>/dev/null
  if git diff --cached --quiet; then echo "pasada: sin cambios"; return; fi
  git commit -q -m "robot $(date -u +%Y-%m-%dT%H:%MZ)" || return
  for i in 1 2 3; do git pull -q --rebase origin robot && git push -q origin HEAD:robot && { echo "pasada: guardada"; return; }; sleep 5; done
  echo "pasada: no se pudo guardar"
}
echo "robot: empieza $(date -u +%H:%M) UTC, termina hacia $(date -u -d @$FIN +%H:%M) UTC"
while :; do
  pasada
  ahora=$(date +%s); prox=$(( ahora / 900 * 900 + 360 )); [ "$prox" -le "$ahora" ] && prox=$(( prox + 900 ))
  [ "$prox" -ge "$FIN" ] && break
  sleep $(( prox - ahora ))
done
echo "robot: fin $(date -u +%H:%M) UTC"
