import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseProcStat, parsePsStart, parseWindowsStart, processIdentity } from '../src/process-identity.js';

describe('the identity of a process', () => {
  it('reads the start time of /proc/<pid>/stat, whatever the command name holds', () => {
    // field 22 is the start time; the name (field 2) may hold spaces and parentheses
    const after = ['S', ...Array.from({ length: 18 }, (_, i) => String(i + 4)), '1552075692', '5976064', '440'];
    expect(parseProcStat(`1234 (node) ${after.join(' ')}\n`)).toBe('1552075692');
    expect(parseProcStat(`1234 (a (b) c)) ${after.join(' ')}\n`)).toBe('1552075692');
    expect(parseProcStat('1234 (node) S 1 2')).toBeUndefined();
    expect(parseProcStat('')).toBeUndefined();
  });

  it('reads the start time ps prints on macOS', () => {
    expect(parsePsStart('Fri Nov 20 09:40:15 2026\n')).toBe('Fri Nov 20 09:40:15 2026');
    expect(parsePsStart('   \n')).toBeUndefined();
  });

  it('reads the start time PowerShell prints on Windows', () => {
    expect(parseWindowsStart('134081436151234567\r\n')).toBe('134081436151234567');
    expect(parseWindowsStart('Get-Process : Cannot find a process with the process identifier 4242.')).toBeUndefined();
  });

  it('tells one process from another, and stays the same for one', { timeout: 30_000 }, async () => {
    const mine = await processIdentity(process.pid);
    expect(mine).toBeTruthy();
    expect(await processIdentity(process.pid)).toBe(mine);
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    try {
      // a second apart at least on macOS, whose ps counts in seconds
      await new Promise((resolve) => setTimeout(resolve, process.platform === 'darwin' ? 1_100 : 50));
      const theirs = await processIdentity(other.pid!);
      expect(theirs).toBeTruthy();
      if (process.platform !== 'darwin') expect(theirs).not.toBe(mine);
    } finally {
      other.kill('SIGKILL');
    }
  });

  it('has none for a process that does not exist', async () => {
    expect(await processIdentity(2 ** 22 + 12345)).toBeUndefined();
  });
});
