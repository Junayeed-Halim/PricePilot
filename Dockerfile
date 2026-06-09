FROM mcr.microsoft.com/playwright:v1.60.0-jammy
WORKDIR /app
COPY backend/package.json ./
RUN npm install --production
COPY backend/server.js ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
