#!/usr/bin/env bash
# Fail when docs/ differs from the committed tree, including untracked files.
# Generated files (docs/guide.html, docs/lib/) must be rebuilt and committed
# together with their sources.
#
# Usage: bash scripts/check-docs-fresh.sh   (after `pnpm run doc:guide`)
set -euo pipefail

changes="$(git status --porcelain -- docs)"
if [ -n "$changes" ]; then
  echo "$changes"
  echo "docs/ is stale — run 'pnpm run doc:guide' and commit the result."
  exit 1
fi
