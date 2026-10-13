import assert from 'node:assert/strict';
import { createShareOffer, decodeShareUri, receiveShare, validateBundle } from '../lib/share.ts';

const bundle = {
  schemaVersion: 1,
  accounts: [{ providerName: 'openai-codex-2', baseProvider: 'openai-codex', label: 'Work',
    credential: { type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', expires: Date.now() + 3600000 } }],
};
validateBundle(bundle);
assert.throws(() => validateBundle({ schemaVersion: 1, accounts: [{ ...bundle.accounts[0], credential: { type: 'api_key' } }] }));
assert.throws(() => decodeShareUri('mps-share://v1/' + Buffer.from(JSON.stringify({ a: '8.8.8.8', p: 443, f: 'A'.repeat(64), s: 'a'.repeat(43) })).toString('base64url')));

const offer = await createShareOffer(bundle, '127.0.0.1');
try {
  const parsed = decodeShareUri(offer.uri);
  assert.equal(parsed.address, '127.0.0.1');
  assert.ok(!offer.uri.includes('fake-refresh'));
  const seen = [];
  const receiving = receiveShare(offer.uri, 'test device', code => seen.push(code));
  const pending = await offer.pending;
  assert.equal(pending.name, 'test device');
  assert.equal(pending.code, seen[0]);
  offer.approve(true);
  assert.deepEqual(await receiving, bundle);
  assert.equal(await offer.completed, true);
  await assert.rejects(receiveShare(offer.uri, 'replay', () => {}));
} finally { offer.close(); }

const wrongCert = await createShareOffer(bundle, '127.0.0.1');
try {
  const payload = JSON.parse(Buffer.from(wrongCert.uri.split('/').pop(), 'base64url'));
  payload.f = 'A'.repeat(64);
  await assert.rejects(receiveShare('mps-share://v1/' + Buffer.from(JSON.stringify(payload)).toString('base64url'), 'other', () => {}), /fingerprint mismatch/);
  wrongCert.close();
  assert.equal(await wrongCert.pending, null);
} finally { wrongCert.close(); }

const denied = await createShareOffer(bundle, '127.0.0.1');
try {
  const receiving = receiveShare(denied.uri, 'bad device', () => {});
  await denied.pending;
  denied.approve(false);
  await assert.rejects(receiving);
} finally { denied.close(); }

console.log('share protocol OK');
