# Biome — lint + format

Biome is the single linter and formatter for the workspace. Config lives in `biome.json` at the repo root and applies to every package.

## npm scripts (root)

- `npm run lint` — lint only (`biome lint .`)
- `npm run format` — format files in place (`biome format --write .`)
- `npm run check` — lint + format + import sorting in one pass (`biome check .`); add `--write` to auto-fix

`npm run check` is the script CI runs (Phase 2.4). It exits non-zero on any diagnostic.

## VS Code

1. Install the official extension — ID `biomejs.biome`.
2. Add to workspace settings (`.vscode/settings.json`):

```jsonc
{
  "editor.defaultFormatter": "biomejs.biome",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "quickfix.biome": "explicit",
    "source.organizeImports.biome": "explicit"
  },
  "[typescript]": { "editor.defaultFormatter": "biomejs.biome" },
  "[typescriptreact]": { "editor.defaultFormatter": "biomejs.biome" },
  "[javascript]": { "editor.defaultFormatter": "biomejs.biome" },
  "[json]": { "editor.defaultFormatter": "biomejs.biome" }
}
```

That gives you format-on-save, autofix-on-save, and import organize-on-save. Disable any other JS/TS formatter (Prettier, ESLint formatter) to avoid conflicts.

## Other editors

See https://biomejs.dev/guides/editors/ — first-party plugins exist for Zed, IntelliJ, Neovim, Helix, etc. All read `biome.json` automatically.
