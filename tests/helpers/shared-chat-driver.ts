/**
 * `enterSharedChat` in a process of its own, for the test of a client killed while it starts the server:
 * TWAKE_AI_HOME is the test's folder, SHARED_EXTRA more variables for the server (FAKE_SYNC_MS).
 */
import { appPaths } from '../../src/paths.js';
import { enterSharedChat } from '../../src/shared-chat.js';
import { AGENT, sharedDeps } from './shared-chat-deps.js';

const root = process.env.TWAKE_AI_HOME as string;
const paths = appPaths({ platform: process.platform, env: { TWAKE_AI_HOME: root }, home: root });
const server = await enterSharedChat(AGENT, sharedDeps(paths, { extra: JSON.parse(process.env.SHARED_EXTRA ?? '{}') as Record<string, string> }));
process.stdout.write(`${JSON.stringify({ pid: server.pid })}\n`);
