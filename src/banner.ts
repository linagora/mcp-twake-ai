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

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16)) as Rgb;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((value, k) => value + (b[k]! - value) * t) as Rgb;
const clamp = (t: number) => Math.min(1, Math.max(0, t));
/** Where a point falls along a gradient line from `from` to `to` (0 at from, 1 at to), as SVG measures it. */
const along = (x: number, y: number, from: [number, number], to: [number, number]) =>
  ((x - from[0]) * (to[0] - from[0]) + (y - from[1]) * (to[1] - from[1])) / ((to[0] - from[0]) ** 2 + (to[1] - from[1]) ** 2);

const GREEN = rgb('#4FB500');
const BLUE = rgb('#0094FF');
const PURPLE = rgb('#A033FF');

/**
 * The color of the Twake logo at (u, v), both from 0 to 1 across its square (assets/twake-logo.svg, 96×96): a base
 * gradient purple → blue → green from right to left, a yellow veil rising from the bottom left, a red one from the
 * bottom right, painted in that order.
 */
export function logoColor(u: number, v: number): Rgb {
  const x = u * 96;
  const y = v * 96;
  const t = clamp(along(x, y, [96, 56], [0, 56]));
  let color = t <= 0.12998 ? PURPLE : t <= 0.610381 ? mix(PURPLE, BLUE, (t - 0.12998) / (0.610381 - 0.12998)) : mix(BLUE, GREEN, (t - 0.610381) / (1 - 0.610381));
  const yellow = clamp(along(x, y, [44, 30], [14, 90]) / 0.563347);
  color = mix(color, mix(rgb('#FFD600'), rgb('#FFC700'), yellow), yellow);
  const red = clamp((along(x, y, [52, 56], [86, 92]) - 0.0297327) / (0.842824 - 0.0297327));
  color = mix(color, mix(rgb('#FF3B30'), rgb('#E73B2D'), red), red);
  return color.map(Math.round) as Rgb;
}

const GREY = '\x1b[38;2;154;164;181m';
const RESET = '\x1b[0m';
const INDENT = '  ';

/** Colored on a terminal, unless NO_COLOR is set to anything (https://no-color.org). */
export function wantsColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  return isTTY && !env.NO_COLOR;
}


/** The banner of setup (spec §8): MCP above TWAKE.AI, each letter in the color of the Twake logo at the same place. */
export function renderBanner(o: { version: string; color: boolean }): string {
  const rows = [...word('MCP'), '', ...word('TWAKE.AI')];
  const width = Math.max(...rows.map((row) => [...row].length));
  const paint = (row: string, r: number) =>
    [...row]
      .map((char, c) => {
        if (char === ' ') return char;
        const [red, green, blue] = logoColor(c / (width - 1), r / (rows.length - 1));
        return `\x1b[38;2;${red};${green};${blue}m${char}`;
      })
      .join('') + RESET;
  const art = rows.map((row, r) => (row === '' ? '' : `${INDENT}${o.color ? paint(row, r) : row}`)).join('\n');
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
