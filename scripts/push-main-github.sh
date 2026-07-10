#!/usr/bin/env bash
# Push main to the production Render-connected repo.
# Correct remote: origin → https://github.com/IFCDC9/ifcdc-barbers-backend696.git
# Do NOT push to backend-primary (legacy ifcdc-barbers-backend).

set -euo pipefail
cd "$(dirname "$0")/.."

ORIGIN_URL="$(git remote get-url origin)"
EXPECTED="ifcdc-barbers-backend696"

if [[ "$ORIGIN_URL" != *"$EXPECTED"* ]]; then
  echo "ERROR: origin is not the production repo."
  echo "  Current: $ORIGIN_URL"
  echo "  Expected URL to contain: $EXPECTED"
  echo "  Fix: git remote set-url origin https://github.com/IFCDC9/ifcdc-barbers-backend696.git"
  exit 1
fi

echo "Remote OK: $ORIGIN_URL"
echo "Commits to push:"
git log origin/main..HEAD --oneline || true

if ! command -v gh >/dev/null 2>&1; then
  echo "Install GitHub CLI: brew install gh"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    echo "Logging in with GITHUB_TOKEN..."
    printf '%s' "$GITHUB_TOKEN" | gh auth login --with-token
  elif [[ -n "${GH_TOKEN:-}" ]]; then
    echo "Logging in with GH_TOKEN..."
    printf '%s' "$GH_TOKEN" | gh auth login --with-token
  else
    echo "Not logged into GitHub. Run ONE of:"
    echo "  gh auth login   # browser flow (use account with write access to IFCDC9/ifcdc-barbers-backend696)"
    echo "  GITHUB_TOKEN=ghp_xxx ./scripts/push-main-github.sh"
    exit 1
  fi
  gh auth setup-git
fi

echo "Pushing: git push origin main"
git push origin main
echo "Done. Render auto-deploy should start for ifcdc-barbers-backend696."
