#!/usr/bin/env bash
#
# One-shot push of the 12 AI integration env vars from local .env
# to the linked Vercel project's production environment.
#
# Whitelisted to AI-integration keys only — does NOT touch personal
# fantasy-league credentials (ESPN_S2, YAHOO_*, SLEEPER_*) which
# don't make sense on a public deploy. See docs/interview-walkthrough.md
# for the rationale.
#
# Idempotent: removes any existing value before adding so re-runs
# just refresh the keys to whatever's currently in .env.
#
# Usage:
#   bash scripts/pushAiKeysToVercel.sh           # reads ./.env
#   bash scripts/pushAiKeysToVercel.sh path/.env # custom path
#
# After it finishes, redeploy to pick up the new env:
#   vercel deploy --prod

set -euo pipefail

KEYS=(
  NEMOTRON_API_KEY
  NEMOTRON_ENDPOINT
  NEMOTRON_MODEL
  OPENAI_API_KEY
  OPENAI_MODEL
  OPENAI_FAST_MODEL
  ELEVENLABS_API_KEY
  ELEVENLABS_VOICE_ID
  ELEVENLABS_MODEL_ID
  MODEL_PROVIDER
  COMMENTARY_PROVIDER
  TTS_PROVIDER
)

ENV_FILE="${1:-.env}"

[ -f "$ENV_FILE" ] || { echo "[fail] $ENV_FILE not found"; exit 1; }
command -v vercel >/dev/null || { echo "[fail] vercel CLI not on PATH — run: npm i -g vercel"; exit 1; }
[ -f .vercel/project.json ] || { echo "[fail] No .vercel/project.json — run 'vercel link' first"; exit 1; }

# Robust value extractor: handles CRLF line endings, optional 'export '
# prefix, and surrounding double or single quotes around the value.
# Echoes the raw value to stdout (no newline).
extract_value() {
  local key="$1"
  local raw
  raw=$(grep -E "^(export[[:space:]]+)?${key}=" "$ENV_FILE" | head -1 | tr -d '\r' || true)
  [ -n "$raw" ] || return 1
  raw="${raw#export }"
  raw="${raw#"${key}"=}"
  # Strip surrounding "..." or '...' if present
  if [[ "$raw" == \"*\" ]]; then raw="${raw:1:${#raw}-2}"; fi
  if [[ "$raw" == \'*\' ]]; then raw="${raw:1:${#raw}-2}"; fi
  printf '%s' "$raw"
}

pushed=0; skipped=0; failed=0
for KEY in "${KEYS[@]}"; do
  if ! VAL=$(extract_value "$KEY") || [ -z "$VAL" ]; then
    echo "[skip] $KEY (not in $ENV_FILE)"
    skipped=$((skipped + 1))
    continue
  fi
  # Idempotent: rm then add. `vercel env add` rejects an existing key,
  # so a fresh push depends on this. The rm is silent if the key
  # doesn't exist.
  vercel env rm "$KEY" production --yes >/dev/null 2>&1 || true
  if vercel env add "$KEY" production --value "$VAL" --yes >/dev/null 2>&1; then
    echo "[ok]   $KEY (${#VAL} chars)"
    pushed=$((pushed + 1))
  else
    echo "[fail] $KEY"
    failed=$((failed + 1))
  fi
done

echo "---"
echo "pushed=$pushed  skipped=$skipped  failed=$failed"
if [ "$pushed" -gt 0 ]; then
  echo
  echo "Next: pick up the new env with a fresh deploy:"
  echo "  vercel deploy --prod"
fi
exit $((failed > 0 ? 1 : 0))
