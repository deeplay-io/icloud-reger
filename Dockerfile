# Сервис кодов (gRPC MailCodeService) для Kubernetes: без окна, без браузера и без базы.
# IMAP-пароли и алиасы родителей присылает приложение на Windows (cluster.url в его config.json).
# Нативные модули не собираются (--ignore-scripts): better-sqlite3 и Electron сервису в кластере не нужны.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    MAIL_CODE_CONFIG=/config/mail-code.json
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY proto ./proto
USER node
# 50051 — gRPC для пилота (внутри кластера), 8080 — приём снимка от приложения (через ingress).
EXPOSE 50051 8080
CMD ["node", "dist/mailCodeMain.js"]
