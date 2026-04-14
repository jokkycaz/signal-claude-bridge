FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV WEB_PORT=3100

CMD ["node", "src/index.js"]
