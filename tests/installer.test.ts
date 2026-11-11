import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureInstalled, entryPoint, installedVersion, npmFailure, npmRunner, serverDir } from '../src/installer.js';
import { fakeNpm, installFakeMcp } from './helpers/fake-mcp.js';
import { tempPaths } from './helpers/tmp.js';

describe('ensureInstalled', () => {
  it('installs the missing servers at their pinned versions, allowing the sqlite3 build of mcp-twake-chat', async () => {
    const { paths } = await tempPaths();
    const npm = fakeNpm(paths);
    const lines: string[] = [];
    expect(await ensureInstalled(paths, ['mail', 'chat', 'mail'], { run: npm, print: (line) => lines.push(line) })).toEqual([
      'mcp-twake-mail@4.2.0',
      'mcp-twake-chat@0.6.1',
    ]);
    expect(npm.calls).toEqual([
      // one folder per server: hoisted together, matrix-js-sdk's @babel/runtime 8 broke cozy-client (mcp-twake-drive)
      ['install', '--prefix', serverDir(paths, 'mcp-twake-mail'), '--no-audit', '--no-fund', '--save-exact', 'mcp-twake-mail@4.2.0'],
      ['install', '--prefix', serverDir(paths, 'mcp-twake-chat'), '--no-audit', '--no-fund', '--save-exact', 'mcp-twake-chat@0.6.1'],
    ]);
    // npm 11 refuses --allow-scripts for a project: the prefix's package.json allows sqlite3's build instead
    expect(JSON.parse(await readFile(join(serverDir(paths, 'mcp-twake-chat'), 'package.json'), 'utf8'))).toMatchObject({ private: true, allowScripts: { sqlite3: true } });
    expect(lines.join('\n')).toContain('mcp-twake-chat@0.6.1');
    expect(await installedVersion(paths, 'mcp-twake-chat')).toBe('0.6.1');
  });

  it('does nothing when everything is installed, and replaces another version', async () => {
    const { paths } = await tempPaths();
    await installFakeMcp(paths, 'mail');
    await installFakeMcp(paths, 'dav', undefined, '4.0.0');
    const npm = fakeNpm(paths);
    expect(await ensureInstalled(paths, ['mail', 'dav'], { run: npm, print: () => undefined })).toEqual(['mcp-twake-dav@4.2.1']);
    expect(await ensureInstalled(paths, ['mail', 'dav'], { run: npm, print: () => undefined })).toEqual([]);
    expect(npm.calls).toHaveLength(1);
  });
});

describe('entryPoint', () => {
  it("resolves the package's command", async () => {
    const { paths } = await tempPaths();
    await installFakeMcp(paths, 'project');
    expect(await entryPoint(paths, 'project')).toBe(join(serverDir(paths, 'mcp-twake-project'), 'node_modules', 'mcp-twake-project', 'build', 'index.js'));
  });

  it('says how to install a missing server', async () => {
    const { paths } = await tempPaths();
    await expect(entryPoint(paths, 'space')).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('mcp-twake-space') });
  });
});

describe('npmFailure', () => {
  it("keeps npm's error lines, not the pointer to its log file", () => {
    const stderr = [
      'npm error code EALLOWSCRIPTS',
      'npm error --allow-scripts is not allowed in project-scoped installs.',
      'npm error A complete log of this run can be found in: /home/j/.npm/_logs/x-debug-0.log',
    ].join('\n');
    expect(npmFailure(stderr)).toBe('code EALLOWSCRIPTS — --allow-scripts is not allowed in project-scoped installs.');
    expect(npmFailure('something odd\n')).toBe('something odd');
  });
});

describe('npmRunner', () => {
  // npm is npm.cmd on Windows, started through cmd.exe: a folder with a space in its name must stay one argument
  it('passes arguments that hold spaces, on every OS', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'npm prefix '));
    const script = join(dir, 'write.cjs');
    await writeFile(script, "require('node:fs').writeFileSync(process.argv[2], 'ok')");
    await npmRunner(process.execPath, [script, join(dir, 'out file')]);
    expect(await readFile(join(dir, 'out file'), 'utf8')).toBe('ok');
  });

  it('reports the npm error when the command fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'npm prefix '));
    const script = join(dir, 'fail.cjs');
    await writeFile(script, "process.stderr.write('npm error code E404\\nnpm error 404 Not Found - mcp-twake-mail@9.9.9\\n'); process.exit(1)");
    await expect(npmRunner(process.execPath, [script])).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('404 Not Found') });
  });
});
