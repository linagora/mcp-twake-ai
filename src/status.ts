import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { fingerprint } from './agents/entries.js';
import type { AgentAdapter, Entry } from './agents/types.js';
import { getToken, isServiceId, type BrokerDeps, type ServiceId } from './broker.js';
import { describeError } from './describe.js';
import { requestJson } from './http.js';
import { fetchUserinfo } from './oidc.js';

export interface Check {
  ok: boolean;
  detail: string;
}

const failed = (error: unknown): Check => ({ ok: false, detail: describeError(error) });

/** The Twake session: a token, then userinfo (spec §12.2). */
export async function checkSession(d: BrokerDeps): Promise<Check> {
  try {
    const token = await getToken('mail', d);
    const info = await fetchUserinfo(d.config.environment.oidc, token.access_token, d.http);
    return { ok: true, detail: String(info.email ?? info.sub ?? d.config.email) };
  } catch (error) {
    return failed(error);
  }
}

/** Twake Drive: a token, then /settings/instance. */
export async function checkDrive(d: BrokerDeps): Promise<Check> {
  try {
    const token = await getToken('drive', d);
    const instance = d.config.environment.cozy.instance ?? '';
    await requestJson(`${instance.replace(/\/$/, '')}/settings/instance`, { headers: { authorization: `Bearer ${token.access_token}` } }, d.http);
    return { ok: true, detail: instance };
  } catch (error) {
    return failed(error);
  }
}

/** The Twake Chat device of one agent: a token, then /account/whoami. */
export async function checkChat(d: BrokerDeps, agent: string): Promise<Check> {
  try {
    const token = await getToken('chat', d, agent);
    const homeserver = d.config.environment.matrix.homeserver.replace(/\/$/, '');
    const who = z.object({ user_id: z.string() }).parse(await requestJson(`${homeserver}/_matrix/client/v3/account/whoami`, { headers: { authorization: `Bearer ${token.access_token}` } }, d.http));
    return { ok: true, detail: `${who.user_id} (device ${token.device_id})` };
  } catch (error) {
    return failed(error);
  }
}

/** Starts an agent's entry as the agent would, asks initialize then tools/list, and stops it (spec §12.2, point 4). */
export function handshake(entry: { command: string; args: string[]; env?: Record<string, string> }, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<Check> {
  return new Promise((resolve) => {
    const child = spawn(entry.command, entry.args, { env: { ...env, ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (check: Check) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(check);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: `no answer within ${timeoutMs / 1000} s` }), timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => finish({ ok: false, detail: error.message }));
    child.once('exit', (code) => finish({ ok: false, detail: stderr.trim().split('\n').at(-1) || `the server stopped (exit code ${code})` }));
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: { id?: unknown; error?: { message?: string }; result?: { tools?: unknown[] } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (message.error) return finish({ ok: false, detail: message.error.message ?? 'error' });
      if (message.id === 1) {
        send({ method: 'notifications/initialized' });
        send({ id: 2, method: 'tools/list', params: {} });
      } else if (message.id === 2) {
        finish({ ok: true, detail: `${message.result?.tools?.length ?? 0} tools` });
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-twake-ai status', version: '1' } } });
  });
}

/** The service an entry name stands for: twake-mail, twake_mail → mail. */
export function serviceOfEntry(name: string): ServiceId | undefined {
  const service = /^twake[-_](\w+)$/.exec(name)?.[1];
  return service && isServiceId(service) ? service : undefined;
}

export interface EntryState {
  name: string;
  service: ServiceId;
  state: 'ok' | 'missing' | 'modified' | 'foreign' | 'no-node';
  entry?: Entry;
}

/** Each Twake.ai entry of an agent, against the fingerprints mcp-twake-ai noted and the node it starts. */
export async function entryStates(adapter: AgentAdapter, owned: Record<string, string>): Promise<EntryState[]> {
  const current = await adapter.read();
  const names = new Set([...Object.keys(owned), ...Object.keys(current).filter((name) => serviceOfEntry(name) !== undefined)]);
  const states: EntryState[] = [];
  for (const name of [...names].sort()) {
    const service = serviceOfEntry(name);
    if (!service) continue;
    const entry = current[name];
    if (entry === undefined) {
      states.push({ name, service, state: 'missing' });
      continue;
    }
    let state: EntryState['state'] = owned[name] === undefined ? 'foreign' : fingerprint(entry) === owned[name] ? 'ok' : 'modified';
    if (state === 'ok') {
      try {
        if (!(await stat(String(entry.command))).isFile()) state = 'no-node';
      } catch {
        state = 'no-node';
      }
    }
    states.push({ name, service, state, entry });
  }
  return states;
}
