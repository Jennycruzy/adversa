FROM node:20-slim AS base
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Copy package files
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN pnpm build

# Runtime image
FROM node:20-slim AS runtime
WORKDIR /app

RUN npm install -g pnpm@9
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
COPY --from=base /app/src/dashboard/public ./src/dashboard/public
COPY package.json ./

# Create data directory for offline queue
RUN mkdir -p /app/data

EXPOSE 3001 3002

CMD ["node", "dist/index.js"]
