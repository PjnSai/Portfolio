# Production runs on Cloudflare Pages from `npm run build` (out/). This image
# serves the same files with the same _headers, for Docker Compose and the
# kind demo. The API's address is fixed at build time.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS build
WORKDIR /app
ARG API_BASE_URL=""
ARG SKIP_SITE_FETCH="1"
ARG SITE_ORIGIN=""
ENV NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=$API_BASE_URL SKIP_SITE_FETCH=$SKIP_SITE_FETCH SITE_ORIGIN=$SITE_ORIGIN
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm run check:export

FROM gcr.io/distroless/nodejs24-debian12:nonroot
WORKDIR /app
ENV PORT=3000 HOSTNAME=0.0.0.0 STATIC_ROOT=/app/out
COPY --from=build /app/out ./out
COPY --from=build /app/scripts/serve-static.ts ./scripts/
COPY --from=build /app/lib/pages-headers.ts /app/lib/security-headers.ts ./lib/
USER nonroot
EXPOSE 3000
CMD ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/serve-static.ts"]
