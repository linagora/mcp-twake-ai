import { describe, expect, it } from 'vitest';
import { renderBanner, wantsColor } from '../src/banner.js';

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

  it('draws a blue-to-cyan gradient and a grey subtitle', () => {
    const banner = renderBanner({ version: '1.0.0', color: true });
    expect(banner).toContain(`${ESC}38;2;47;107;255m█`);
    expect(banner).toContain(`${ESC}38;2;0;209;193m`);
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
