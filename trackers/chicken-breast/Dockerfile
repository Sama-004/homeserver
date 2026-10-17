# The musl build of curl-impersonate, pinned by tag and digest. Beyond musl it links only
# libstdc++ and libgcc, which node:22-alpine already ships for Node itself. A newer Chrome
# target means bumping this pin and api.impersonate in config.json together.
FROM lexiforest/curl-impersonate:v2.2.3-alpine@sha256:e3aeb0b7c8b0951ea83be4a17ed38480e9fd227a4d1d8fe95971cdc87f161811 AS curl

# Plain Node, no browser: one Blinkit API call per check, made through curl-impersonate
# because Cloudflare blocks Node's own TLS fingerprint.
FROM node:22-alpine
COPY --from=curl /usr/local/bin/curl-impersonate /usr/local/bin/curl-impersonate

WORKDIR /app
COPY package.json ./
# No `npm install` — the tracker has zero dependencies.

COPY tracker.mjs ./
# config.json and state.json come in via a mounted volume (see docker-compose.yml)

# One check per process; run-loop.sh re-runs it at the time written to data/next-run.
CMD ["node", "tracker.mjs", "--once"]
