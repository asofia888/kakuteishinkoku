#!/bin/bash
set -euo pipefail

# SessionStart hook for Claude Code on the web.
# Installs Node dependencies so builds, type-checks and linters work
# immediately in remote sessions. Safe to run locally (it just no-ops).

# Only run in remote (Claude Code on the web) sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# npm install is idempotent and benefits from the cached container state
# (preferred over `npm ci`, which wipes node_modules every time).
npm install
