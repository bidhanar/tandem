# Mendu sync server. Build from the server/ folder:
#   docker build -t mendu-server server
#   docker run -p 8686:8686 mendu-server

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/src ./dist/src
# Hosts usually set PORT themselves; 8686 is the default.
EXPOSE 8686
USER node
CMD ["node", "dist/src/index.js"]
