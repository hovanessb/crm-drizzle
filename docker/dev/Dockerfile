FROM dhi.io/node:24-debian13-dev AS node
USER root
RUN mkdir -p /out \
	&& cp "$(readlink -f "$(command -v node)")" /out/node \
	&& /out/node -e "process.exit(process.versions.bun ? 1 : 0)"

FROM docker:29-cli AS docker

FROM dhi.io/bun:1.4-debian13-dev

ARG USER_UID=1000
ARG USER_GID=1000

ENV DEBIAN_FRONTEND=noninteractive

USER root

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		git \
		libstdc++6 \
		passwd \
		postgresql-client \
		unzip \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=node /out/node /opt/node/bin/node
ENV PATH=/opt/node/bin:$PATH
RUN test "$(command -v node)" = /opt/node/bin/node \
	&& node -e "process.exit(process.versions.bun ? 1 : 0)" \
	&& node --version \
	&& bun --version

COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker

RUN command -v bunx >/dev/null || ln -s "$(command -v bun)" /usr/local/bin/bunx

RUN groupadd -o -g "${USER_GID}" dev \
	&& useradd -o -u "${USER_UID}" -g "${USER_GID}" -m -d /home/dev -s /bin/sh dev \
	&& mkdir -p /home/dev/.bun/install/cache \
	&& chown -R dev:dev /home/dev

USER dev
ENV HOME=/home/dev \
	BUN_INSTALL_CACHE_DIR=/home/dev/.bun/install/cache \
	NEXT_TELEMETRY_DISABLED=1

ENTRYPOINT []
CMD ["sh", "-c", "bun install --frozen-lockfile && exec bun run dev"]
