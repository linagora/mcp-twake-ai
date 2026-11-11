#!/usr/bin/env node
// Live test against a real Twake.ai account (spec §13.5): LIVE_EMAIL=jane.doe@company.com node scripts/live.mjs
// Runs the built CLI (npm run build first) in a temporary TWAKE_AI_HOME, so the account already set up here is untouched.
// LIVE_NO_BROWSER=1 signs in with a code instead of the browser.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
function step(name, args, check = () => undefined, { failing = false, live = false, quiet = false } = {}) {
  process.stdout.write(`\n▶ ${name}: mcp-twake-ai ${args.join(' ')}\n`);
  let out = '';
  let failed = false;
  try {
    // live: the output goes straight to the terminal (the sign-in code and URL must show while it waits)
    out = execFileSync(process.execPath, [cli, ...args], { env, stdio: live ? 'inherit' : ['inherit', 'pipe', 'pipe'], encoding: 'utf8' }) ?? '';
  } catch (error) {
    failed = true;
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  // a token never reaches the terminal: steps that print one show a summary instead
  if (!quiet) process.stdout.write(out);
  const problem = failed !== failing ? (failing ? 'it should have failed' : 'it failed') : check(out);
  if (problem) {
    console.error(`\n✗ ${name}: ${problem}`);
    rmSync(home, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`✓ ${name}`);
  return out;
}

const token = (out) => {
  const parsed = JSON.parse(out);
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) return 'no access_token';
  if (!(parsed.expires_at > Date.now() / 1000)) return 'expires_at is not in the future';
  // what the token is for, never the token itself
  const claims = JSON.parse(Buffer.from(parsed.access_token.split('.')[1] ?? '', 'base64url').toString() || '{}');
  console.log(`  access_token ****, expires_at ${new Date(parsed.expires_at * 1000).toISOString()}, aud ${JSON.stringify(claims.aud ?? '?')}`);
  return undefined;
};

/** One light authenticated call per backend: does it accept the token (its audience)? */
async function backend(service, url, accessToken) {
  const auth = { authorization: `Bearer ${accessToken}` };
  const base = url.replace(/\/+$/, '');
  const request =
    service === 'mail' ? fetch(url, { headers: { ...auth, accept: 'application/json' } })
    : service === 'dav' ? fetch(new URL('calendars/', url), { method: 'PROPFIND', headers: { ...auth, depth: '0' } })
    : fetch(`${base}/api/${service === 'space' ? 'spaces' : 'projects'}`, { headers: { ...auth, accept: 'application/json' } });
  try {
    const answer = await request;
    return { service, ok: answer.status >= 200 && answer.status < 300, status: answer.status };
  } catch (error) {
    return { service, ok: false, status: String(error.cause?.code ?? error.message) };
  }
}

/** Starts mcp-twake-dav over stdio and calls its read-only list_calendars tool: does the calendar answer through it? */
function listCalendars(davEnv, version) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['-y', `mcp-twake-dav@${version}`], { env: { ...env, ...davEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    const done = (ok, status) => {
      clearTimeout(timer);
      child.kill();
      resolve({ service: 'dav MCP', ok, status });
    };
    const timer = setTimeout(() => done(false, 'no answer within 120 s'), 120_000);
    let buffer = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => done(false, `exited with ${code}: ${stderr.trim().split('\n').at(-1) ?? ''}`));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_calendars', arguments: {} } })}\n`);
        } else if (message.id === 2) {
          const text = message.result?.content?.map((part) => part.text ?? '').join(' ') ?? JSON.stringify(message.error);
          // how much came back, not what: calendar names stay off the terminal
          done(!message.error && !message.result?.isError, message.error || message.result?.isError ? `list_calendars failed: ${text.slice(0, 300)}` : `list_calendars answered (${text.length} characters)`);
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-twake-ai-live', version: '1' } } })}\n`,
    );
  });
}

