#!/usr/bin/env node
import { isSupportedNode, REQUIRED_NODE } from './node-version.js';

// checked before loading anything else: on an older Node the dependencies themselves fail to load
if (!isSupportedNode(process.versions.node)) {
  process.stderr.write(`mcp-twake-ai needs Node ${REQUIRED_NODE} or later, and this is Node ${process.versions.node}: install a recent Node from https://nodejs.org, then run it again.\n`);
  process.exit(1);
}
const { main, processIo } = await import('./cli.js');
process.exitCode = await main(process.argv.slice(2), processIo);
