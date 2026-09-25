'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { eventFromSSEData, generateAnswerStream } = require('../src/main/anthropic');

const data = (obj) => JSON.stringify(obj);

test('eventFromSSEData: extracts text_delta', () => {
  const p = data({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hi' },
  });
  assert.deepEqual(eventFromSSEData(p), { text: 'Hi' });
});

test('eventFromSSEData: ignores thinking/signature deltas, pings and message events', () => {
  assert.equal(
    eventFromSSEData(
      data({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } }),
    ),
    null,
  );
  assert.equal(
    eventFromSSEData(
      data({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 's' } }),
    ),
    null,
  );
  assert.equal(eventFromSSEData(data({ type: 'ping' })), null);
  assert.equal(eventFromSSEData(data({ type: 'message_stop' })), null);
});

test('eventFromSSEData: error event is reported', () => {
  const p = data({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  assert.deepEqual(eventFromSSEData(p), { error: 'overloaded_error: Overloaded' });
});

test('eventFromSSEData: empty or malformed payload does not throw', () => {
  assert.equal(eventFromSSEData(''), null);
  assert.equal(eventFromSSEData('{not json'), null);
});

// ---- generateAnswerStream with a stubbed global fetch ----

function sseResponse(lines, status = 200) {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(lines.join('\n') + '\n'));
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

const textEvent = (t) =>
  'data: ' +
  data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });

test('generateAnswerStream: streams text, sends required headers, no temperature', async () => {
  const seen = [];
  await withFetch(
    async (url, init) => {
      seen.push({ url, init, body: JSON.parse(init.body) });
      return sseResponse(['event: content_block_delta', textEvent('Hel'), '', textEvent('lo'), '']);
    },
    async () => {
      const chunks = [];
      let started = 0;
      const full = await generateAnswerStream({
        apiKey: 'k',
        model: 'claude-opus-5',
        systemInstruction: 'sys',
        userText: 'q',
        onStart: () => started++,
        onChunk: (d) => chunks.push(d),
      });
      assert.equal(full, 'Hello');
      assert.deepEqual(chunks, ['Hel', 'lo']);
      assert.equal(started, 1);
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0].init.headers['x-api-key'], 'k');
  assert.equal(seen[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen[0].body.system, 'sys');
  assert.equal(seen[0].body.stream, true);
  assert.deepEqual(seen[0].body.messages, [{ role: 'user', content: 'q' }]);
  assert.deepEqual(seen[0].body.output_config, { effort: 'low' });
  assert.equal('temperature' in seen[0].body, false);
});

test('generateAnswerStream: 400 on effort → retries once without output_config', async () => {
  const bodies = [];
  await withFetch(
    async (_url, init) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      if (b.output_config) return new Response('{"error":"effort unsupported"}', { status: 400 });
      return sseResponse([textEvent('ok')]);
    },
    async () => {
      const full = await generateAnswerStream({
        apiKey: 'k',
        model: 'claude-haiku-4-5',
        systemInstruction: 's',
        userText: 'q',
      });
      assert.equal(full, 'ok');
    },
  );
  assert.equal(bodies.length, 2);
  assert.equal('output_config' in bodies[1], false);
});

test('generateAnswerStream: non-ok response throws GenError with status', async () => {
  await withFetch(
    async () => new Response('overloaded', { status: 529 }),
    () =>
      assert.rejects(
        () =>
          generateAnswerStream({ apiKey: 'k', model: 'm', systemInstruction: 's', userText: 'q' }),
        (e) => e.name === 'GenError' && e.status === 529,
      ),
  );
});

test('generateAnswerStream: mid-stream error event rejects instead of truncating', async () => {
  const errLine =
    'data: ' + data({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  await withFetch(
    async () => sseResponse([textEvent('partial'), errLine]),
    () =>
      assert.rejects(
        () =>
          generateAnswerStream({ apiKey: 'k', model: 'm', systemInstruction: 's', userText: 'q' }),
        /overloaded_error: Overloaded/,
      ),
  );
});

test('generateAnswerStream: missing key throws before any request', async () => {
  let called = false;
  await withFetch(
    async () => {
      called = true;
    },
    () =>
      assert.rejects(
        () =>
          generateAnswerStream({ apiKey: '', model: 'm', systemInstruction: 's', userText: 'q' }),
        /Missing Anthropic API Key/,
      ),
  );
  assert.equal(called, false);
});
