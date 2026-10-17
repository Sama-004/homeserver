# Plain Node — no browser. Unlike the Blinkit sibling (which needs curl-impersonate
# to clear Cloudflare), NIMAS serves the course table as plain JSON
# from its ERP API, so native fetch is enough. Node 22 = fetch built in.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
# No `npm install` — the tracker has zero dependencies.

COPY tracker.mjs ./
# config.json and state.json come in via a mounted volume (see docker-compose.yml)

# One check, then exit. docker-compose.yml runs this through ../run-loop.sh, which
# repeats it on the schedule the tracker writes to data/next-run; state + config are on
# a volume so each run remembers seat state.
CMD ["node", "tracker.mjs", "--once"]
