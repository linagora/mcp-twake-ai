import { describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.js';
import { sampleConfig } from './helpers/sample-config.js';
import { tempPaths } from './helpers/tmp.js';

describe('config.json', () => {
  it('keeps what mcp-twake-ai wrote into each agent', async () => {
    const { paths } = await tempPaths();
    const agents = { cursor: { entries: { 'twake-mail': '0123456789abcdef' } } };
    await saveConfig(paths, { ...sampleConfig, agents });
    expect((await loadConfig(paths))?.agents).toEqual(agents);
  });
});
