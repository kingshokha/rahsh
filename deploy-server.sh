#!/usr/bin/env bash
# Загрузка серверной части магазина (папка apps-script) в Google Apps Script
# и обновление того же развёртывания — ссылка …/exec не меняется.
# Запуск в Termux:  bash deploy-server.sh
set -u
cd "$(dirname "$0")/apps-script" || exit 1
DEPLOYMENT_ID=AKfycby3DY8MoP-cRlFgVyLmYZOMZREdxkhtOq3yQ_FJ9v04JnYzcRR0XMN830RsXxZMGJGU

say()  { printf '\n\033[1;32m> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mОШИБКА: %s\033[0m\n' "$1"; exit 1; }

command -v node >/dev/null 2>&1 || fail "Нет Node.js. Выполните: pkg install -y nodejs"
if ! command -v clasp >/dev/null 2>&1; then
  say "Устанавливаю clasp (1-2 минуты)..."
  npm install -g @google/clasp >/dev/null 2>&1 || fail "Не удалось установить clasp. Проверьте интернет и запустите снова."
fi
if [ ! -f "$HOME/.clasprc.json" ]; then
  say "Вход в Google: долгое нажатие на ссылку -> «Open URL», войдите и разрешите доступ"
  clasp login || fail "Вход не удался. Выполните: clasp login --no-localhost  — и снова этот скрипт."
fi

say "Загружаю код в Apps Script..."
OUT=$(clasp push -f 2>&1); echo "$OUT"
if echo "$OUT" | grep -qi "Apps Script API"; then
  fail "Включите «Google Apps Script API» на script.google.com/home/usersettings и запустите снова."
fi
echo "$OUT" | grep -qiE "error|failed|denied|not found|permission" && fail "Код не загрузился (сообщение выше)."

say "Обновляю развёртывание..."
DOUT=$(clasp deploy -i "$DEPLOYMENT_ID" -d "Сервер для сайта на GitHub" 2>&1); RC=$?; echo "$DOUT"
if [ $RC -ne 0 ] || echo "$DOUT" | grep -qiE "error|failed|denied|not found"; then
  fail "Не удалось обновить развёртывание (сообщение выше)."
fi

say "Готово!"
echo "Магазин:          https://kingshokha.github.io/rahsh/"
echo "Панель продавца:  https://kingshokha.github.io/rahsh/?admin=1"
exit 0
