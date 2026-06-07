# Build the SPA, serve it from a non-root nginx that reverse-proxies /api to the
# admin-api. The build stage runs on the BUILDER's native arch ($BUILDPLATFORM):
# esbuild/Vite crash under QEMU emulation (write EPIPE) when cross-building amd64
# on an arm64 runner. dist is static + arch-neutral, so the final image stays
# multi-arch via the per-arch nginx base.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
ENV ADMIN_API_URL=http://novamail-admin-api:3000
EXPOSE 8080
