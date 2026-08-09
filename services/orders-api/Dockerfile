# Dev-oriented image: we deliberately DON'T compile TypeScript ahead of time.
# `tsx` runs .ts directly, and docker-compose bind-mounts ./src over this layer,
# so you can edit code on your Mac and the process reloads inside the container.
# That matters for a learning lab: you will be changing this app constantly.
FROM node:22-alpine

WORKDIR /app

# Install deps first so this layer caches independently of source changes.
COPY package.json package-lock.json* ./
RUN npm install

# Baked-in copy of the source. Compose overlays a bind mount on top of ./src,
# but keeping this here means the image also works standalone (no mount).
COPY tsconfig.json ./
COPY src ./src

# curl is used by the compose healthcheck.
RUN apk add --no-cache curl

CMD ["npx", "tsx", "src/index.ts"]
