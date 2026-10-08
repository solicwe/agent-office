FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# The app writes its data and the team's projects here: they must belong to the runtime user.
RUN mkdir -p data projects && chown -R node:node data projects
ENV NODE_ENV=production PORT=3000
# 3000 = Agent Office, 4100+ = the apps the team builds (one port per project)
EXPOSE 3000 4100-4119
VOLUME ["/app/data", "/app/projects"]
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/config >/dev/null || exit 1
CMD ["node", "--env-file-if-exists=.env", "server.js"]
