#!/usr/bin/env bash
# Залити код у Google Apps Script.
#   ./deploy.sh            - перший раз створює проєкт (.clasp.json), далі лише оновлює код
# Ключ Gemini береться з .env (за замовчуванням ../records/.env, інший - ENV_FILE=...) у src/secret.gs,
# який є в .gitignore і йде лише в твій приватний проєкт Apps Script. Ключ не виводиться.
set -euo pipefail
cd "$(dirname "$0")"

CLASP=(npx --yes @google/clasp@3)
ENV_FILE="${ENV_FILE:-../records/.env}"

key=$(grep -E '^GEMINI_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')
if [ -z "$key" ]; then echo "Немає GEMINI_API_KEY у $ENV_FILE" >&2; exit 1; fi
umask 077
printf '// Згенеровано deploy.sh з .env - не комітити (є в .gitignore)\nvar GEMINI_API_KEY_FROM_ENV = "%s";\n' "$key" > src/secret.gs

if [ ! -f .clasp.json ]; then
  cp src/appsscript.json /tmp/svitlo-appsscript.json # clasp create може перезаписати маніфест
  "${CLASP[@]}" create-script --type standalone --title "Svitlo calendar" --rootDir src
  cp /tmp/svitlo-appsscript.json src/appsscript.json
fi

"${CLASP[@]}" push --force
echo
echo "Код залито. Відкрити редактор: ${CLASP[*]} open-script"
