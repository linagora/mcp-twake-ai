import { join } from 'node:path';
import type { AppPaths } from '../../src/paths.js';
import { sharedChatFiles, type SharedChatDeps } from '../../src/shared-chat.js';

export const AGENT = 'claude-code';

/** The environment of the shared mode as `run chat` builds it, for the device of the moment, with the store under it. */
export function sharedDeps(
  paths: AppPaths,
  options: { device?: () => string; extra?: Record<string, string>; readyMs?: number; stderr?: string[] } = {},
): SharedChatDeps {
  const files = sharedChatFiles(paths, AGENT);
  const device = () => options.device?.() ?? 'DEVICEONE';
  return {
    paths,
    env: process.env,
    nodePath: process.execPath,
    buildEnv: async () => ({
      ...(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>),
      MATRIX_USER_ID: '@jdoe:linagora.com',
      MATRIX_STORE_DIR: join(paths.dataDir, 'chat', AGENT, device()),
      MCP_TRANSPORT: 'http',
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_PORT: '0',
      MCP_HTTP_STATE_FILE: files.state,
      // a server a failed test leaves behind goes on its own
      MCP_HTTP_EXIT_WHEN_IDLE_MS: '60000',
      ...options.extra,
    }),
    deviceId: async () => device(),
    stderr: (text) => void options.stderr?.push(text),
    readyMs: options.readyMs,
  };
}
