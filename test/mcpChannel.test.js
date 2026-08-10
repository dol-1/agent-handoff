import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startMcpChannelServer, CHANNEL_INSTRUCTION } from '../src/mcpChannel.js';

async function connectedPair() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const channel = startMcpChannelServer({ transport: serverTransport });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  await channel.ready;
  return { channel, client };
}

test('initialize advertises the claude/channel experimental capability', async () => {
  const { channel, client } = await connectedPair();
  try {
    assert.deepEqual(client.getServerCapabilities()?.experimental?.['claude/channel'], {});
  } finally {
    await channel.close();
  }
});

test('initialize carries the standing channel instruction, not repeated per event', async () => {
  const { channel, client } = await connectedPair();
  try {
    assert.equal(client.getInstructions(), CHANNEL_INSTRUCTION);
  } finally {
    await channel.close();
  }
});

test('sendChannelEvent delivers a notifications/claude/channel notification with routing identifiers only', async () => {
  const { channel, client } = await connectedPair();
  try {
    const received = [];
    client.fallbackNotificationHandler = async (notification) => {
      received.push(notification);
    };

    const normalizedEvent = {
      event: 'issue_entered_todo',
      issueIdentifier: 'DEMO-60',
      issueId: 'issue-uuid-1',
      projectId: 'legacy-project-example',
      teamId: 'team-example',
      targetState: 'Todo',
      url: 'https://linear.app/example/issue/DEMO-60/example',
    };
    await channel.sendChannelEvent(normalizedEvent);

    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'notifications/claude/channel');
    assert.equal(received[0].params.meta, undefined);
    assert.deepEqual(JSON.parse(received[0].params.content), normalizedEvent);
    assert.doesNotMatch(received[0].params.content, /title|description|comment/i);
  } finally {
    await channel.close();
  }
});

test('no tools/resources/prompts capability is advertised (one-way, no reply/permission relay)', async () => {
  const { channel, client } = await connectedPair();
  try {
    const caps = client.getServerCapabilities();
    assert.equal(caps?.tools, undefined);
    assert.equal(caps?.resources, undefined);
    assert.equal(caps?.prompts, undefined);
  } finally {
    await channel.close();
  }
});
