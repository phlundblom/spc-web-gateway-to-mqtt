FROM node:24-alpine

WORKDIR /app
ADD https://github.com/phlundblom/spc-web-gateway-to-mqtt.git .
RUN npm ci
RUN npm run build

CMD ["node", "/app/dist/index.js"]

