FROM mcr.microsoft.com/playwright:v1.44.0-jammy
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
