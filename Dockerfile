FROM node:24-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps firefox && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node .actor ./.actor
COPY --chown=node:node README.md ./README.md
RUN mkdir -p storage && chown -R node:node /usr/src/app
USER node
CMD ["node", "src/main.js"]
