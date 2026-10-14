# Plain Node — no browser. Uniqlo's product API is plain JSON over fetch, and the price
# database is the built-in node:sqlite. Node 22 = fetch and SQLite built in.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
# No `npm install` — the tracker has zero dependencies.

COPY tracker.mjs ./
# config.json comes in via a mounted file; state.json and uniqlo.db via the data/ volume
# (see docker-compose.yml)

# One check per process; run-loop.sh re-runs it at the time written to data/next-run.
CMD ["node", "tracker.mjs", "--once"]
