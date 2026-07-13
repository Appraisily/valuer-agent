FROM node:20-slim AS builder

WORKDIR /usr/src/app

COPY package*.json ./
COPY packages ./packages
RUN npm ci --install-links

COPY . ./
RUN node -e "const fs=require('fs');const lines=fs.readFileSync('env.schema','utf8').split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#')).map(l=>l.split(/[\s#]/)[0]).filter(Boolean).map(k=>k+'=build');fs.writeFileSync('/tmp/build.env',lines.join('\n')+'\n')"
RUN PORT=8080 AUCTION_DATA_API_URL=http://auction-data.invalid AUCTION_DATA_API_KEY=build npm run build

FROM node:20-slim AS runtime

WORKDIR /usr/src/app
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/packages ./packages
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/env.schema ./env.schema
COPY --from=builder /usr/src/app/scripts/validate-env.mjs ./scripts/validate-env.mjs

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
