import assert from 'node:assert/strict';
import test from 'node:test';
import {bestSource, httpsSource, replaceAptSources} from '../.devstar/select-package-sources.mjs';

test('build source overrides require plain HTTPS URLs', () => {
  assert.equal(httpsSource('https://mirror.example/debian/'), 'https://mirror.example/debian');
  for (const input of ['http://mirror.example', 'https://user:pass@mirror.example', 'https://mirror.example/?secret=1',
    'https://mirror.example/debian#value', 'https://mirror.example/debian\nTrusted: yes']) {
    assert.throws(() => httpsSource(input));
  }
});

test('APT archive and security can be configured independently without changing signing keys', () => {
  const original = 'URIs: http://deb.debian.org/debian\nSuites: bookworm bookworm-updates\n' +
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\n' +
    'URIs: http://deb.debian.org/debian-security\nSuites: bookworm-security\n' +
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg\n';
  const result = replaceAptSources(original, 'https://mirror.example/debian', 'https://deb.debian.org/debian-security');
  assert.equal(result, original.replace('http://deb.debian.org/debian\n', 'https://mirror.example/debian\n')
    .replace('http://deb.debian.org/debian-security', 'https://deb.debian.org/debian-security'));
  assert.throws(() => replaceAptSources('', 'https://mirror.example/debian', 'https://deb.debian.org/debian-security'));
});

test('fastest completed probe wins, otherwise preserve the official fallback', () => {
  assert.equal(bestSource([{source: 'official', ms: 130}, null, {source: 'mirror', ms: 90}], 'official'), 'mirror');
  assert.equal(bestSource([null, null], 'official'), 'official');
});
