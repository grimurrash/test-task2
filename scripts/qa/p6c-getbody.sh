#!/bin/bash
# N19, уточнение: доживает ли ТЕЛО ответа до клиента, когда сервер рвёт
# недочитанный запрос. Файлы — внутри репозитория: guard-scope считает
# /dev/zero и /dev/null записью наружу (четвёртый ложный отказ, см. #43).
B=${BASE:-http://localhost:8123}
M="krget-$RANDOM"
node -e 'process.stdout.write("x".repeat(1048576))' > big.bin
curl -s -X POST "$B/v1/payments" -H 'Content-Type: application/json' -H "X-Merchant-Id: $M" \
     -H "Idempotency-Key: $M-1" -d '{"amount_minor":125000,"currency":"RUB","order_id":"getbody"}' > created.json
echo "создан: $(head -c 60 created.json)"

echo '--- GET списка БЕЗ тела (эталон) ---'
curl -s -o plain.txt -w 'http=%{http_code} принято_байт=%{size_download}\n' -X GET "$B/v1/payments" -H "X-Merchant-Id: $M"
echo "rc=$? тело: $(wc -c < plain.txt) байт"

echo '--- GET списка С телом 1 МБ ---'
curl -s -o withbody.txt -w 'http=%{http_code} принято_байт=%{size_download}\n' -X GET "$B/v1/payments" \
     -H "X-Merchant-Id: $M" --data-binary @big.bin
echo "rc=$? тело: $(wc -c < withbody.txt) байт: $(head -c 100 withbody.txt)"

rm -f big.bin created.json plain.txt withbody.txt
