#!/usr/bin/env bash
# Build the two runtime images declared by the base Compose configuration.
set -euo pipefail

usage() {
    printf 'Usage: bash deploy/build-images.sh [compose-project]\n'
    printf 'Default project: rimo\n'
}

if [ "$#" -gt 1 ]; then
    usage >&2
    exit 64
fi
if [ "${1:-}" = --help ] || [ "${1:-}" = -h ]; then
    usage
    exit 0
fi

project=${1:-rimo}
if [[ ! "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    printf 'Invalid Compose project: use lowercase letters, digits, underscores or hyphens.\n' >&2
    exit 64
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
compose=(docker compose --project-name "$project" --file docker-compose.yml)

printf 'Building the Rimo application image through migrate...\n'
"${compose[@]}" build migrate
printf 'Building the PDF worker image...\n'
"${compose[@]}" build export-worker

image_refs=$("${compose[@]}" config --images)
app_image=
worker_image=
while IFS= read -r image; do
    case "$image" in
        rimo:*) app_image=$image ;;
        rimo-export:*) worker_image=$image ;;
    esac
done <<< "$image_refs"

if [ -z "$app_image" ] || [ -z "$worker_image" ]; then
    printf 'The base Compose configuration must declare both Rimo runtime images.\n' >&2
    exit 1
fi

printf 'Built immutable image IDs:\n'
for image in "$app_image" "$worker_image"; do
    image_id=$(docker image inspect --format '{{.Id}}' "$image")
    printf '%s %s\n' "$image" "$image_id"
done
