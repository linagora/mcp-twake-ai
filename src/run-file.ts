import { exec, execFile, type ExecException } from 'node:child_process';
import { commandLine } from './catalog.js';

export interface RunOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export type FileRunner = (file: string, args: string[], options?: RunOptions) => Promise<RunResult>;

/**
 * Starts a program without a shell. A .cmd or .bat on Windows (npm.cmd, the npm shim of claude) only starts through
 * cmd.exe: it gets one command line, each argument in double quotes. A failure carries what the program wrote on stderr.
 */
export const runFile: FileRunner = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const settings = { maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: options.timeoutMs ?? 0, ...(options.env ? { env: options.env } : {}) };
    const done = (error: ExecException | null, stdout: string, stderr: string) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    };
    if ((options.platform ?? process.platform) === 'win32' && /\.(cmd|bat)$/i.test(file)) exec(commandLine([file, ...args], 'win32'), settings, done);
    else execFile(file, args, settings, done);
  });
