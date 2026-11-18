# Event Photos for a server: one image with the built web app and API, plus ffmpeg for videos.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# The face model runs on the CPU: onnxruntime's optional GPU (CUDA) download is skipped.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
COPY . .
# Some server packages (express among them) live in server/node_modules, not the top folder: the folder is made
# even when empty so the copy below never fails.
RUN npm run build && npm prune --omit=dev --no-audit --no-fund && mkdir -p server/node_modules

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/models ./server/models
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/server
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
