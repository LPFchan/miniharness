/** Offline Streamable HTTP MCP client tests. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  discoverRemoteMcpTools,
  mergeRemoteMcpTools,
  validateRemoteMcpUrl,
} from '../dist/mcp.js';

function tool(name) {
  return {
    name,
    description: `fixture ${name}`,
    inputSchema: { type: 'object', properties: { range: { type: 'string' } } },
  };
}

function serverFixture(tools = [tool('query_activity')]) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    const result = message.method === 'server/discover'
      ? { resultType: 'complete', capabilities: { tools: {} } }
      : message.method === 'tools/list'
        ? {
            tools,
          }
        : {
            content: [{ type: 'text', text: JSON.stringify({ buckets: [{ key: 'fixture' }] }) }],
            structuredContent: { buckets: [{ key: 'fixture' }] },
            isError: false,
          };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve({ server, url: `http://127.0.0.1:${address.port}/mcp` });
  }));
}

test('discovers a Heatmap-shaped catalogue and completes a tool round trip', async () => {
  const fixture = await serverFixture();
  try {
    const tools = await discoverRemoteMcpTools({ label: 'heatmap', url: fixture.url });
    assert.deepEqual(tools.map((tool) => tool.name), ['query_activity']);
    const result = await tools[0].execute('call-1', { range: '2026-08-01' });
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].text, /fixture/);
  } finally {
    fixture.server.close();
  }
});

test('rejects malformed URLs and non-loopback plaintext HTTP', () => {
  assert.throws(() => validateRemoteMcpUrl('not a URL'), /malformed/);
  assert.throws(() => validateRemoteMcpUrl('http://example.com/mcp'), /loopback/);
  assert.throws(() => validateRemoteMcpUrl('ftp://127.0.0.1/mcp'), /http or https/);
});

test('unreachable endpoint fails without exposing fetch details', async () => {
  await assert.rejects(
    () => discoverRemoteMcpTools({ label: 'heatmap', url: 'http://127.0.0.1:1/mcp' }),
    (error) => error.name === 'RemoteMcpError' && error.message === 'MCP server is unreachable',
  );
});

test('an explicit allowlist fails closed when the server has no permitted tool', async () => {
  const fixture = await serverFixture();
  try {
    const tools = await discoverRemoteMcpTools({
      label: 'heatmap',
      url: fixture.url,
      allowedTools: new Set(['not_heatmap_tool']),
    });
    assert.throws(
      () => mergeRemoteMcpTools([tools], new Set(['not_heatmap_tool'])),
      /missing allowed tools/,
    );
  } finally {
    fixture.server.close();
  }
});

test('an explicit allowlist may be partitioned across configured servers', async () => {
  const activity = await serverFixture([tool('query_activity')]);
  const cost = await serverFixture([tool('query_cost')]);
  try {
    const groups = await Promise.all([
      discoverRemoteMcpTools({ label: 'activity', url: activity.url, allowedTools: new Set(['query_activity', 'query_cost']) }),
      discoverRemoteMcpTools({ label: 'cost', url: cost.url, allowedTools: new Set(['query_activity', 'query_cost']) }),
    ]);
    const merged = mergeRemoteMcpTools(groups, new Set(['query_activity', 'query_cost']));
    assert.deepEqual(merged.map((item) => item.name), ['query_activity', 'query_cost']);
  } finally {
    activity.server.close();
    cost.server.close();
  }
});

test('an explicit allowlist rejects a missing name across all configured servers', async () => {
  const fixture = await serverFixture([tool('query_activity')]);
  try {
    const tools = await discoverRemoteMcpTools({
      label: 'heatmap',
      url: fixture.url,
      allowedTools: new Set(['query_activity', 'query_cost']),
    });
    assert.throws(
      () => mergeRemoteMcpTools([tools], new Set(['query_activity', 'query_cost'])),
      /missing allowed tools/,
    );
  } finally {
    fixture.server.close();
  }
});

test('duplicate exposed names within one server are rejected', async () => {
  const fixture = await serverFixture([tool('query_activity'), tool('query_activity')]);
  try {
    const tools = await discoverRemoteMcpTools({ label: 'heatmap', url: fixture.url });
    assert.throws(() => mergeRemoteMcpTools([tools]), /duplicate tool names/);
  } finally {
    fixture.server.close();
  }
});

test('duplicate exposed names across servers are rejected', async () => {
  const first = await serverFixture([tool('query_activity')]);
  const second = await serverFixture([tool('query_activity')]);
  try {
    const groups = await Promise.all([
      discoverRemoteMcpTools({ label: 'first', url: first.url }),
      discoverRemoteMcpTools({ label: 'second', url: second.url }),
    ]);
    assert.throws(() => mergeRemoteMcpTools(groups), /duplicate tool names/);
  } finally {
    first.server.close();
    second.server.close();
  }
});
