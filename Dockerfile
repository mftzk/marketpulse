# syntax=docker/dockerfile:1

# --- Build ------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies from the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the source and build.
COPY . .

# The platform patches `output: "standalone"` into next.config.mjs at deploy
# time; for a self-contained image we inject the same option here WITHOUT
# modifying the repository's next.config.mjs. The project's `build` script then
# copies scripts/, drizzle/ and node_modules/postgres into .next/standalone.
RUN node -e "const fs=require('fs');const p='next.config.mjs';let s=fs.readFileSync(p,'utf8');if(!s.includes('output:')){s=s.replace('const nextConfig = {','const nextConfig = {\n  output: \"standalone\",');fs.writeFileSync(p,s);}" \
  && npm run build

# --- Runtime ----------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

# The standalone server bundle already contains the traced node_modules, the
# migration/seed scripts and the drizzle SQL (copied by `npm run build`).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# Run migrations + seed, then the server. `scripts/release.mjs` spawns its
# children itself (no shell metacharacters needed by the platform contract);
# the `sh -c` wrapper here is only the local container entrypoint.
CMD ["sh", "-c", "node scripts/release.mjs && node server.js"]
