import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListRootsRequestSchema,
  ListToolsRequestSchema,
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

/** A tool call may run for hours (a search across rooms, a file over a slow link): the default 60 s cuts it. */
const NO_TIMEOUT = 24 * 60 * 60 * 1000;

export interface ProxyOptions {
  /** the loopback endpoint of the shared backend, such as http://127.0.0.1:41234/mcp */
  url: string;
  /** the backend's bearer token, read from its 0600 file */
  token: string;
  name: string;
  version: string;
  /** how long to wait for the backend to answer (it is already listening when the proxy starts) */
  readyMs?: number;
}

/** Opens the upstream session, retrying while the backend settles (its first Matrix sync may still be running). */
async function connectUpstream(options: ProxyOptions): Promise<Client> {
  const client = new Client(
    { name: options.name, version: options.version },
    // what the proxy is able to send back to the shared server, whatever the agent in front supports
    { capabilities: { elicitation: {}, sampling: {}, roots: { listChanged: true } } },
  );
  const deadline = Date.now() + (options.readyMs ?? 30_000);
  for (;;) {
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: { headers: { authorization: `Bearer ${options.token}` } },
    });
    try {
      await client.connect(transport, { timeout: 10_000 });
      return client;
    } catch (error) {
      await transport.close().catch(() => {});
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/**
 * Bridges an agent's stdio to one MCP session of the shared backend: the agent sees the tools, prompts and resources of
 * the upstream server, and a request the server sends in the middle of a tool call (an approval prompt) goes to the
 * agent that made the call — every client of the backend has its own session.
 */
export async function proxyShared(options: ProxyOptions): Promise<number> {
  const client = await connectUpstream(options);
  const capabilities = client.getServerCapabilities() ?? {};
  const server = new Server({ name: options.name, version: options.version }, { capabilities, instructions: client.getInstructions() });

  // only what the shared server offers: a handler for a capability it does not declare makes the SDK refuse to start
  if (capabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, (request) => client.listTools(request.params, { timeout: NO_TIMEOUT }));
    server.setRequestHandler(CallToolRequestSchema, (request) => client.callTool(request.params, undefined, { timeout: NO_TIMEOUT }));
  }
  if (capabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, (request) => client.listPrompts(request.params, { timeout: NO_TIMEOUT }));
    server.setRequestHandler(GetPromptRequestSchema, (request) => client.getPrompt(request.params, { timeout: NO_TIMEOUT }));
  }
  if (capabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, (request) => client.listResources(request.params, { timeout: NO_TIMEOUT }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) => client.listResourceTemplates(request.params, { timeout: NO_TIMEOUT }));
    server.setRequestHandler(ReadResourceRequestSchema, (request) => client.readResource(request.params, { timeout: NO_TIMEOUT }));
  }

  // what the shared server asks of its client, forwarded to the agent in front of this proxy
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    try {
      return await server.elicitInput(request.params);
    } catch {
      // an agent that cannot show the prompt leaves the write undone, rather than done without approval
      return { action: 'cancel' as const };
    }
  });
  client.setRequestHandler(CreateMessageRequestSchema, (request) => server.createMessage(request.params));
  client.setRequestHandler(ListRootsRequestSchema, (request) => server.listRoots(request.params));

  client.setNotificationHandler(ToolListChangedNotificationSchema, () => void server.sendToolListChanged());
  client.setNotificationHandler(PromptListChangedNotificationSchema, () => void server.sendPromptListChanged());
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => void server.sendResourceListChanged());
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => void server.sendLoggingMessage(notification.params));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // the agent closing its side of the pipe, or the upstream going away, ends the proxy; the backend closes with the last proxy
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    process.stdin.once('end', done);
    process.stdin.once('close', done);
    server.onclose = done;
    transport.onclose = done;
  });
  await server.close().catch(() => {});
  await client.close().catch(() => {});
  return 0;
}
