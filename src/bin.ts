#!/usr/bin/env node
import { main, processIo } from './cli.js';

process.exitCode = await main(process.argv.slice(2), processIo);
