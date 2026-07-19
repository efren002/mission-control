FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        composer \
        git \
        php-cli \
        php-curl \
        php-mbstring \
        php-sqlite3 \
        php-xml \
        ripgrep \
        unzip \
    && npm install --global @openai/codex@0.144.5 @anthropic-ai/claude-code@2.1.211 \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && groupadd --system --gid 10001 runner \
    && useradd --system --uid 10001 --gid 10001 --create-home runner \
    && mkdir --parents /workspaces /home/runner/.codex /home/runner/.claude \
    && chown --recursive runner:runner /workspaces /home/runner

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test

USER runner
EXPOSE 8100
CMD ["npm", "start"]
