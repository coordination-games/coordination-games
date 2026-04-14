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
