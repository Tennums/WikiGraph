# No npm install: the API uses node:http, node:sqlite and node:fs only, so there is no
# dependency tree to audit, pin or rebuild.
#
# Not shipped: tools/smoke.mjs, which starts this same server against a build and calls
# every route once -- `node tools/smoke.mjs data/graph` on a checkout, or in CI against a
# simplewiki build, before the image is built.
FROM node:24-alpine
WORKDIR /app
COPY api/ ./api/
COPY web/ /web/
ENV NODE_ENV=production GRAPH_DIR=/data/graph WEB_DIR=/web
EXPOSE 3000
USER node
CMD ["node", "api/server.mjs"]
