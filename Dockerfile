# Build image
FROM node:22-alpine AS builder

# COMMIT=$(git rev-parse --short HEAD) 
# docker build --network=host --build-arg VERSION=$COMMIT -t model-proxy-v3:$COMMIT -t model-proxy-v3:latest .

WORKDIR /app

# Install build tools (no python needed - sharp/esbuild have prebuilt binaries)
RUN apk add --no-cache make g++

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies.
# --omit=optional + --ignore-scripts: skip the @github/keytar optional dependency
# (and its prebuild-install script) — the native addon targets an OS keychain,
# which doesn't exist in this image. store_key_in_system stays unsupported in
# Docker (fails loud at runtime). No prod dependency relies on install scripts.
RUN npm install --omit=optional --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY tsconfig.server.json ./
COPY src/ ./src/
COPY submodules/ ./submodules/

RUN npm run build

# Drop devDependencies (wrangler, claude/codex/genai SDKs, etc.) now that the build is done
RUN npm prune --omit=dev

# Production image - much smaller
FROM node:22-alpine

WORKDIR /app

# Copy only what's needed from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/submodules ./submodules
COPY --from=builder /app/dist ./dist

ARG VERSION
ENV VERSION=$VERSION
ENV LOCAL_TIKTOKEN=true
ENV TIKTOKEN_MODEL="o200k_base"

EXPOSE 8788

CMD ["node", "dist/server.js"]
