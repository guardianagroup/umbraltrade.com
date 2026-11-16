#!/usr/bin/env bash
# Motor de Umbral. Un bucle de unas 5 h 40 min dentro de una tarea de GitHub que, al acabar, lanza la siguiente: las tareas programadas de GitHub no
# se disparan con fiabilidad, y el modelo de 15 minutos tiene que decidir en los segundos siguientes al cierre de cada vela.
#   · cada 5 minutos, a los 4 s del cierre de la vela: el Reto (tools/reto.js): decide en los cuartos de hora y resuelve lo que vence;
#   · cada 15 minutos: la cuenta del algoritmo (tools/cuenta.js);
#   · cada hora: el calendario económico (tools/calendar.js → data/calendar.json, en main).
# Los estados se guardan en la rama «cuenta» (reto.json y cuenta.json); cada cambio queda en su historial con la hora.
# Variables: MOTOR_MIN (minutos de bucle, 340 por defecto), MOTOR_NO_RELANZA (no lanzar la siguiente tarea), GH_TOKEN (para lanzarla).
set -u
DUR=${MOTOR_MIN:-340}; FIN=$(( $(date +%s) + DUR * 60 ))
relanza() {
  [ -n "${MOTOR_NO_RELANZA:-}" ] && return
  [ -z "${GH_TOKEN:-}" ] && { echo "sin GH_TOKEN: no se lanza la siguiente tarea"; return; }
  for i in 1 2 3; do gh workflow run motor.yml --ref main && { echo "siguiente tarea lanzada"; return; }; sleep 15; done
}
trap relanza EXIT
guarda() {
  ( cd datos || exit 0
    git add -A; git diff --cached --quiet && exit 0
    git commit -q -m "$1 $(date -u +%Y-%m-%dT%H:%MZ)"
    for i in 1 2 3; do git push -q origin HEAD:cuenta && exit 0; git pull -q --rebase origin cuenta || true; sleep 3; done; exit 1 ) || echo "no se pudo guardar el estado"
}
calendario() {
  timeout 90 node tools/calendar.js data/calendar.json || { echo "calendario: fallo"; return; }
  if git diff --quiet -- data/calendar.json; then return; fi
  git add data/calendar.json && git commit -q -m "Calendario económico al día" || return
  for i in 1 2 3; do git pull -q --rebase origin main && git push -q origin HEAD:main && return; sleep 5; done; echo "calendario: no se pudo guardar"
}
cuenta=0; cal=0
echo "motor: empieza $(date -u +%H:%M) UTC, termina hacia $(date -u -d @$FIN +%H:%M) UTC"
while :; do
  ahora=$(date +%s); prox=$(( (ahora / 300 + 1) * 300 + 4 ))
  [ "$prox" -ge "$FIN" ] && break
  sleep $(( prox - ahora ))
  min=$(( (prox / 60) % 60 ))
  timeout 240 node tools/reto.js datos/reto.json || echo "reto: fallo"
  if [ $(( min % 15 )) -eq 5 ] || [ $(( prox - cuenta )) -ge 1200 ]; then timeout 200 node tools/cuenta.js datos/cuenta.json || echo "cuenta: fallo"; cuenta=$prox; fi
  guarda "Motor"
  if [ "$min" -ge 15 ] && [ $(( prox - cal )) -ge 3300 ]; then calendario; cal=$prox; fi
done
echo "motor: fin $(date -u +%H:%M) UTC"
