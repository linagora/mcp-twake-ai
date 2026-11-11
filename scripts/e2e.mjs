#!/usr/bin/env node
// npm run test:e2e: the end-to-end tests, with the real Claude Code when it is installed (MCP_TWAKE_AI_E2E=1).
// A Node script rather than `VAR=1 vitest`, which cmd.exe (npm's shell on Windows) cannot run.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const run = spawnSync(process.execPath, [vitest, 'run', 'tests/e2e'], { env: { ...process.env, MCP_TWAKE_AI_E2E: '1' }, stdio: 'inherit' });
process.exit(run.status ?? 1);
