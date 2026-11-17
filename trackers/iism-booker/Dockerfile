# Headless Chromium + Node from Playwright's own image; playwright-core is pinned to the same
# version (package.json), so it finds the image's browser without downloading one.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY booker.mjs ./
# config.json and data/ (autofill.user.js, booked.json, shots/) come in via volumes.
CMD ["node", "booker.mjs"]
