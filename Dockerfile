# Malta Tax AI — Node/Express server (serves the site + the tax API).
FROM node:22-slim
WORKDIR /app

# Install runtime deps only (tsx is a runtime dep; typescript/vitest are not needed to run).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# The server reads process.env.PORT (hosts set it); 4380 is the local default.
EXPOSE 4380
CMD ["npm", "start"]
