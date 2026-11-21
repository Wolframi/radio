FROM oven/bun:1.2-debian AS base

# Install ffmpeg, python3, curl, and yt-dlp for audio decoding and viewer order downloads
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/protocol/package.json ./packages/protocol/
COPY apps/server/package.json ./apps/server/

RUN bun install --production

COPY shared ./shared
COPY packages ./packages
COPY apps/server ./apps/server

RUN mkdir -p /app/data /app/certs

EXPOSE 4433/tcp
EXPOSE 4433/udp

ENV NODE_ENV=production
ENV PORT=4433
ENV DATA_DIR=/app/data

CMD ["bun", "run", "apps/server/src/index.ts"]
