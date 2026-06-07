# Multi-stage Node build → small non-root runtime. Multi-arch (arm64 + amd64).
# Build stage runs on the builder's native arch ($BUILDPLATFORM) to avoid QEMU
# emulation flakiness during the TypeScript build.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
