'use strict';
// npm run test:e2e:real: the real GoGPS and NVR from .env. See README.md in this folder.
const { spawnSync } = require('node:child_process');

const r = spawnSync('npx', ['playwright', 'test', ...process.argv.slice(2)], { stdio: 'inherit', shell: true, env: { ...process.env, E2E_REAL: '1' } });
process.exit(r.status ?? 1);
