import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isSupportedNode, REQUIRED_NODE } from '../src/node-version.js';

describe('the Node version check', () => {
  it('accepts Node 22.13 and later only', () => {
    expect(REQUIRED_NODE).toBe('22.13');
    expect(isSupportedNode('22.13.0')).toBe(true);
    expect(isSupportedNode('24.1.0')).toBe(true);
    expect(isSupportedNode('22.12.9')).toBe(false);
    expect(isSupportedNode('18.19.1')).toBe(false);
  });

  it('runs before anything is loaded: an old Node fails while loading the dependencies', async () => {
    const bin = await readFile(new URL('../src/bin.ts', import.meta.url), 'utf8');
    expect(bin).not.toMatch(/^import .*from '\.\/cli\.js'/m);
    expect(bin).toContain("await import('./cli.js')");
  });
});
