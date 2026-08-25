#!/bin/bash
# Перепроверка чужой находки D1 на СВОЁМ экземпляре (:8123, коммит 004a6cf):
# дублирующийся Idempotency-Key. curl шлёт два одинаковых заголовка как есть;
# Node склеивает их в "K, K" — приложение считает это ДРУГИМ ключом.
B=${BASE:-http://localhost:8123}
M="dup-$RANDOM"; K="key-$RANDOM"
BODY='{"amount_minor":125000,"currency":"RUB","order_id":"o-dup"}'
post() { curl -s -w ' <- %{http_code}' -X POST "$B/v1/payments" -H 'Content-Type: application/json' \
         -H "X-Merchant-Id: $M" "$@" -d "$BODY"; echo; }

echo "мерчант=$M ключ=$K"
echo '1) один POST с ДВУМЯ одинаковыми Idempotency-Key:'
post -H "Idempotency-Key: $K" -H "Idempotency-Key: $K"
echo '2) честный повтор ОДНИМ заголовком, тот же ключ и тело:'
post -H "Idempotency-Key: $K"
echo "3) платежей у мерчанта (ожидание по контракту: 1):"
curl -s "$B/v1/payments" -H "X-Merchant-Id: $M" | tr '}' '\n' | grep -c '"id"'

echo
echo '--- контроль: без дубля тот же ключ дважды даёт ОДИН платёж ---'
M2="dup2-$RANDOM"; K2="key-$RANDOM"
curl -s -o /dev/null -X POST "$B/v1/payments" -H 'Content-Type: application/json' -H "X-Merchant-Id: $M2" -H "Idempotency-Key: $K2" -d "$BODY"
curl -s -o /dev/null -X POST "$B/v1/payments" -H 'Content-Type: application/json' -H "X-Merchant-Id: $M2" -H "Idempotency-Key: $K2" -d "$BODY"
echo "платежей: $(curl -s "$B/v1/payments" -H "X-Merchant-Id: $M2" | tr '}' '\n' | grep -c '"id"') (ожидание 1)"
