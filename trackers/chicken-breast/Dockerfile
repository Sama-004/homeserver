# Official Playwright image ships Chromium matching the Playwright version,
# so no browser-version mismatch and no system chromium needed.
FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY tracker.mjs ./
# config.json and state.json come in via a mounted volume (see docker-compose.yml)

# One check, then exit. docker-compose.yml runs this through ../run-loop.sh, which
# repeats it on the schedule the tracker writes to data/next-run; state + config are on
# a volume so each run remembers stock state.
CMD ["node", "tracker.mjs", "--once"]
