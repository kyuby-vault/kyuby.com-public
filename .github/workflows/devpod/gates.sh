#!/usr/bin/env bash
set -euo pipefail
cd /workspace
npm run check
if [[ "${DEVPOD_PUBLIC_SNAPSHOT:-0}" == 1 ]]; then
  # Only the independently curated public mirror lacks private test sources.
  node -e 'const s=require("./PUBLIC-SNAPSHOT.json"); if(!/^[a-f0-9]{40}$/.test(s.upstreamCommit)||!/^[a-f0-9]{40}$/.test(s.sourceTree)) process.exit(1)'
else
  test -d tests/unit && test -d tests/browser
  npx --no-install vitest run
  npx --no-install playwright test --output=test-results/playwright
fi
npm run build
npm run deploy:dry-run
