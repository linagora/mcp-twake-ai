/**
 * One more process of the shared-server dance, for the tests that need two: `enter <options>` starts or joins the
 * backend as `run` does and stays a client until killed; `leave <paths, service, agent>` is the last client leaving,
 * and prints whether it stopped the server. Run with `node --import tsx`.
 */
import { enterSharedBackend, stopSharedIfUnused } from '../../src/shared.js';

const [command, json] = process.argv.slice(2);
const options = JSON.parse(json ?? '{}');
if (command === 'enter') {
  const { backend } = await enterSharedBackend(options);
  process.stdout.write(`${JSON.stringify(backend)}\n`);
  setInterval(() => {}, 1000);
} else if (command === 'leave') {
  process.stdout.write('ready\n');
  process.stdout.write(`${await stopSharedIfUnused(options.paths, options.service, options.agent)}\n`);
}
