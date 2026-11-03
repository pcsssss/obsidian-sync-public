#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
tmp="$(mktemp -d "$PWD/node_modules/.offline-tests.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

for test in sync-test drive-test drive-conditional-test gcs-conditional-delete-test localstore-test crypto-test e2ee-test \
  redirect-login-test redirect-page-test resume-test requesturl-test \
  obsidian-smoke gcs-oauth-test sigv4-difftest time-test \
  controller-status-test secret-storage-test concurrency-test; do
  ./node_modules/.bin/esbuild "scripts/$test.ts" --bundle --platform=node --format=cjs \
    --alias:obsidian=./scripts/_mock-obsidian.ts --outfile="$tmp/$test.cjs" --log-level=warning
  node "$tmp/$test.cjs"
done
