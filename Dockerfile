FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Database (dispatcher.db) and camera photos live here; docker-compose mounts it so they survive rebuilds.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8090/health || exit 1

USER node

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
