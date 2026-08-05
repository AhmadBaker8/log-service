# ---- Stage 1: build ----
# Installs all dependencies, including dev, and compiles TypeScript.
# This stage is discarded; only its dist/ output is carried forward.
FROM node:22-alpine AS builder

WORKDIR /app

# Copied before the source so Docker can cache the dependency layer.
# Source changes then rebuild without reinstalling node_modules.
COPY package.json package-lock.json ./

# ci installs strictly from the lockfile and fails if it disagrees with
# package.json, so the build cannot silently drift to other versions.
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- Stage 2: runtime ----
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# The container is capped at 256MB. Without a heap limit Node will grow
# past it and be OOM-killed with no error output. 192 leaves headroom
# for the runtime outside the JavaScript heap.
ENV NODE_OPTIONS="--max-old-space-size=192"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# .sql files are not compiled, so they are copied directly. The runner
# resolves this path relative to dist/db via __dirname.
COPY migrations ./migrations

# The node image ships an unprivileged user. Running as root would give
# an attacker a stronger position if the process were compromised.
USER node

EXPOSE 8080

CMD ["node", "dist/index.js"]
