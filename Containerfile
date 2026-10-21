# The web service (src/server.ts): one Node.js process, no GPU. Runs as any UID (OpenShift restricted SCC).
#   podman build -t gpu-sizing -f Containerfile .
#   podman run -p 8080:8080 -e HF_TOKEN=hf_... gpu-sizing
FROM registry.access.redhat.com/ubi9/nodejs-22:latest AS build
USER 0
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN OUT_DIR=/app node scripts/build-server.mjs --repack

FROM registry.access.redhat.com/ubi9/nodejs-22-minimal:latest
WORKDIR /app
COPY --from=build /app/ /app/
USER 0
RUN mkdir -p /cache && chgrp -R 0 /cache /app && chmod -R g=u /cache /app
USER 1001
ENV PORT=8080 \
    XDG_CACHE_HOME=/cache \
    NODE_USE_ENV_PROXY=1 \
    NODE_OPTIONS=--enable-source-maps
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
