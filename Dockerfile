FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
EXPOSE 3000
USER node
CMD ["node", "server.js"]
