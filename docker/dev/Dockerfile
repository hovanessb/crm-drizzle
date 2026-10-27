FROM oven/bun:1.4.0 AS bun
FROM node:24-bookworm-slim AS node
FROM docker:29-cli AS docker

FROM ubuntu:24.04

ARG USER_UID=1000
ARG USER_GID=1000

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		git \
		libstdc++6 \
		postgresql-client \
		unzip \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
	&& ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx

COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker

RUN groupmod -o -g "${USER_GID}" ubuntu \
	&& usermod -o -u "${USER_UID}" -g "${USER_GID}" ubuntu \
	&& mkdir -p /home/ubuntu/.bun/install/cache \
	&& chown -R ubuntu:ubuntu /home/ubuntu

USER ubuntu
ENV HOME=/home/ubuntu \
	BUN_INSTALL_CACHE_DIR=/home/ubuntu/.bun/install/cache \
	NEXT_TELEMETRY_DISABLED=1

CMD ["sh", "-c", "bun install --frozen-lockfile && exec bun run dev"]
