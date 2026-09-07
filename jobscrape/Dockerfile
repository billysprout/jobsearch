# jobscrape/config-server.mjs — containerized config/status service.
# Stdlib-only import graph (config.mjs, state.mjs, pipeline/render.mjs), so
# there is NO npm install and no node_modules in the image. Live operator
# state (configs/, state/, logs/) never enters the build context
# (.dockerignore) — it arrives via compose bind mounts because the 07:00
# HOST-run scrape.mjs reads/writes the same files.
FROM node:22-alpine

WORKDIR /app

COPY config-server.mjs config.mjs state.mjs ./
COPY pipeline/ ./pipeline/

# Non-root; the only writable path is the /app/configs bind (atomic tmp+rename
# writes and .backups snapshots land there, same-dir by design).
USER node
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8790/health || exit 1

CMD ["node", "config-server.mjs"]
