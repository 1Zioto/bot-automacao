FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app /app
USER node
CMD ["node", "apps/api/dist/server.js"]

FROM runtime AS runtime-api
CMD ["node", "apps/api/dist/server.js"]

FROM runtime AS runtime-queue
CMD ["node", "apps/queue-worker/dist/index.js"]

FROM nginx:1.27-alpine AS runtime-web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

FROM node:20-bookworm-slim AS runtime-whatsapp
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
COPY --from=builder /app /app
RUN mkdir -p /app/.data/whatsapp-sessions && chown -R node:node /app/.data
USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/whatsapp-worker/dist/index.js"]
