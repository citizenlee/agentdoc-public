FROM node:20-slim

WORKDIR /app

# Copy everything (workspaces need their full structure for npm install)
COPY . .

RUN npm install

ENV NODE_ENV=production
ENV PORT=4000
ENV DATABASE_PATH=/data/agentdoc.db

EXPOSE 4000

CMD ["npx", "tsx", "server/index.ts"]
