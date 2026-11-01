#!/usr/bin/env bash
# Comprobación de una dirección para el chequeo horario (.github/workflows/healthcheck.yml).
# Uso: check.sh "Nombre" URL "texto que debe aparecer" [segundos máximos, por defecto 20]
# - Reintenta 2 veces si falla la conexión.
# - Falla si la respuesta no contiene el texto o si tarda más de lo permitido.
# - Escribe el tiempo en el resumen del workflow (pestaña Summary de la ejecución).
set -uo pipefail
name="$1"; url="$2"; expect="$3"; max="${4:-20}"
body=$(mktemp)
time=$(curl -sS --retry 2 --retry-delay 10 --max-time 60 -o "$body" -w "%{time_total}" "$url") || { echo "❌ $name: no responde ($url)"; exit 1; }
secs=$(printf "%.1f" "$time")
if ! grep -q -- "$expect" "$body"; then
  echo "❌ $name: respuesta inesperada en $secs s"; head -c 400 "$body"; echo
  echo "| ❌ $name | $secs s | respuesta inesperada |" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 1
fi
if awk "BEGIN{exit !($time > $max)}"; then
  echo "❌ $name: responde, pero tarda $secs s (máximo $max s)"
  echo "| ❌ $name | $secs s | más de $max s |" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 1
fi
echo "✅ $name ($secs s)"
echo "| ✅ $name | $secs s | |" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
