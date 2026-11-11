import { describe, expect, it } from 'vitest';
import { renderBanner, wantsColor } from '../src/banner.js';

const ESC = '\x1b[';

describe('the banner', () => {
  it('draws Twake.ai with a blue-to-cyan gradient and a grey subtitle', () => {
    const banner = renderBanner({ version: '1.0.0', columns: 100, color: true });
    expect(banner).toContain(`${ESC}38;2;47;107;255m█`);
    expect(banner).toContain(`${ESC}38;2;0;209;193m`);
    expect(banner).toContain(`${ESC}38;2;154;164;181mMail · Calendar · Drive · Chat · Space · Project`);
    expect(banner).toContain('v1.0.0');
  });

  it('has no escape sequence without color', () => {
    const banner = renderBanner({ version: '1.0.0', columns: 100, color: false });
    expect(banner).not.toContain('\x1b');
    expect(banner).toContain('████████╗██╗    ██╗');
    expect(banner).toContain('Your sovereign Digital Workplace, connected to your AI agent');
  });

  it('is one line under 60 columns', () => {
    expect(renderBanner({ version: '1.0.0', columns: 59, color: false }).trim()).toBe('Twake.ai  v1.0.0');
  });

  it('is colored only on a terminal, and never with NO_COLOR', () => {
    expect(wantsColor({}, true)).toBe(true);
    expect(wantsColor({}, false)).toBe(false);
    expect(wantsColor({ NO_COLOR: '1' }, true)).toBe(false);
    expect(wantsColor({ NO_COLOR: '' }, true)).toBe(true);
  });
});
