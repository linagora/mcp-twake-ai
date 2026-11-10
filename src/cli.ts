import { readFileSync } from 'node:fs';

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const processIo: Io = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

const USAGE = `usage:
  twake-ai --version
`;

export async function main(argv: string[], io: Io): Promise<number> {
  const [command] = argv;
  if (command === '--version' || command === '-v') {
    io.stdout(`${packageVersion()}\n`);
    return 0;
  }
  io.stderr(USAGE);
  return 2;
}
