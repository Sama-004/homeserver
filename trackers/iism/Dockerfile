# Plain Node — no browser. iismgulmarg.in is server-rendered HTML, so native fetch
# is enough. Node 22 = fetch built in.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
# No `npm install` — the tracker has zero dependencies.

COPY tracker.mjs ./
# config.json and state.json come in via a mounted volume (see docker-compose.yml)

# One check, then exit. docker-compose.yml runs this through ../run-loop.sh, which
# repeats it on the schedule the tracker writes to data/next-run; state + config are on
# a volume so each run remembers what the site looked like.
CMD ["node", "tracker.mjs", "--once"]
