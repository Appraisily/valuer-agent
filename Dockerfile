FROM node:20-slim AS builder

WORKDIR /usr/src/app

ARG SERVICE_DIR=services/valuer-agent
ARG SHARED_DIR=services/_shared
ARG ENV_GOVERNANCE_DIR=env-governance

COPY ${SERVICE_DIR}/package*.json ./
RUN npm install

COPY ${SERVICE_DIR}/ ./
COPY ${SHARED_DIR}/messaging /usr/src/app/_shared/messaging
COPY ${SHARED_DIR}/local-storage /usr/src/app/_shared/local-storage
COPY ${SHARED_DIR}/cors /usr/src/app/_shared/cors
# Maintain compatibility for dist builds that resolve from /usr/src/_shared
COPY ${SHARED_DIR}/messaging /usr/src/_shared/messaging
COPY ${SHARED_DIR}/local-storage /usr/src/_shared/local-storage
COPY ${SHARED_DIR}/cors /usr/src/_shared/cors

# Tools shared for env validation (the app's env-check uses ../../env-governance)
COPY ${ENV_GOVERNANCE_DIR}/ /usr/env-governance/

# Prepare ENV_GOV_REPO_ROOT so env-governance can locate the schema (.env.names)
ENV ENV_GOV_REPO_ROOT=/usr/src/env-check
RUN mkdir -p /usr/src/env-check/services/valuer-agent \
    && cp ./.env.names /usr/src/env-check/services/valuer-agent/.env.names

# Build-time env-check requires these vars to be present.
# Values are placeholders and do not ship to the runtime image.
ENV PORT=8080
ENV GOOGLE_CLOUD_PROJECT_ID=build
ENV AZTOKEN_PROD=build
ENV INVALUABLE_CF_CLEARANCE=build
ENV OPENAI_API_KEY=build
ENV PUBLIC_ASSETS_BASE_URL=https://assets.appraisily.com
ENV SCRAPER_DB_URL=postgres://build:build@localhost:5432/scraper
ENV SCRAPER_DB_SSL=false
ENV SCRAPER_DB_QUERY_TIMEOUT_MS=10000
ENV SCRAPER_DB_AUTO_MIN_LOTS=5
ENV VALUER_PROVIDER=live

RUN npm run build

FROM node:20-slim AS runtime

WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/_shared ./_shared
COPY --from=builder /usr/src/_shared /usr/src/_shared
COPY --from=builder /usr/env-governance /usr/env-governance
COPY --from=builder /usr/src/env-check /usr/src/env-check

ENV NODE_ENV=production
ENV PORT=8080
ENV ENV_GOV_REPO_ROOT=/usr/src/env-check

EXPOSE 8080

CMD ["npm", "start"]
