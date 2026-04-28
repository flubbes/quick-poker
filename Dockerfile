FROM node:24.15.0-alpine3.23
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
