FROM node:22-alpine

WORKDIR /app

# Install dependencies (network needed during build only — runtime egress
# goes through the squid allowlist proxy like every other container here)
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Application code
COPY src/ ./src/

# Non-root, read-only-friendly
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
