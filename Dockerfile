FROM node:20-slim

WORKDIR /usr/src/app

COPY valuer-agent/package*.json ./
RUN npm install

COPY valuer-agent/ ./
COPY _shared/messaging /usr/src/app/_shared/messaging
COPY _shared/local-storage /usr/src/app/_shared/local-storage
# Maintain compatibility for dist builds that resolve from /usr/src/_shared
COPY _shared/messaging /usr/src/_shared/messaging
COPY _shared/local-storage /usr/src/_shared/local-storage

RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "start"]
