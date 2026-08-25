#!/bin/bash
# Дублирующийся Idempotency-Key (#73). curl шлёт два заголовка как есть;
# Node склеивает их в "K, K" — приложение считает это ДРУГИМ ключом.
#
# ВАЖНО ДЛЯ ПРОВЕРКИ ПОЧИНКИ (F7b). Дефект САМОМАСКИРУЕТСЯ: если слать дубль
# и повторять дублем же, ключ совпадает сам с собой и поведение выглядит
# правильным. Ломается только там, где рядом оказывается вариант без дубля —
# клиент через прокси и он же напрямую, ретрай из другой среды, повтор после
# переключения сети. Поэтому сценариев три, и зелёный только на первом
# не означает ничего.
#
# После починки по F7b ожидание меняется: запрос с дублем обязан получить
# 400 ещё до создания платежа — то есть в А первый ответ станет 400, а в Б и В
# платёж будет ровно один.
B=${BASE:-http://localhost:8123}
BODY='{"amount_minor":125000,"currency":"RUB","order_id":"o-dup"}'

post() { # $1 — мерчант, дальше заголовки
  local m="$1"; shift
  curl -s -o /dev/null -w '%{http_code}' -X POST "$B/v1/payments" \
       -H 'Content-Type: application/json' -H "X-Merchant-Id: $m" "$@" -d "$BODY"
}
cnt() { curl -s "$B/v1/payments" -H "X-Merchant-Id: $1" | tr '}' '\n' | grep -c '"id"'; }

echo 'А. дубль -> дубль (самомаскировка: дефект НЕ виден)'
M="dup-a-$RANDOM"; K="key-$RANDOM"
echo "   первый:  $(post "$M" -H "Idempotency-Key: $K" -H "Idempotency-Key: $K")"
echo "   повтор:  $(post "$M" -H "Idempotency-Key: $K" -H "Idempotency-Key: $K")"
echo "   платежей: $(cnt "$M")   [до починки: 1 — выглядит правильно | после F7b: 0, оба 400]"

echo 'Б. дубль -> одиночный (дефект виден)'
M="dup-b-$RANDOM"; K="key-$RANDOM"
echo "   первый:  $(post "$M" -H "Idempotency-Key: $K" -H "Idempotency-Key: $K")"
echo "   повтор:  $(post "$M" -H "Idempotency-Key: $K")"
echo "   платежей: $(cnt "$M")   [до починки: 2 — ДВА платежа на один ключ | после F7b: 1]"

echo 'В. одиночный -> дубль (обратный порядок, тот же отказ)'
M="dup-c-$RANDOM"; K="key-$RANDOM"
echo "   первый:  $(post "$M" -H "Idempotency-Key: $K")"
echo "   повтор:  $(post "$M" -H "Idempotency-Key: $K" -H "Idempotency-Key: $K")"
echo "   платежей: $(cnt "$M")   [до починки: 2 | после F7b: 1, повтор отклонён 400]"

echo
echo 'Контроль: без дубля тот же ключ дважды — один платёж (должен быть зелёным всегда)'
M="dup-ctl-$RANDOM"; K="key-$RANDOM"
echo "   первый:  $(post "$M" -H "Idempotency-Key: $K")"
echo "   повтор:  $(post "$M" -H "Idempotency-Key: $K")"
echo "   платежей: $(cnt "$M")   [ожидание 1 в любом случае]"
