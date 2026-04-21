# Pending CI workflow changes

Borg can't push to `.github/workflows/` (missing `workflows` scope on the
installation token). Workflow file updates are staged here and applied by a
human operator with:

```bash
git pull
mv scripts/ci-pending/test.yml .github/workflows/test.yml
rm -r scripts/ci-pending
git add .github/workflows/test.yml scripts/ci-pending
git commit -m "ci: build deps before typecheck"
git push
```
