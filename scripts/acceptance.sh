#!/bin/bash
# Приёмочный сценарий A1 и A2 против поднятого API.
#
# Проверяет не «сервер отвечает», а заявленное поведение: два одинаковых запроса
# дают один и тот же id, конфликт ключа даёт 409 и не меняет платёж, отмена
# идемпотентна, отмена завершённого платежа отклоняется.
#
#   bash scripts/acceptance.sh                       # http://localhost:8080
#   BASE_URL=http://127.0.0.1:9000 bash scripts/acceptance.sh
#
# Зависимости: bash и curl. Ни Node, ни jq не требуется.
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
MERCHANT="${MERCHANT:-demo-shop}"
FAILED=0
STEP=0

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
pass() { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILED=$((FAILED + 1)); }

check() { # check "что проверяем" ожидаемое фактическое
  if [ "$2" = "$3" ]; then
    pass "$1 — $3"
  else
    fail "$1: ожидалось «$2», получено «$3»"
  fi
}

# Тело ответа и код статуса одним вызовом: статус дописывается последней строкой.
call() { # call МЕТОД ПУТЬ [ТЕЛО] [КЛЮЧ]
  local method="$1" path="$2" body="${3:-}" key="${4:-}"
  local args=(-sS -X "$method" -H "X-Merchant-Id: $MERCHANT" -w '\n%{http_code}')
  [ -n "$key" ] && args+=(-H "Idempotency-Key: $key")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$BASE_URL$path" 2>/dev/null
}

status_of() { printf '%s' "$1" | tail -n 1; }
body_of()   { printf '%s' "$1" | sed '$d'; }
field()     { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

KEY="acceptance-$(date +%s)-$$"
BODY='{"amount_minor":125000,"currency":"RUB","order_id":"acceptance-order","description":"Приёмочный сценарий"}'
OTHER_BODY='{"amount_minor":777,"currency":"USD","order_id":"acceptance-order"}'

say "Приёмка: $BASE_URL, мерчант $MERCHANT"

if ! curl -sS -o /dev/null -H "X-Merchant-Id: $MERCHANT" "$BASE_URL/v1/payments" 2>/dev/null; then
  printf '\n\033[1mAPI недоступен на %s.\033[0m Поднимите его: docker compose up\n' "$BASE_URL"
  exit 1
fi

STEP=$((STEP + 1)); say "$STEP. Создание платежа"
RES=$(call POST /v1/payments "$BODY" "$KEY")
CREATE_STATUS=$(status_of "$RES")
FIRST_ID=$(field "$(body_of "$RES")" id)
check "код ответа" 201 "$CREATE_STATUS"
if [ -n "$FIRST_ID" ]; then pass "id платежа — $FIRST_ID"; else fail "id платежа не найден в ответе"; fi

STEP=$((STEP + 1)); say "$STEP. A1 · повтор тем же ключом и тем же телом"
RES=$(call POST /v1/payments "$BODY" "$KEY")
REPEAT_STATUS=$(status_of "$RES")
SECOND_ID=$(field "$(body_of "$RES")" id)
check "код ответа — повтор, а не создание" 200 "$REPEAT_STATUS"
check "тот же id" "$FIRST_ID" "$SECOND_ID"

STEP=$((STEP + 1)); say "$STEP. A1 · список не вырос от повтора"
RES=$(call GET /v1/payments)
COUNT=$(printf '%s' "$(body_of "$RES")" | grep -o "\"id\":\"$FIRST_ID\"" | wc -l | tr -d ' ')
check "платёж встречается в списке ровно один раз" 1 "$COUNT"

STEP=$((STEP + 1)); say "$STEP. A2 · тот же ключ с другим телом"
RES=$(call POST /v1/payments "$OTHER_BODY" "$KEY")
check "код ответа" 409 "$(status_of "$RES")"
check "код ошибки" idempotency_key_reuse "$(field "$(body_of "$RES")" code)"

STEP=$((STEP + 1)); say "$STEP. A2 · платёж не изменился"
RES=$(call GET "/v1/payments/$FIRST_ID")
check "код ответа" 200 "$(status_of "$RES")"
check "валюта прежняя" RUB "$(field "$(body_of "$RES")" currency)"
check "статус прежний" pending "$(field "$(body_of "$RES")" status)"

STEP=$((STEP + 1)); say "$STEP. Отмена"
RES=$(call POST "/v1/payments/$FIRST_ID/cancel")
check "код ответа" 200 "$(status_of "$RES")"
check "статус" canceled "$(field "$(body_of "$RES")" status)"

STEP=$((STEP + 1)); say "$STEP. Повторная отмена идемпотентна"
RES=$(call POST "/v1/payments/$FIRST_ID/cancel")
check "код ответа" 200 "$(status_of "$RES")"
check "статус" canceled "$(field "$(body_of "$RES")" status)"

STEP=$((STEP + 1)); say "$STEP. Отмена завершённого платежа (сумма-триггер …02)"
DONE_KEY="acceptance-done-$(date +%s)-$$"
RES=$(call POST /v1/payments '{"amount_minor":10002,"currency":"RUB","order_id":"acceptance-done"}' "$DONE_KEY")
DONE_ID=$(field "$(body_of "$RES")" id)
check "платёж сразу succeeded" succeeded "$(field "$(body_of "$RES")" status)"
RES=$(call POST "/v1/payments/$DONE_ID/cancel")
check "код ответа" 409 "$(status_of "$RES")"
check "код ошибки" payment_not_cancelable "$(field "$(body_of "$RES")" code)"

STEP=$((STEP + 1)); say "$STEP. Обязательные заголовки"
RES=$(curl -sS -X POST -H 'Content-Type: application/json' -H "Idempotency-Key: no-merchant-$$" \
  -d "$BODY" -w '\n%{http_code}' "$BASE_URL/v1/payments" 2>/dev/null)
check "без X-Merchant-Id — код ответа" 400 "$(status_of "$RES")"
check "без X-Merchant-Id — код ошибки" merchant_id_required "$(field "$(body_of "$RES")" code)"

RES=$(call POST /v1/payments "$BODY")
check "без Idempotency-Key — код ответа" 400 "$(status_of "$RES")"
check "без Idempotency-Key — код ошибки" idempotency_key_required "$(field "$(body_of "$RES")" code)"

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf '\033[1mПриёмка пройдена: расхождений с заявленным поведением нет.\033[0m\n'
  exit 0
fi
printf '\033[1mПриёмка не пройдена: расхождений — %s.\033[0m\n' "$FAILED"
exit 1
