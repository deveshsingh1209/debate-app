# ADVANCED, OPTIONAL. The normal way to run this app is `npm install && npm start`
# on your own machine. See docs/DOCKER.md before using this.
# Node 24 LTS: SQLite is built into Node, so nothing is compiled and no build tools are needed.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# The Claude provider needs the Claude Code CLI inside the container.
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/shared ./shared
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
# Inside the container the app must listen on all interfaces so the published
# port works, and it never does that without a password. Unless ACCESS_PASSWORD
# is set, the first start generates one, keeps it in the data volume
# (data/.access-password) and prints it once in the logs.
# docker-compose.yml publishes the port on the host's 127.0.0.1 only.
ENV HOST=0.0.0.0 PORT=8794 DATA_DIR=/app/data AUTO_ACCESS_PASSWORD=1
EXPOSE 8794
CMD ["node", "server/dist/index.cjs"]
