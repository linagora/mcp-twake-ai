/** The letters of the banner, in the figlet font "ANSI Shadow": 6 rows each, every row of a letter the same width. */
const GLYPHS: Record<string, string[]> = {
  M: ['███╗   ███╗', '████╗ ████║', '██╔████╔██║', '██║╚██╔╝██║', '██║ ╚═╝ ██║', '╚═╝     ╚═╝'],
  C: [' ██████╗', '██╔════╝', '██║     ', '██║     ', '╚██████╗', ' ╚═════╝'],
  P: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔═══╝ ', '██║     ', '╚═╝     '],
  T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
  W: ['██╗    ██╗', '██║    ██║', '██║ █╗ ██║', '██║███╗██║', '╚███╔███╔╝', ' ╚══╝╚══╝ '],
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  K: ['██╗  ██╗', '██║ ██╔╝', '█████╔╝ ', '██╔═██╗ ', '██║  ██╗', '╚═╝  ╚═╝'],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  '.': ['   ', '   ', '   ', '   ', '██╗', '╚═╝'],
  I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
};

const word = (text: string) => GLYPHS.M!.map((_, row) => [...text].map((letter) => GLYPHS[letter]![row]).join('').trimEnd());

const FROM = [0x2f, 0x6b, 0xff];
const TO = [0x00, 0xd1, 0xc1];
const GREY = '\x1b[38;2;154;164;181m';
const RESET = '\x1b[0m';
const INDENT = '  ';

/** Colored on a terminal, unless NO_COLOR is set to anything (https://no-color.org). */
export function wantsColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  return isTTY && !env.NO_COLOR;
}

function gradient(line: string, width: number): string {
  return (
    [...line]
      .map((char, i) => {
        if (char === ' ') return char;
        const t = width > 1 ? i / (width - 1) : 0;
        const [r, g, b] = FROM.map((from, k) => Math.round(from + (TO[k]! - from) * t));
        return `\x1b[38;2;${r};${g};${b}m${char}`;
      })
      .join('') + RESET
  );
}

/** The banner of setup (spec §8): MCP above TWAKE.AI in a blue-to-cyan gradient, whatever the width of the terminal. */
export function renderBanner(o: { version: string; color: boolean }): string {
  const blocks = [word('MCP'), word('TWAKE.AI')];
  // one gradient for both blocks, so that the colors line up from one block to the next
  const width = Math.max(...blocks.map((block) => [...block[0]!].length));
  const art = blocks.map((block) => block.map((line) => `${INDENT}${o.color ? gradient(line, width) : line}`).join('\n')).join('\n\n');
  const grey = (text: string) => (o.color ? `${GREY}${text}${RESET}` : text);
  return [
    '',
    art,
    '',
    `${INDENT}${grey('Your sovereign Digital Workplace, connected to your AI agent')}`,
    `${INDENT}${grey('Sets up the MCP servers of the Twake.ai platform in your AI agents.')}`,
    `${INDENT}${grey(`Mail · Calendar · Drive · Chat · Space · Project${' '.repeat(8)}v${o.version}`)}`,
    '',
    '',
  ].join('\n');
}
