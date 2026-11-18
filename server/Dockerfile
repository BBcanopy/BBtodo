FROM node:24.14.1-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./

# Skip the implicit SQLite rebuild, then run the esbuild setup used by dev tools.
RUN npm ci --ignore-scripts && npm rebuild esbuild

COPY tsconfig.json ./
COPY drizzle drizzle
COPY src src

RUN npm run build

FROM node:24.14.1-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./

# better-sqlite3 v13 ships prebuilt binaries; avoid npm/cli#9837 rebuilding them.
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist dist
COPY --from=builder /app/drizzle drizzle

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "dist/index.js"]
