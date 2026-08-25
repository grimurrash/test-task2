# R3: многоступенчатая сборка — build → раздача статики на 8081.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Адрес API вшивается на сборке; пусто — дефолт http://localhost:8080 из кода.
ARG VITE_API_BASE=
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8081
