# Official Playwright image ships Chromium matching the Playwright version,
# so no browser-version mismatch and no system chromium needed.
FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY tracker.mjs ./
# config.json and state.json come in via a mounted volume (see docker-compose.yml)

# Default to watch mode; state + config are on a volume so restarts remember stock state.
CMD ["node", "tracker.mjs", "--watch"]
