# Страница документации: сборка отдельно, раздача отдельно (R3).
#
# Контекст сборки — корень репозитория, а не docs-site/: страница собирается
# из openapi/openapi.yaml, и он обязан быть виден Docker. Копия контракта
# внутри docs-site/ разошлась бы с оригиналом на первой же правке.
#
#   docker build -f docs-site/Dockerfile -t psp-docs .
#   docker run --rm -p 8082:8082 psp-docs

FROM node:22-alpine AS build
WORKDIR /app

# Зависимости ставятся до копирования исходников: правка страницы не тянет
# за собой переустановку пакетов.
COPY docs-site/package.json docs-site/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY docs-site/build.mjs ./
COPY docs-site/src ./src
COPY openapi/openapi.yaml /contract/openapi.yaml

# Токены дизайна (#10) лежат вне этой папки и появятся в репозитории только
# после слияния макета. Отдельный COPY на них падал бы до тех пор, поэтому
# берём контекст целиком — .dockerignore рядом с этим файлом сужает его до
# docs-site/, openapi/openapi.yaml и design/tokens.css.
COPY . /ctx

ENV SPEC=/contract/openapi.yaml
ENV TOKENS=/ctx/design/tokens.css
RUN npm run build

# В рантайме — только nginx и статика: ни node_modules, ни исходников сборки.
FROM nginx:1.29-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY docs-site/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://localhost:8082/ || exit 1
