FROM node:22-alpine

WORKDIR /app

COPY package.json ./
# No npm install needed — zero dependencies

COPY server.js fleet-dashboard.html ./

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8090/health || exit 1

USER node

CMD ["node", "server.js"]
