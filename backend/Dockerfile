# syntax=docker/dockerfile:1
#
# Две цели сборки, потому что R3 и R4 в один образ не помещаются: R3 требует,
# чтобы в рантайме не было ни исходников тестов, ни devDependencies, а R4 —
# чтобы `npm test` работал в контейнере. Образ без тестов тесты не запустит,
# как ни формулируй.
#
#   docker build backend/                                   → цель runtime (по умолчанию)
#   docker build -f backend/Dockerfile --target test backend/ → образ для прогона тестов
#
# Контракт (`openapi/openapi.yaml`) в образ не кладётся: он общий артефакт
# репозитория, а не часть бэкенда. Цель `test` ждёт его монтированием
# по пути OPENAPI_PATH — см. backend/README.md.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Цель для R4: девзависимости и исходники тестов на месте.
FROM deps AS test
WORKDIR /app
COPY tsconfig.json tsconfig.build.json eslint.config.js ./
COPY src ./src
COPY test ./test
ENV OPENAPI_PATH=/app/openapi/openapi.yaml
CMD ["npm", "test"]

# Цель по умолчанию. Рантайм-зависимостей у сервиса нет ни одной, поэтому
# node_modules сюда не копируется вовсе: R3 выполняется не аккуратностью
# сборки, а тем, что здесь нечего оставить.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY package.json ./
COPY --from=build /app/dist/src ./dist/src
USER node
EXPOSE 8080

# Проверка живости идёт по маршруту самого контракта — отдельного эндпоинта
# ради неё не заводим, объём заморожен.
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/v1/payments',{headers:{'X-Merchant-Id':'healthcheck'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
