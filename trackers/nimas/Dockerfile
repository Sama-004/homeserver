# Plain Node — no browser. Unlike the Blinkit sibling (which needs headless
# Chromium to clear Cloudflare), NIMAS serves the course table as plain JSON
# from its ERP API, so native fetch is enough. Node 22 = fetch built in.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
# No `npm install` — the tracker has zero dependencies.

COPY tracker.mjs ./
# config.json and state.json come in via a mounted volume (see docker-compose.yml)

# Default to watch mode; state + config are on a volume so restarts remember seat state.
CMD ["node", "tracker.mjs", "--watch"]
