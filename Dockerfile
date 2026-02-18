FROM oven/bun:alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/homie-ai/package.json packages/homie-ai/
COPY packages/create-homie/package.json packages/create-homie/
RUN bun install --frozen-lockfile --production

FROM oven/bun:alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/homie-ai/node_modules ./packages/homie-ai/node_modules
COPY . .
RUN bun run build

FROM oven/bun:alpine
WORKDIR /app

RUN addgroup --system --gid 1001 homie && \
    adduser --system --uid 1001 --ingroup homie homie

COPY --from=build /app/packages/homie-ai/dist ./dist
COPY --from=build /app/packages/homie-ai/node_modules ./node_modules
COPY --from=build /app/packages/homie-ai/package.json ./

USER homie

VOLUME ["/app/identity", "/app/data"]

EXPOSE 9091

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:9091/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "dist/cli.js"]
CMD ["start"]
