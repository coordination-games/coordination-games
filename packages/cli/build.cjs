#!/usr/bin/env node
const { execSync } = require('child_process');
const { version } = require('./package.json');

execSync([
  'npx esbuild src/index.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--outfile=dist/index.cjs',
  "--banner:js='#!/usr/bin/env node'",
  '--external:better-sqlite3',
  '--external:@modelcontextprotocol/sdk',
  '--external:zod',
  `--define:COGA_VERSION='"${version}"'`,
].join(' '), { stdio: 'inherit' });
