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

# Build-time env-check requires the schema keys to exist, but those values do not
# ship to the runtime image. Generate a placeholder env file directly from
# `.env.names` so the Dockerfile stays in sync as the schema evolves.
RUN node -e "const fs=require('fs');const src='.env.names';const dst='/tmp/build.env';const lines=fs.readFileSync(src,'utf8').split(/\\r?\\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#')).map(l=>l.split(/[\\s#]/)[0].trim()).filter(Boolean).map(k=>k+'=build');fs.writeFileSync(dst, lines.join('\\n')+'\\n');"
ENV ENV_GOV_ENV_FILE=/tmp/build.env

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
ENV NODE_PATH=/usr/src/app/node_modules
ENV PORT=8080
ENV ENV_GOV_REPO_ROOT=/usr/src/env-check

EXPOSE 8080

CMD ["npm", "start"]
