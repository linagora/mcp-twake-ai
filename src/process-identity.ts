import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * What tells a process from the next one that gets its pid: the moment it started, as the system records it. A pid alone
 * is reused (soon on Windows; within one boot everywhere), and so is anything written about it in a file; the start
 * time of the process that has the pid now is read from the system, and compared with the one read when it was spawned.
 *
 * The value is opaque and only compared for equality: the raw field on Linux, ps's text on macOS and the BSDs, a
 * FILETIME on Windows. Undefined when it cannot be read (the process is gone, or the tool is missing): the caller then
 * proves nothing, and kills nothing.
 */
export async function processIdentity(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (platform === 'linux') return parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
    if (platform === 'win32') {
      const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`;
      return parseWindowsStart(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]));
    }
    // a fixed locale and zone: the text must read the same at every look
    return parsePsStart(await run('ps', ['-o', 'lstart=', '-p', String(pid)], { LC_ALL: 'C', TZ: 'UTC' }));
  } catch {
    return undefined;
  }
}

function run(command: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000, windowsHide: true, env: { ...process.env, ...env } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/**
 * Field 22 of /proc/<pid>/stat: the start time, in clock ticks since boot. The command name (field 2, in parentheses)
 * may itself hold spaces and parentheses: the fields are counted after its last ')'.
 */
export function parseProcStat(text: string): string | undefined {
  const end = text.lastIndexOf(')');
  if (end < 0) return undefined;
  // field 3 (the state) is the first after the name
  const value = text.slice(end + 1).trim().split(/\s+/)[22 - 3];
  return value && /^\d+$/.test(value) ? value : undefined;
}

/** `ps -o lstart=`: a date, or nothing when there is no such process. */
export function parsePsStart(text: string): string | undefined {
  return text.trim() || undefined;
}

/** `(Get-Process).StartTime.ToFileTimeUtc()`: a number, or an error message when there is no such process. */
export function parseWindowsStart(text: string): string | undefined {
  const value = text.trim();
  return /^\d+$/.test(value) ? value : undefined;
}
