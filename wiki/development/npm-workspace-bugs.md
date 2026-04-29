# npm Workspace Bugs

Two persistent bugs with npm 10 + workspaces in this repo.

## devDependencies Not Installed

`npm install` silently skips devDependencies for workspace packages. This means vite, typescript, `@types/*` won't be available.

**Workaround:** Always use `npm install --include=dev`. The root `package.json` also puts build tools in `dependencies` (not `devDependencies`) as a second defense.

## @types Packages Ghost Install

Even with `--include=dev`, `@types/node` and other `@types/*` packages sometimes report "up to date" but the directory is empty or missing.

**Workaround:** Manual tarball extraction:

```bash
cd /tmp && npm pack @types/node@22
tar -xzf types-node-22.*.tgz
cp -r "node v22.19/"* /path/to/project/node_modules/@types/node/
```

Same pattern for `@types/estree` and any other ghost-installed type packages.

## Why Not Switch to pnpm/yarn

Not investigated yet. These bugs are annoying but have stable workarounds. The workspace structure itself works fine once packages are actually installed.

## Validate `npm publish` locally before bumping

Before bumping the version of any published package (`coordination-games`, etc.) and letting CI publish, inspect the tarball locally:

```bash
cd packages/<pkg> && npm pack --dry-run
# or for full inspection:
npm pack && tar -xzf *.tgz && cat package/package.json | jq .dependencies
```

Cross-check the packed `dependencies` against your bundler config (e.g. `build.cjs`'s `--external` flags). Anything marked external must be in runtime `dependencies`; anything bundled belongs in `devDependencies`. **Workspace `*` packages must never appear in runtime `dependencies`** unless they are themselves published — `npm i -g` will 404 on consumers otherwise.

This was a real footgun: shipped `coordination-games@0.6.0` once with workspace deps in `dependencies`, which made the published version uninstallable. `npm pack --dry-run` would have caught it in seconds. Don't rely on CI to be the first validator.
