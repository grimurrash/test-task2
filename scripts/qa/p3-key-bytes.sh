#!/bin/bash
# N1. Контракт: Idempotency-Key — «непустая строка от 1 до 255 символов,
# формат не навязывается». Реализация меряет .length у строки, декодированной
# из заголовка как latin1, то есть считает БАЙТЫ.
# curl отправляет байты заголовка как есть — атака доезжает до сервера,
# в отличие от fetch/undici, который не-ASCII заголовок не отдаёт вовсе.
BASE=${BASE:-http://localhost:8123}
M="krbytes-$RANDOM"
BODY='{"amount_minor":125000,"currency":"RUB","order_id":"kr-bytes"}'

run() { # $1 — имя, $2 — ключ
  local out code
  out=$(curl -s -w '\n%{http_code}' -X POST "$BASE/v1/payments" \
        -H 'Content-Type: application/json' -H "X-Merchant-Id: $M" \
        -H "Idempotency-Key: $2" -d "$BODY")
  code=$(printf '%s' "$out" | tail -1)
  body=$(printf '%s' "$out" | sed '$d')
  printf '%-46s символов=%-4s байт=%-4s -> %s %s\n' "$1" \
    "$(printf '%s' "$2" | wc -m | tr -d ' ')" \
    "$(printf '%s' "$2" | wc -c | tr -d ' ')" \
    "$code" "$(printf '%s' "$body" | head -c 120)"
}

CYR100=$(printf 'к%.0s' $(seq 1 100))
CYR128=$(printf 'к%.0s' $(seq 1 128))
CYR255=$(printf 'к%.0s' $(seq 1 255))
ASCII255=$(printf 'a%.0s' $(seq 1 255))
EMOJI64=$(printf '😀%.0s' $(seq 1 64))

echo "мерчант: $M"
run 'ASCII 255 символов (граница контракта)' "$ASCII255"
run 'кириллица 100 символов (200 байт)' "$CYR100"
run 'кириллица 128 символов (256 байт)' "$CYR128"
run 'кириллица 255 символов (510 байт)' "$CYR255"
run 'эмодзи 64 символа (256 байт)' "$EMOJI64"

echo
echo '--- доехало ли: повтор кириллического ключа обязан дать 200 и тот же id ---'
run 'кириллица 100 символов — первый раз' "$CYR100"
run 'кириллица 100 символов — повтор' "$CYR100"

echo
echo '--- сколько платежей у мерчанта ---'
curl -s "$BASE/v1/payments" -H "X-Merchant-Id: $M" | tr ',' '\n' | grep -c '"id"'
