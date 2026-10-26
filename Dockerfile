FROM oven/bun:1.4-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

CMD ["bun", "run", "serve"]
