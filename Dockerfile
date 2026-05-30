# Standalone container image for web-fps — an alternative to the Pterodactyl egg.
# Multi-stage: build the client with Vite, then ship a slim runtime that only
# needs Node + the production deps (`ws`) plus the built dist/.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
# The server listens on SERVER_PORT (if set) else PORT else 8787.
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "server/index.js"]
