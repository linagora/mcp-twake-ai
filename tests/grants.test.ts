import { describe, expect, it } from 'vitest';
import { checkAgentId, matrixGrant, matrixKey } from '../src/grants.js';

describe('agent ids', () => {
  it('accepts lowercase ids with digits and dashes', () => {
    expect(checkAgentId('claude-code')).toBe('claude-code');
    expect(matrixGrant('hermes')).toBe('matrix-hermes');
    expect(matrixKey('vscode', 'refresh_token')).toBe('matrix.vscode.refresh_token');
  });

  it('refuses ids that could name another file or key', () => {
    for (const bad of ['Claude Code', '../x', 'a/b', '', '-x', 'x'.repeat(33)]) {
      expect(() => checkAgentId(bad)).toThrow(expect.objectContaining({ code: 'usage' }));
    }
  });
});
