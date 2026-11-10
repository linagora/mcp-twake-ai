// One twake-ai process asking for a token, as an MCP server would: used by the concurrency test.
import { getToken } from '../../src/broker.js';
import { loadConfig } from '../../src/config.js';
import { appPaths } from '../../src/paths.js';
import { openVault } from '../../src/vault.js';

const paths = appPaths();
const config = await loadConfig(paths);
if (!config) throw new Error('no configuration');
const token = await getToken('mail', {
  paths,
  config,
  vault: await openVault(config.vault, paths),
  http: {},
  now: () => Math.floor(Date.now() / 1000),
});
process.stdout.write(JSON.stringify(token));
