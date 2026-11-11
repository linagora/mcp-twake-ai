const ART = [
  '████████╗██╗    ██╗ █████╗ ██╗  ██╗███████╗    █████╗ ██╗',
  '╚══██╔══╝██║    ██║██╔══██╗██║ ██╔╝██╔════╝   ██╔══██╗██║',
  '   ██║   ██║ █╗ ██║███████║█████╔╝ █████╗     ███████║██║',
  '   ██║   ██║███╗██║██╔══██║██╔═██╗ ██╔══╝     ██╔══██║██║',
  '   ██║   ╚███╔███╔╝██║  ██║██║  ██╗███████╗██╗██║  ██║██║',
  '   ╚═╝    ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═╝╚═╝',
];
const FROM = [0x2f, 0x6b, 0xff];
const TO = [0x00, 0xd1, 0xc1];
const GREY = '\x1b[38;2;154;164;181m';
const RESET = '\x1b[0m';

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

/** The banner of `setup` (spec §8): Twake.ai in a blue-to-cyan gradient, or one line on a narrow terminal. */
export function renderBanner(o: { version: string; columns: number; color: boolean }): string {
  if (o.columns < 60) return `\n  ${o.color ? gradient('Twake.ai', 8) : 'Twake.ai'}  v${o.version}\n\n`;
  const width = Math.max(...ART.map((line) => [...line].length));
  const grey = (text: string) => (o.color ? `${GREY}${text}${RESET}` : text);
  const art = ART.map((line) => `  ${o.color ? gradient(line, width) : line}`).join('\n');
  const services = 'Mail · Calendar · Drive · Chat · Space · Project';
  return `\n${art}\n\n  ${grey('Your sovereign Digital Workplace, connected to your AI agent')}\n  ${grey(`${services}${' '.repeat(8)}v${o.version}`)}\n\n`;
}
