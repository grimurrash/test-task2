#!/bin/bash
# N19. Контракт: у отмены тела нет. Но обработчик отвечает, НЕ читая тело,
# а по res.on('finish') рвёт недочитанный запрос. Тот же класс, что находка
# ревью #47 на теле сверх предела: клиент, который ещё грузит, получает обрыв
# вместо ответа API. Проверяю, доходит ли ответ до клиента.
BASE=${BASE:-http://localhost:8123}
M="krbody-$RANDOM"
mk() { curl -s -X POST "$BASE/v1/payments" -H 'Content-Type: application/json' \
       -H "X-Merchant-Id: $M" -H "Idempotency-Key: $M-$1" \
       -d '{"amount_minor":125000,"currency":"RUB","order_id":"cancel-body"}' \
     | sed 's/.*"id":"\([^"]*\)".*/\1/'; }

for size in 1024 65536 1048576 4194304; do
  ID=$(mk "$size")
  head -c "$size" /dev/zero | tr '\0' 'x' > /tmp/krbody.bin
  out=$(curl -s -o /tmp/krout.txt -w '%{http_code}' -X POST "$BASE/v1/payments/$ID/cancel" \
        -H "X-Merchant-Id: $M" -H 'Content-Type: application/json' \
        --data-binary @/tmp/krbody.bin 2>/tmp/krerr.txt)
  rc=$?
  printf 'отмена с телом %-9s байт -> curl rc=%-3s http=%-4s %s\n' "$size" "$rc" "$out" \
    "$(head -c 90 /tmp/krout.txt)$(head -c 60 /tmp/krerr.txt)"
  st=$(curl -s "$BASE/v1/payments/$ID" -H "X-Merchant-Id: $M" | sed 's/.*"status":"\([^"]*\)".*/\1/')
  printf '   состояние платежа после этого: %s\n' "$st"
done

echo
echo '--- то же на GET списка (тело на GET тоже не читается) ---'
head -c 1048576 /dev/zero | tr '\0' 'x' > /tmp/krbody.bin
out=$(curl -s -o /tmp/krout.txt -w '%{http_code}' -X GET "$BASE/v1/payments" \
      -H "X-Merchant-Id: $M" --data-binary @/tmp/krbody.bin 2>/tmp/krerr.txt); rc=$?
printf 'GET с телом 1 МБ -> curl rc=%s http=%s %s\n' "$rc" "$out" "$(head -c 60 /tmp/krerr.txt)"

echo
echo '--- для сравнения: создание с телом сверх предела (находка #47, обязано быть 400) ---'
head -c 2097152 /dev/zero | tr '\0' 'x' > /tmp/krbig.bin
{ printf '{"amount_minor":125000,"currency":"RUB","order_id":"big","description":"'; cat /tmp/krbig.bin; printf '"}'; } > /tmp/krbigbody.json
out=$(curl -s -o /tmp/krout.txt -w '%{http_code}' -X POST "$BASE/v1/payments" \
      -H 'Content-Type: application/json' -H "X-Merchant-Id: $M" -H "Idempotency-Key: $M-big" \
      --data-binary @/tmp/krbigbody.json 2>/tmp/krerr.txt); rc=$?
printf 'создание с телом 2 МБ -> curl rc=%s http=%s %s\n' "$rc" "$out" "$(head -c 120 /tmp/krout.txt)"
rm -f /tmp/krbody.bin /tmp/krbig.bin /tmp/krbigbody.json /tmp/krout.txt /tmp/krerr.txt
