# Single-image build: compile the React client, then run the Express server
# (which serves both the API and the built frontend). git is required at runtime
# because the roaster clones public repos to analyze them.
FROM node:20-slim

# git: needed at runtime for repo clones. ca-certificates: for https github clones.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Build the client ---
COPY client/package.json client/package-lock.json* ./client/
RUN cd client && npm install
COPY client/ ./client/

# --- Install server deps ---
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install
COPY server/ ./server/

# Build the frontend into server/public (vite outDir points there).
RUN cd client && npm run build

# Render provides PORT; the server reads process.env.PORT.
ENV NODE_ENV=production
WORKDIR /app/server
EXPOSE 3001
CMD ["npm", "start"]
