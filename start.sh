#!/usr/bin/env bash
set -euo pipefail

rec_editor_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$rec_editor_dir"

# Keep every npm artifact inside this project folder only.
export npm_config_cache="$rec_editor_dir/.npm-cache"
rec_editor_stamp="node_modules/.rec-editor-lock-hash"
rec_editor_hash="$(sha256sum package-lock.json | awk '{print $1}')"

if [[ ! -d node_modules ]] || [[ ! -f "$rec_editor_stamp" ]] || [[ "$(tr -d '\n' < "$rec_editor_stamp")" != "$rec_editor_hash" ]]; then
  echo "Installing isolated project dependencies..."
  npm ci
  printf '%s\n' "$rec_editor_hash" > "$rec_editor_stamp"
fi

rec_editor_host="${REC_EDITOR_HOST:-0.0.0.0}"
rec_editor_port="${REC_EDITOR_PORT:-5173}"
echo "REC Annotation Editor: http://localhost:$rec_editor_port"
exec npm run dev -- --host "$rec_editor_host" --port "$rec_editor_port"
