#!/usr/bin/env bash
# Push main to the production GitHub repo (Render auto-deploys from here).
# Do NOT push to backend-primary (ifcdc-barbers-backend) — that is the wrong/legacy repo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

EXPECTED_REMOTE="https://github.com/IFCDC9/ifcdc-barbers-backend696.git"
CURRENT_REMOTE="$(git remote get-url origin)"

if [[ "$CURRENT_REMOTE" != "$EXPECTED_REMOTE" && "$CURRENT_REMOTE" != "git@github.com:IFCDC9/ifcdc-barbers-backend696.git" ]]; then
  echo "ERROR: origin must be IFCDC9/ifcdc-barbers-backend696"
  echo "  Current:  $CURRENT_REMOTE"
  echo "  Expected: $EXPECTED_REMOTE"
  exit 1
fi

echo "Remote OK: $CURRENT_REMOTE"
echo "Unpushed commits:"
git log origin/main..HEAD --oneline || true
echo ""

if ! command -v gh >/dev/null 2>&1; then
  echo "Installing GitHub CLI (gh)..."
  brew install gh
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not logged in."
  echo ""
  echo "Sign in with the GitHub account that has WRITE access to IFCDC9/ifcdc-barbers-backend696"
  echo "(likely your personal account Rickey33 — NOT the IFCDC9 org read-only credential)."
  echo ""
  gh auth login --hostname github.com --git-protocol https --web
fi

gh auth setup-git

echo ""
echo "Pushing to origin main..."
git push origin main

echo ""
echo "Done. Render should auto-deploy ifcdc-barbers-backend696 from main."
