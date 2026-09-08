'use strict';

const test = require('node:test');
const assert = require('node:assert');

// deepgram.js is a renderer script: it publishes onto `window` and constructs a
// browser WebSocket. Stub both so the message handling can be driven directly.
class FakeWS {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = FakeWS.OPEN;
    this.sent = [];
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWS.CLOSED;
  }
}
FakeWS.OPEN = 1;
FakeWS.CLOSED = 3;

global.window = {};
global.WebSocket = FakeWS;

const { DeepgramLive } = require('../src/renderer/deepgram');

// Build a live client whose emitted transcripts are collected into an array.
function makeClient(opts = {}) {
  const events = [];
  const dg = new DeepgramLive({
    apiKey: 'k',
    language: 'uk',
    onTranscript: (r) => events.push(r),
    ...opts,
  });
  dg.connect();
  return { dg, events };
}

function results(transcript, { isFinal = false, speechFinal = false } = {}) {
  return JSON.stringify({
    type: 'Results',
    is_final: isFinal,
    speech_final: speechFinal,
    channel: { alternatives: [{ transcript }] },
  });
}

const finals = (events) => events.filter((e) => e.isFinal).map((e) => e.text);
const interims = (events) => events.filter((e) => !e.isFinal).map((e) => e.text);

test('a sentence split across two is_final chunks is committed as one turn', () => {
  const { dg, events } = makeClient();
  // The real split from a Ukrainian interview: Deepgram froze the first half
  // mid-sentence (is_final) and only endpointed after the second half.
  dg.ws.onmessage({
    data: results('Скажіть, будь ласка, які саме алгоритми використовували', { isFinal: true }),
  });
  dg.ws.onmessage({ data: results('взятий як основний.', { isFinal: true, speechFinal: true }) });

  assert.deepStrictEqual(finals(events), [
    'Скажіть, будь ласка, які саме алгоритми використовували взятий як основний.',
  ]);
});

test('a frozen chunk keeps showing as interim instead of committing a turn', () => {
  const { dg, events } = makeClient();
  dg.ws.onmessage({ data: results('one two', { isFinal: true }) });

  assert.deepStrictEqual(finals(events), [], 'nothing is committed before end of speech');
  assert.deepStrictEqual(interims(events), ['one two']);
});

test('interim text is prefixed with the chunks already buffered', () => {
  const { dg, events } = makeClient();
  dg.ws.onmessage({ data: results('one two', { isFinal: true }) });
  dg.ws.onmessage({ data: results('three', {}) });

  assert.strictEqual(interims(events).pop(), 'one two three');
});

test('UtteranceEnd flushes the buffer when speech_final never arrives', () => {
  const { dg, events } = makeClient();
  dg.ws.onmessage({ data: results('background noise ate the endpoint', { isFinal: true }) });
  dg.ws.onmessage({ data: JSON.stringify({ type: 'UtteranceEnd' }) });

  assert.deepStrictEqual(finals(events), ['background noise ate the endpoint']);
});

test('UtteranceEnd on an empty buffer emits nothing', () => {
  const { dg, events } = makeClient();
  dg.ws.onmessage({ data: JSON.stringify({ type: 'UtteranceEnd' }) });

  assert.deepStrictEqual(events, []);
});

test('a speech_final frame with no transcript still flushes what was buffered', () => {
  const { dg, events } = makeClient();
  dg.ws.onmessage({ data: results('trailing words', { isFinal: true }) });
  dg.ws.onmessage({ data: results('', { isFinal: true, speechFinal: true }) });

  assert.deepStrictEqual(finals(events), ['trailing words']);
});

test('close() flushes a buffered chunk so the last sentence is not lost', () => {
  const { dg, events } = makeClient();
  dg.ws.onmessage({ data: results('the very last thing said', { isFinal: true }) });
  dg.close();

  assert.deepStrictEqual(finals(events), ['the very last thing said']);
});

test('the buffer resets between turns', () => {
  const { dg, events } = makeClient();
  dg.ws.onmessage({ data: results('first turn', { isFinal: true, speechFinal: true }) });
  dg.ws.onmessage({ data: results('second turn', { isFinal: true, speechFinal: true }) });

  assert.deepStrictEqual(finals(events), ['first turn', 'second turn']);
});

test('the pause setting drives endpointing, with utterance_end_ms held at its 1000ms floor', () => {
  const short = makeClient({ pauseMs: 500 }).dg;
  const params = new URL(short.ws.url).searchParams;
  assert.strictEqual(params.get('endpointing'), '500');
  assert.strictEqual(
    params.get('utterance_end_ms'),
    '1000',
    'Deepgram rejects anything below 1000',
  );
  assert.strictEqual(
    params.get('interim_results'),
    'true',
    'utterance_end_ms requires interim results',
  );

  const long = makeClient({ pauseMs: 1500 }).dg;
  assert.strictEqual(new URL(long.ws.url).searchParams.get('utterance_end_ms'), '1500');
});

test('endpointing defaults to the normal pause when no setting is passed', () => {
  const { dg } = makeClient();
  assert.strictEqual(new URL(dg.ws.url).searchParams.get('endpointing'), '900');
});
