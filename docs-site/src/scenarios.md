# Сценарии curl

Пять шагов подряд показывают главное свойство сервиса: **повтор запроса
не создаёт второй платёж**. Команды копируются как есть и работают против
API на `http://localhost:8080` — поднимите его перед прогоном
(`docker compose up`).

Справочник по каждому эндпоинту, все коды ошибок, раздел «Идемпотентность»
и таблица тестовых сумм — на [странице справочника](./index.html); эта
страница показывает их в связке.

## Подготовка

Адрес, мерчант и ключ идемпотентности задаются один раз — дальше все команды
ссылаются на переменные.

```bash
API=http://localhost:8080
MERCHANT=demo-shop-a
KEY=$(uuidgen)
```

Адрес здесь — тот, на котором API поднят **у вас**: страница собирается вместе
со стендом и подставляет его сама. Мерчант `demo-shop-a` выбран не случайно —
это одно из двух значений переключателя в песочнице, поэтому всё, что вы
создадите здесь руками, видно там на соседней вкладке.

`Idempotency-Key` — непустая строка от 1 до 255 символов, присланная ровно
один раз; формат не навязывается, годится любая письменность, `uuidgen` взят
для удобства. Заголовок `X-Merchant-Id` обязателен на **каждом** запросе,
тоже присылается один раз и, в отличие от ключа, ограничен набором
`A–Z a–z 0–9 . _ -`.

**Что можно копировать вразнобой, а что нельзя.** Этот блок выполняется
первым в любом случае — без него переменные пусты, и ответы придут не те,
что обещаны. Дальше:

- **шаги 1–5 читаются по порядку**: каждый опирается на платёж, созданный
  предыдущим, и на общий `$KEY`. Взятый в одиночку шаг 3 вернёт не 409,
  а 201 — конфликтовать ему будет не с чем;
- **раздел «Отказы» и суммы-триггеры самостоятельны**: каждый блок там
  создаёт всё, что ему нужно, и не зависит от соседей.

## 1. Создание платежа → 201

Первый запрос с этим ключом создаёт платёж и отвечает **201**.

```bash
# ожидается 201
curl -i -X POST "$API/v1/payments" \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" \
  -H "Idempotency-Key: $KEY" \
  -d '{"amount_minor":125000,"currency":"RUB","order_id":"order-2026-0825-0001","description":"Подписка на тариф «Про», август"}'
```

Запомните `id` из ответа — он понадобится дальше:

```bash
PAYMENT_ID=$(curl -s -X POST "$API/v1/payments" \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"amount_minor":125000,"currency":"RUB","order_id":"order-2026-0825-0002"}' \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "$PAYMENT_ID"
```

## 2. Повтор с тем же ключом и тем же телом → 200, тот же платёж

Та же команда, что в шаге 1, дословно. Ответ — **200** и **тот же ресурс**:
совпадают и `id`, и `created_at`. Второй платёж не создан.

```bash
# ожидается 200
curl -i -X POST "$API/v1/payments" \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" \
  -H "Idempotency-Key: $KEY" \
  -d '{"amount_minor":125000,"currency":"RUB","order_id":"order-2026-0825-0001","description":"Подписка на тариф «Про», август"}'
```

Разница 201 против 200 — это и есть сигнал «новый платёж» против «тот же
платёж». Тело ответа в обоих случаях одинаковое.

## 3. Тот же ключ, другое тело → 409 `idempotency_key_reuse`

Ключ уже занят другим запросом. Существующий платёж при этом **не меняется**.

```bash
# ожидается 409
curl -i -X POST "$API/v1/payments" \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" \
  -H "Idempotency-Key: $KEY" \
  -d '{"amount_minor":999,"currency":"USD","order_id":"order-2026-0825-0009"}'
```

«Тем же телом» считается совпадение **по разобранным полям** — порядок ключей
в JSON и форматирование значения не имеют. А запрос с невалидным телом в
историю ключа вообще не попадает: он получит ошибку по телу (400 или 422),
а не 409, и ключ останется свободным для нормальной попытки.

## 4. Статус платежа → 200

```bash
# ожидается 200
curl -i "$API/v1/payments/$PAYMENT_ID" \
  -H "X-Merchant-Id: $MERCHANT"
```

Платёж другого мерчанта по верному `id` неотличим от несуществующего — **404**
`payment_not_found`:

```bash
# ожидается 404
curl -i "$API/v1/payments/$PAYMENT_ID" \
  -H "X-Merchant-Id: other-shop"
```

## 5. Отмена → 200, повторная отмена → 409

Отмена переводит платёж из `pending` в `canceled`.

```bash
# ожидается 200
curl -i -X POST "$API/v1/payments/$PAYMENT_ID/cancel" \
  -H "X-Merchant-Id: $MERCHANT"
```

Платёж в терминальном статусе не отменяется — **409** `payment_not_cancelable`,
текущий статус приходит в `details.status`. Проверяется суммой-триггером:
`amount_minor % 100 == 2` создаёт платёж сразу в `succeeded`.

```bash
DONE_ID=$(curl -s -X POST "$API/v1/payments" \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"amount_minor":150002,"currency":"RUB","order_id":"order-2026-0825-0003"}' \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

# ожидается 409
curl -i -X POST "$API/v1/payments/$DONE_ID/cancel" \
  -H "X-Merchant-Id: $MERCHANT"
```

## Список платежей — от повторов не растёт

