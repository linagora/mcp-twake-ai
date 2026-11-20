import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliDeps, Io } from '../../src/cli.js';
import { tempPaths } from './tmp.js';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Deps for main(): a fresh TWAKE_AI_HOME and account home, no network, children started as `node --import tsx src/bin.ts …`, their output captured. */
export async function cliDeps(overrides: Partial<CliDeps> = {}): Promise<CliDeps & { root: string }> {
  const { root, paths } = await tempPaths();
  return {
    root,
    paths,
    home: join(root, 'home'),
    accountHome: join(root, 'account'),
    env: { ...process.env, TWAKE_AI_HOME: root, LANG: 'en_US.UTF-8', LC_ALL: '', LC_MESSAGES: '' },
    platform: process.platform,
    interactive: false,
    fetch: (async () => {
      throw new Error('no network in this test');
    }) as typeof fetch,
    resolveSrv: async () => {
      throw new Error('no DNS in this test');
    },
    openUrl: async () => undefined,
    chooseVault: async () => {
      throw new Error('no vault choice in this test');
    },
    now: () => 3_000_000,
    sleep: async () => undefined,
    readLine: async () => '',
    nodePath: process.execPath,
    nodeArgs: ['--import', 'tsx'],
    cliPath: join(repoRoot, 'src', 'bin.ts'),
    childStdio: 'pipe',
    ...overrides,
  };
}

export function captureIo(): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout: (text: string) => {
      io.out += text;
    },
    stderr: (text: string) => {
      io.err += text;
    },
  };
  return io;
}
