#!/usr/bin/env bash
set -euo pipefail
# Export includes this directory, but deliberately excludes private root tooling.
# Materialize only missing root facades; existing copies must match exactly.
for pair in 'Containerfile:Containerfile' 'Makefile:Makefile' '.dockerignore:dockerignore'; do
  root_file=${pair%%:*}; copy=${pair#*:}
  if [[ -e "$root_file" ]]; then cmp "$root_file" ".github/workflows/devpod/$copy";
  else cp ".github/workflows/devpod/$copy" "$root_file"; fi
done
[[ ${1:-} == --prepare ]] && exit 0
test -n "${RUNNER_TEMP:-}"
cache="$RUNNER_TEMP/kyuby-devpod-build-cache"
mkdir -p "$cache"
docker buildx create --name kyuby-devpod-ci --driver docker-container --use
args=(--load --platform linux/amd64 --file Containerfile --tag localhost/kyuby-devpod --cache-to "type=local,dest=$cache,mode=max")
if [[ -f "$cache/index.json" ]]; then args+=(--cache-from "type=local,src=$cache"); fi
docker buildx build "${args[@]}" .
