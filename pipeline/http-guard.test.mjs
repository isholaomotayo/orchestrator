import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedRequest } from './http-guard.mjs';

const PORT = 4600;

test('accepts loopback Host with no Origin (curl / same-origin nav)', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:4600' }, PORT), true);
  assert.equal(isTrustedRequest({ host: 'localhost:4600' }, PORT), true);
});

test('accepts a same-origin loopback Origin', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:4600', origin: 'http://127.0.0.1:4600' }, PORT), true);
  assert.equal(isTrustedRequest({ host: 'localhost:4600', origin: 'http://localhost:4600' }, PORT), true);
});

test('rejects a missing Host header', () => {
  assert.equal(isTrustedRequest({}, PORT), false);
});

test('rejects a rebound non-loopback Host', () => {
  assert.equal(isTrustedRequest({ host: 'evil.example.com:4600' }, PORT), false);
});

test('rejects a Host targeting a different port', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:5000' }, PORT), false);
});

test('rejects a cross-site Origin even with a loopback Host', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:4600', origin: 'http://evil.example.com' }, PORT), false);
});

test('rejects a loopback Origin on the wrong port', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:4600', origin: 'http://127.0.0.1:9999' }, PORT), false);
});
