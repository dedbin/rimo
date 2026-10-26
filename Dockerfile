FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM dependencies AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS production-dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node collaboration-server ./collaboration-server
COPY --chown=node:node lib ./lib
COPY --chown=node:node types ./types
COPY --chown=node:node scripts ./scripts
RUN mkdir -p data/assets && chown -R node:node data
USER node
EXPOSE 3000 1234
CMD ["node", "server.js"]
