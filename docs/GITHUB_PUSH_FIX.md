# GitHub push fix (Build 51 commits)

## Correct repository — do not change

| Remote | URL | Push here? |
|--------|-----|------------|
| **origin** | `https://github.com/IFCDC9/ifcdc-barbers-backend696.git` | **YES** — Render production API deploys from this repo |
| backend-primary | `https://github.com/IFCDC9/ifcdc-barbers-backend.git` | **NO** — legacy/wrong service |

Your **3 local commits** are ready on `main`:

```
0f18038c Block time-off days, add provider schedule, reviews, and rewards.
870e0a6b Ship iOS 1.1.1 (Build 51) to App Store review.
34836f3b Bump iOS to Build 51 for App Store submission.
```

## What caused the 403

macOS Keychain had **stale GitHub HTTPS credentials** for an account without write access (`Permission denied to IFCDC9`). That cache was cleared. `gh` is now installed.

Your git identity is **Rickey33** (`80795331+Rickey33@users.noreply.github.com`). Sign in with the GitHub user that is a **collaborator** on `IFCDC9/ifcdc-barbers-backend696` (usually your personal account, not a read-only org token).

## Option A — Recommended (GitHub CLI)

Run in Terminal:

```bash
cd /Users/fahrealallah/Documents/ifcdc-barbers-backend-2
./scripts/github-push-main.sh
```

Or manually:

```bash
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
git push origin main
```

When `gh auth login` opens the browser, approve access for the account that can push to **IFCDC9/ifcdc-barbers-backend696**.

## Option B — Personal access token (HTTPS)

1. GitHub → **Settings → Developer settings → Personal access tokens** → generate token with **repo** scope.
2. Clear any old credential (already done once; repeat if push still fails):

   ```bash
   printf "protocol=https\nhost=github.com\n" | git credential-osxkeychain erase
   ```

3. Push (use token as password when prompted; username = your GitHub username):

   ```bash
   cd /Users/fahrealallah/Documents/ifcdc-barbers-backend-2
   git push origin main
   ```

## Option C — SSH

You have `~/.ssh/id_rsa.pub` but it is **not** loaded in `ssh-agent` and GitHub rejected it.

1. Add the public key to GitHub → **Settings → SSH and GPG keys**.
2. Then:

   ```bash
   eval "$(ssh-agent -s)"
   ssh-add ~/.ssh/id_rsa
   git remote set-url origin git@github.com:IFCDC9/ifcdc-barbers-backend696.git
   git push origin main
   ```

## After a successful push

1. **Render** auto-deploys `ifcdc-barbers-backend696` from `main` (~2–3 min).
2. Verify: `node scripts/verify-production-deploy.mjs`
3. **iOS Build 51** (already committed): submit from `mobile/` if not already on App Store Connect:

   ```bash
   cd mobile && eas build --platform ios --profile production
   eas submit --platform ios --latest
   ```
