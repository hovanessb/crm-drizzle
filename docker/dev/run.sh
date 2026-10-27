#!/usr/bin/env sh
set -eu

CRM_REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CRM_UID="$(id -u)"
CRM_GID="$(id -g)"
CRM_DOCKER_GID="$CRM_GID"
export CRM_REPO CRM_UID CRM_GID CRM_DOCKER_GID

compose_file="$CRM_REPO/docker/dev/compose.yml"
socket="/var/run/docker.sock"

if [ -S "$socket" ] && [ -z "${CRM_DEV_NO_DOCKER:-}" ]; then
	CRM_DOCKER_GID="$(stat -c %g "$socket")"
	export CRM_DOCKER_GID
	set -- -v "$socket:$socket" dev "$@"
else
	set -- dev "$@"
fi

docker compose -f "$compose_file" build --quiet dev
exec docker compose -f "$compose_file" run --rm "$@"
