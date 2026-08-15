/**
 * Small, one-shot Streamable HTTP MCP client for explicit remote servers.
 *
 * The harness owns the transport, while Pi owns the agent loop and tool-call
 * validation.  This module deliberately accepts only the modern stateless
 * request shape served by Heatmap: a discovery request, a tool catalogue, and
 * one request per tool call.  No server process, daemon, or MCP state is kept.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

const PROTOCOL_VERSION = "2026-07-28";
const REQUEST_TIMEOUT_MS = 30_000;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface RemoteMcpOptions {
  label: string;
  url: string;
  allowedTools?: ReadonlySet<string>;
}

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export class RemoteMcpError extends Error {
  override readonly name = "RemoteMcpError";
}

function safeError(message: string): RemoteMcpError {
  return new RemoteMcpError(message);
}

/** Validate a configured endpoint without performing DNS or network I/O. */
export function validateRemoteMcpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw safeError("MCP server URL is malformed");
  }
  if (url.username !== "" || url.password !== "") {
    throw safeError("MCP server URL must not contain credentials");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw safeError("MCP server URL must use http or https");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw safeError("plaintext MCP HTTP is allowed only on loopback");
  }
  return url;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "ip6-localhost") return true;
  if (normalized === "127.0.0.1" || normalized === "::1") return true;
  const pieces = normalized.split(".");
  if (pieces.length === 4 && pieces[0] === "127") {
    return pieces.slice(1).every((part) => /^\d+$/.test(part) && Number(part) <= 255);
  }
  return false;
}

function requestMetadata(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function requestHeaders(method: string, name?: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
    ...(name === undefined ? {} : { "mcp-name": name }),
  };
}

function requestBody(id: number, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function postJson(
  endpoint: URL,
  id: number,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: requestHeaders(method, typeof params.name === "string" ? params.name : undefined),
      body: requestBody(id, method, params),
      signal: combined,
    });
  } catch {
    throw safeError("MCP server is unreachable");
  }
  if (!response.ok) throw safeError("MCP server rejected the request");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw safeError("MCP server returned malformed JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("MCP server returned an invalid response");
  }
  const record = value as Record<string, unknown>;
  if (record.error !== undefined || record.result === undefined || typeof record.result !== "object") {
    throw safeError("MCP server returned an error");
  }
  return record.result as Record<string, unknown>;
}

function toolDefinitions(result: Record<string, unknown>): ToolDefinition[] {
  if (!Array.isArray(result.tools)) throw safeError("MCP server returned no tool catalogue");
  const definitions: ToolDefinition[] = [];
  for (const item of result.tools) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw safeError("MCP server returned an invalid tool catalogue");
    }
    const tool = item as Record<string, unknown>;
    const name = tool.name;
    if (typeof name !== "string" || !SAFE_NAME.test(name)) {
      throw safeError("MCP server returned an invalid tool name");
    }
    const schema = tool.inputSchema;
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      throw safeError("MCP server returned an invalid tool schema");
    }
    definitions.push({
      name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: schema,
    });
  }
  return definitions;
}

function resultText(result: Record<string, unknown>): string {
  if (result.isError === true) throw safeError("MCP tool call failed");
  const structured = result.structuredContent;
  if (structured !== undefined) return JSON.stringify(structured);
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter((item): item is { type: "text"; text: string } =>
        item !== null && typeof item === "object" && (item as Record<string, unknown>).type === "text" && typeof (item as Record<string, unknown>).text === "string",
      )
      .map((item) => item.text)
      .join("\n");
    if (text !== "") return text;
  }
  return JSON.stringify(result);
}

/** Discover and adapt one explicit remote MCP endpoint into Pi tools. */
export async function discoverRemoteMcpTools(options: RemoteMcpOptions): Promise<AgentTool[]> {
  if (!SAFE_NAME.test(options.label)) throw safeError("MCP server label is invalid");
  const endpoint = validateRemoteMcpUrl(options.url);
  await postJson(endpoint, 1, "server/discover", { _meta: requestMetadata() });
  const catalogue = await postJson(endpoint, 2, "tools/list", { _meta: requestMetadata() });
  const definitions = toolDefinitions(catalogue).filter((tool) =>
    options.allowedTools === undefined || options.allowedTools.has(tool.name),
  );
  if (definitions.length === 0 && options.allowedTools === undefined) {
    throw safeError("MCP server returned no tools");
  }
  let nextRequestId = 3;
  return definitions.map((definition) => ({
    name: definition.name,
    label: `${options.label}:${definition.name}`,
    description: definition.description ?? "Read-only remote MCP tool",
    parameters: definition.inputSchema as TSchema,
    executionMode: "sequential" as const,
    execute: async (
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      _onUpdate?: unknown,
    ): Promise<AgentToolResult<null>> => {
      const result = await postJson(
        endpoint,
        nextRequestId++,
        "tools/call",
        {
          _meta: requestMetadata(),
          name: definition.name,
          arguments:
            params !== null && typeof params === "object" && !Array.isArray(params)
              ? params
              : {},
        },
        signal,
      );
      return { content: [{ type: "text", text: resultText(result) }], details: null };
    },
  }));
}

/**
 * Merge tools discovered from all configured servers before exposing them to
 * Pi.  Tool names are the agent's lookup key, so duplicate exposed names are
 * ambiguous and must fail closed.  An explicit allowlist is checked against
 * the complete server set, allowing different servers to contribute different
 * requested tools while still requiring every requested name.
 */
export function mergeRemoteMcpTools(
  groups: ReadonlyArray<ReadonlyArray<AgentTool>>,
  allowedTools?: ReadonlySet<string>,
): AgentTool[] {
  const merged: AgentTool[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const tool of group) {
      if (seen.has(tool.name)) throw safeError("MCP server set returned duplicate tool names");
      seen.add(tool.name);
      merged.push(tool);
    }
  }
  if (allowedTools !== undefined) {
    for (const name of allowedTools) {
      if (!seen.has(name)) throw safeError("MCP server set is missing allowed tools");
    }
  }
  if (merged.length === 0) throw safeError("MCP server set returned no allowed tools");
  return merged;
}
