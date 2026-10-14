# Plain Node — no browser. The Amazon store page embeds each product's stock record in
# its server-rendered HTML, so one GET is enough. Node 22 = fetch built in.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
# No `npm install` — the tracker has zero dependencies.

COPY tracker.mjs ./
# config.json and state.json come in via a mounted volume (see docker-compose.yml)

# One check per process; run-loop.sh re-runs it at the time written to data/next-run.
CMD ["node", "tracker.mjs", "--once"]