```bash
# ожидается 200
curl -i "$API/v1/payments" \
  -H "X-Merchant-Id: $MERCHANT"
```

Платежи приходят новыми сверху, в поле `payments`. Повтор из шага 2 нового
элемента в списке не добавил.

## Отказы, которые стоит увидеть заранее

Проблема формы запроса — **400**, проблема полей тела — **422**. Это разные
слои, и коды у них разные. Порядок проверок фиксирован, ответ приходит от
первого непройденного слоя:

маршрут → `X-Merchant-Id` → `Idempotency-Key` → разбор тела → валидация полей.

Поэтому запрос, у которого сломано сразу всё, ответит про маршрут или заголовок,
а не про поля: чинить их придётся по очереди, а не разом. Обращение к пути,
которого нет, отвечает **404** `not_found` — это про адрес, а не про платёж;
несуществующий или чужой платёж на описанном пути даёт **404**
`payment_not_found`. Метод, не описанный для существующего пути, — **405**
`method_not_allowed`.

```bash
# ожидается 404
curl -i "$API/v1/nope" -H "X-Merchant-Id: $MERCHANT"
# ожидается 405
curl -i -X DELETE "$API/v1/payments" -H "X-Merchant-Id: $MERCHANT"
```

Без `X-Merchant-Id` → **400** `merchant_id_required`:

```bash
# ожидается 400
curl -i "$API/v1/payments"
```

`X-Merchant-Id`, присланный дважды, → **400** `invalid_merchant_id`: правило
однократности одинаково для обоих заголовков.

```bash
# ожидается 400
curl -i "$API/v1/payments" \
  -H "X-Merchant-Id: $MERCHANT" \
  -H "X-Merchant-Id: demo-shop-b"
```

Без `Idempotency-Key` (или с пустым значением) → **400**
`idempotency_key_required`:

```bash
# ожидается 400
curl -i -X POST "$API/v1/payments" \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" \
  -d '{"amount_minor":125000,"currency":"RUB","order_id":"order-2026-0825-0004"}'
```

Ключ не прошёл проверку → **400** `invalid_idempotency_key`. Причин ровно две:
длиннее 255 символов или заголовок прислан больше одного раза.

Набор символов **не ограничен**: годится любая письменность, длина считается
в символах, а не в байтах. Такой ключ законен, и запрос ниже отвечает **201**,
а не 400 — он здесь для того, чтобы очертить границу отказа:

```bash
# ключ экзотический, но каждый раз новый: повтор прежнего вернул бы 200
# и тот же платёж — это идемпотентность, а не отказ по набору символов
# ожидается 201
curl -i -X POST "$API/v1/payments" \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" \
  -H "Idempotency-Key: заказ-№1/$(uuidgen)" \
  -d '{"amount_minor":125000,"currency":"RUB","order_id":"order-2026-0825-0006"}'
```

Слишком длинный:

```bash
# ожидается 400
curl -i -X POST "$API/v1/payments" \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" \
  -H "Idempotency-Key: $(printf 'k%.0s' $(seq 256))" \
  -d '{"amount_minor":125000,"currency":"RUB","order_id":"order-2026-0825-0005"}'
```

Заголовок прислан дважды — отказ приходит, когда сервис видит два заголовка
в сыром списке, до того как инфраструктура склеит их в одно значение через
запятую:

```bash
# ожидается 400
curl -i -X POST "$API/v1/payments" \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" \
  -H "Idempotency-Key: $KEY" \
  -H "Idempotency-Key: $KEY" \
  -d '{"amount_minor":125000,"currency":"RUB","order_id":"order-2026-0825-0007"}'
```

Строгость здесь не придирка: ключ — идентификатор намерения, и два разных
значения означали бы, что клиент сам не знает, какой запрос повторяет.
Выбрать за него одно — рискнуть вторым списанием.

Тело не разобрано как JSON-объект → **400** `malformed_request`. Сюда же
попадают пустое тело, массив вместо объекта и запрос без
`Content-Type: application/json`:

```bash
# ожидается 400
curl -i -X POST "$API/v1/payments" \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"amount_minor":'
```

Поля тела не прошли проверку → **422** `validation_failed`, и в
`details.errors` приходят **все** нарушения разом, а не первое попавшееся:

```bash
# ожидается 422
curl -i -X POST "$API/v1/payments" \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"amount_minor":0,"currency":"rub","order_id":""}'
```

## Суммы-триггеры

Терминальный статус задаётся сразу при создании, по остатку от деления суммы
на 100. Полная таблица — в разделе «Тестовые суммы»
[справочника](./index.html); здесь — то же правило в командах.

```bash
# 1250.01 → failed, status_reason = test_amount_rule
curl -s -X POST "$API/v1/payments" -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"amount_minor":125001,"currency":"RUB","order_id":"trigger-failed"}'

# 1250.02 → succeeded, status_reason = test_amount_rule
curl -s -X POST "$API/v1/payments" -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"amount_minor":125002,"currency":"RUB","order_id":"trigger-succeeded"}'

# 1 минорная единица → тоже failed: правило считает 1 % 100 == 1
curl -s -X POST "$API/v1/payments" -H "Content-Type: application/json" \
  -H "X-Merchant-Id: $MERCHANT" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"amount_minor":1,"currency":"RUB","order_id":"trigger-one"}'
```

Суммы `1` и `2` минорных единицы — **не поломка песочницы**, а то же самое
правило: `1 % 100 == 1` даёт `failed`, `2 % 100 == 2` даёт `succeeded`.
