FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production \
    PORT=8080 \
    GOOGLE_APPLICATION_CREDENTIALS=/app/keys/service-account.json

# Create directory for service account key
RUN mkdir -p /app/keys

EXPOSE 8080

CMD ["npm", "start"]