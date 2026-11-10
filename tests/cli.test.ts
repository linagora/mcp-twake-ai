import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.js';

function captureIo(): Io & { out: string; err: string } {
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

const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

describe('main', () => {
  it('prints the package version', async () => {
    const io = captureIo();
    expect(await main(['--version'], io)).toBe(0);
    expect(io.out).toBe(`${version}\n`);
  });

  it('prints the usage on stderr and exits 2 for an unknown command', async () => {
    const io = captureIo();
    expect(await main(['frobnicate'], io)).toBe(2);
    expect(io.err).toMatch(/usage:/);
    expect(io.out).toBe('');
  });
});
