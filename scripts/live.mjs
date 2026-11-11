#!/usr/bin/env node
// Live test against a real Twake.ai account (spec §13.5): LIVE_EMAIL=jane.doe@company.com node scripts/live.mjs
// Runs the built CLI (npm run build first) in a temporary TWAKE_AI_HOME, so the account already set up here is untouched.
// LIVE_NO_BROWSER=1 signs in with a code instead of the browser.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const email = process.env.LIVE_EMAIL;
if (!email) {
  console.error('Set LIVE_EMAIL to the address of a Twake.ai account: LIVE_EMAIL=jane.doe@company.com node scripts/live.mjs');
  process.exit(2);
}
const cli = fileURLToPath(new URL('../build/bin.js', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'mcp-twake-ai-live-'));
const env = { ...process.env, TWAKE_AI_HOME: home, TWAKE_AI_VAULT: 'file' };

/** Runs one step; stops the whole test, naming the step, when it fails or its output is not as expected. */
function step(name, args, check = () => undefined, { failing = false } = {}) {
  process.stdout.write(`\n▶ ${name}: mcp-twake-ai ${args.join(' ')}\n`);
  let out = '';
  let failed = false;
  try {
    out = execFileSync(process.execPath, [cli, ...args], { env, stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (error) {
    failed = true;
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  process.stdout.write(out);
  const problem = failed !== failing ? (failing ? 'it should have failed' : 'it failed') : check(out);
  if (problem) {
    console.error(`\n✗ ${name}: ${problem}`);
    rmSync(home, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`✓ ${name}`);
}

const token = (out) => {
  const parsed = JSON.parse(out);
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) return 'no access_token';
  if (!(parsed.expires_at > Date.now() / 1000)) return 'expires_at is not in the future';
  return undefined;
};

step('sign in', ['login', '--email', email, ...(process.env.LIVE_NO_BROWSER === '1' ? ['--no-browser'] : [])]);
for (const service of ['mail', 'dav', 'space', 'project']) step(`token ${service}`, ['token', service], token);
step('status', ['status', '--no-start'], (out) => (out.includes('✓ Twake session') ? undefined : 'the session is not ✓'));
step('logout', ['logout'], (out) => (out.includes('✓ Twake session revoked') ? undefined : 'the session was not revoked'));
step('token after logout', ['token', 'mail'], (out) => (out.includes('mcp-twake-ai login') ? undefined : 'it does not ask to sign in again'), { failing: true });
rmSync(home, { recursive: true, force: true });
console.log('\nAll live steps passed.');
