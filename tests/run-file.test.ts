import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFile } from '../src/run-file.js';
import { tempDir } from './helpers/tmp.js';

const PRINT_ARGS = 'process.stdout.write(JSON.stringify(process.argv.slice(2)))';

describe('runFile', () => {
  it('passes arguments as they are, spaces and quotes included', async () => {
    const script = join(await tempDir(), 'print args.cjs');
    await writeFile(script, PRINT_ARGS);
    const { stdout } = await runFile(process.execPath, [script, 'a b', "o'brien"]);
    expect(JSON.parse(stdout)).toEqual(['a b', "o'brien"]);
  });

  it('keeps what the program wrote on stderr when it fails', async () => {
    const script = join(await tempDir(), 'fail.cjs');
    await writeFile(script, "process.stderr.write('boom\\n'); process.exit(3)");
    await expect(runFile(process.execPath, [script])).rejects.toMatchObject({ stderr: 'boom\n' });
  });

  it.runIf(process.platform === 'win32')('starts a .cmd through cmd.exe, with spaces in the paths', async () => {
    const dir = join(await tempDir(), 'bin dir');
    await mkdir(dir);
    const script = join(dir, 'print.cjs');
    await writeFile(script, PRINT_ARGS);
    const shim = join(dir, 'print.cmd');
    await writeFile(shim, `@"${process.execPath}" "${script}" %*\r\n`);
    const { stdout } = await runFile(shim, ['a b', 'c']);
    expect(JSON.parse(stdout)).toEqual(['a b', 'c']);
  });
});