step('sign in', ['login','--email', email, ...(process.env.LIVE_NO_BROWSER === '1' ? ['--no-browser'] : [])], undefined, { live: true });
const services = JSON.parse(readFileSync(join(home, 'config', 'config.json'), 'utf8')).environment.services;
const backends = [];
for (const service of ['mail', 'dav', 'space', 'project']) {
  const out = step(`token ${service}`, ['token', service], token, { quiet: true });
  if (services[service]?.url) backends.push(await backend(service, services[service].url, JSON.parse(out).access_token));
}
for (const check of backends) console.log(`${check.ok ? '✓' : '✗'} ${check.service} backend: HTTP ${check.status}${check.ok ? ', token accepted' : ', token refused (audience or rights?)'}`);
// where else the calendar may take the token: the Twake Calendar side service, which publishes DAV under /dav/
// (LIVE_DAV_CANDIDATES=url,url to try others)
if (backends.some((check) => check.service === 'dav' && !check.ok)) {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  const candidates = (process.env.LIVE_DAV_CANDIDATES ?? `https://twcalendar.${domain}/dav/`).split(',').filter(Boolean);
  const accessToken = JSON.parse(step('token dav (candidates)', ['token', 'dav'], token, { quiet: true })).access_token;
  for (const candidate of candidates) {
    const base = candidate.replace(/\/+$/, '');
    const probes = [
      ['PROPFIND', `${base}/calendars/`],
      ['GET', `${new URL(base).origin}/api/user`],
    ];
    for (const [method, url] of probes) {
      const answer = await fetch(url, { method, headers: { authorization: `Bearer ${accessToken}`, depth: '0', accept: 'application/json' } }).catch((error) => ({ status: String(error.cause?.code ?? error.message) }));
      void answer.body?.cancel?.();
      console.log(`  ${typeof answer.status === 'number' && answer.status < 300 ? '✓' : '✗'} candidate ${method} ${url}: HTTP ${answer.status}`);
    }
  }
}
// the calendar end to end: the DAV MCP itself, with the environment the agents get, lists the calendars (read only).
// LIVE_DAV_VERSION picks the published mcp-twake-dav (4.2.1 is the catalog's pin once published)
const davEnv = Object.fromEntries(
  step('dav environment', ['status', '--print-env', 'dav'])
    .trim()
    .split('\n')
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);
backends.push(await listCalendars(davEnv, process.env.LIVE_DAV_VERSION ?? '4.2.0'));
console.log(`${backends.at(-1).ok ? '✓' : '✗'} dav MCP: ${backends.at(-1).status}`);
step('status', ['status', '--no-start'],(out) => (out.includes('✓ Twake session') ? undefined : 'the session is not ✓'));
// the refresh token before logout, to check afterwards that the identity provider itself refuses it (spec §13.5)
const config = JSON.parse(readFileSync(join(home, 'config', 'config.json'), 'utf8'));
const refresh = JSON.parse(readFileSync(join(home, 'config', 'secrets.json'), 'utf8'))['oidc.refresh_token'];
step('logout', ['logout'], (out) => (out.includes('✓ Twake session revoked') ? undefined : 'the session was not revoked'));
process.stdout.write('\n▶ the identity provider refuses the revoked refresh token\n');
const answer = await fetch(config.environment.oidc.token_endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: config.oidc.clientId }),
});
const body = await answer.json().catch(() => ({}));
if (answer.ok || body.error !== 'invalid_grant') {
  console.error(`✗ the refresh token still works after logout (HTTP ${answer.status}, ${body.error ?? 'no error'})`);
  rmSync(home, { recursive: true, force: true });
  process.exit(1);
}
console.log('✓ the identity provider refuses the revoked refresh token (invalid_grant)');
step('token after logout', ['token', 'mail'], (out) => (out.includes('mcp-twake-ai login') ? undefined : 'it does not ask to sign in again'), { failing: true });
rmSync(home, { recursive: true, force: true });
const refused = backends.filter((check) => !check.ok);
if (refused.length > 0) {
  console.error(`\n✗ the token was refused by: ${refused.map((check) => `${check.service} (HTTP ${check.status})`).join(', ')}`);
  process.exit(1);
}
console.log('\nAll live steps passed.');
