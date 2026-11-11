import { describe, expect, it } from 'vitest';
import { logoColor, renderBanner, wantsColor } from '../src/banner.js';

const ESC = '\x1b[';
const SETS_UP = 'Sets up the MCP servers of the Twake.ai platform in your AI agents.';
const artLines = (banner: string) => banner.split('\n').filter((line) => /[█╚]/.test(line));

describe('the banner', () => {
  it('puts MCP above TWAKE.AI', () => {
    const art = artLines(renderBanner({ version: '1.0.0', color: false }));
    expect(art).toHaveLength(12);
    expect(art[0]).toBe('  ███╗   ███╗ ██████╗██████╗');
    expect(art[6]).toBe('  ████████╗██╗    ██╗ █████╗ ██╗  ██╗███████╗    █████╗ ██╗');
  });

  it('says what it is: the setup of the Twake.ai MCP servers', () => {
    const banner = renderBanner({ version: '1.0.0', color: false });
    expect(banner).toContain('Your sovereign Digital Workplace, connected to your AI agent');
    expect(banner).toContain(SETS_UP);
    expect(banner).toContain('Mail · Calendar · Drive · Chat · Space · Project');
    expect(banner).toContain('v1.0.0');
  });

  it('takes the colors of the Twake logo: green, blue, purple at the top, yellow and red at the bottom', () => {
    expect(logoColor(0, 0)).toEqual([0x4f, 0xb5, 0x00]);
    expect(logoColor(1, 0)).toEqual([0xa0, 0x33, 0xff]);
    expect(logoColor(0, 1)).toEqual([0xff, 0xc7, 0x00]);
    expect(logoColor(1, 1)).toEqual([0xe7, 0x3b, 0x2d]);
  });

  it('colors the letters like the logo, from its top-left corner to its bottom-right one, with a grey subtitle', () => {
    const banner = renderBanner({ version: '1.0.0', color: true });
    // the first letter of MCP takes the green of the logo, the last one of TWAKE.AI its red, both softened with 25 % white
    expect(banner).toContain(`  ${ESC}38;2;123;200;64m█`);
    const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');
    const lastArtLine = banner.split('\n').filter((line) => plain(line).includes('╚═╝')).at(-1)!;
    expect(lastArtLine).toContain(`${ESC}38;2;237;108;98m╝`);
    expect(banner).toContain(`${ESC}38;2;154;164;181m${SETS_UP}`);
  });

  it('has no escape sequence without color', () => {
    expect(renderBanner({ version: '1.0.0', color: false })).not.toContain('\x1b');
  });

  it('is colored only on a terminal, and never with NO_COLOR', () => {
    expect(wantsColor({}, true)).toBe(true);
    expect(wantsColor({}, false)).toBe(false);
    expect(wantsColor({ NO_COLOR: '1' }, true)).toBe(false);
    expect(wantsColor({ NO_COLOR: '' }, true)).toBe(true);
  });
});
