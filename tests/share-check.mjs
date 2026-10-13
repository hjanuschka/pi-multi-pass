import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decodeShareText, encodeShareFrames, encodeShareText, parseShareFrame, ShareFrameCollector, validateBundle } from '../lib/share.ts';

const bundle = {
  schemaVersion: 2,
  accounts: [{ providerName: 'openai-codex-2', baseProvider: 'openai-codex', label: 'Work',
    credential: { type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', expires: Date.now() + 3600000, accountId: 'account-1' } }],
};
validateBundle(bundle);
assert.throws(() => validateBundle({ schemaVersion: 2, accounts: [{ ...bundle.accounts[0], credential: { type: 'api_key' } }] }));
assert.throws(() => validateBundle({ schemaVersion: 2, accounts: [{ ...bundle.accounts[0], credential: { ...bundle.accounts[0].credential, surprise: 'secret' } }] }));
assert.throws(() => parseShareFrame('mps-share://v1/old'));
const text = encodeShareText(bundle);
assert.ok(text.startsWith('mps-share://v2/bundle/'));
assert.deepEqual(decodeShareText(text), bundle);
assert.deepEqual(new ShareFrameCollector().add(text).bundle, bundle);
assert.deepEqual(decodeShareText(text.slice(0, 100) + '\n' + text.slice(100)), bundle);
const textPos = text.length - 10;
const brokenText = text.slice(0, textPos) + (text[textPos] === 'A' ? 'B' : 'A') + text.slice(textPos + 1);
assert.throws(() => decodeShareText(brokenText), /checksum/);
assert.throws(() => decodeShareText('mps-share://v1/old'), /Invalid share text/);
assert.throws(() => decodeShareText(text + 'x'.repeat(60000)), /Invalid share text/);

const tiny = { schemaVersion: 2, accounts: [{ providerName: 'anthropic', baseProvider: 'anthropic',
  credential: { type: 'oauth', access: 'a', refresh: 'b', expires: 3 } }] };
const small = await encodeShareFrames(tiny);
assert.equal(small.length, 1);
assert.ok(small[0].qr.length > 0);
const one = new ShareFrameCollector();
assert.deepEqual(one.add(small[0].uri).bundle, tiny);
assert.deepEqual(one.add(small[0].uri).bundle, tiny);

const large = structuredClone(bundle);
large.accounts[0].credential.access = randomBytes(1800).toString('base64url');
large.accounts[0].credential.refresh = randomBytes(1800).toString('base64url');
const frames = await encodeShareFrames(large);
const fullText = encodeShareText(large);
assert.equal(frames.map(f => parseShareFrame(f.uri).chunk).join(''), fullText.split('/').at(-1));
assert.deepEqual(decodeShareText(fullText), large);
assert.ok(frames.length > 1);
assert.ok(frames.every(f => f.uri.length < 600));
const collector = new ShareFrameCollector();
for (const frame of frames.slice().reverse().slice(0, -1)) {
  assert.equal(collector.add(frame.uri).bundle, undefined);
}
assert.deepEqual(collector.add(frames[0].uri).bundle, large);

const mixed = new ShareFrameCollector();
mixed.add(frames[0].uri);
assert.throws(() => mixed.add(small[0].uri), /another export/);
assert.throws(() => mixed.add(text), /Cannot mix/);
const changed = frames[0].uri.slice(0, -1) + (frames[0].uri.endsWith('A') ? 'B' : 'A');
assert.throws(() => mixed.add(changed), /Conflicting QR frame/);
const corrupt = new ShareFrameCollector();
for (const frame of frames.slice(0, -1)) corrupt.add(frame.uri);
const last = frames.at(-1).uri;
const pos = last.length - 10;
const tampered = last.slice(0, pos) + (last[pos] === 'A' ? 'B' : 'A') + last.slice(pos + 1);
assert.throws(() => corrupt.add(tampered), /Share data failed checksum/);

console.log('offline QR share protocol OK');
