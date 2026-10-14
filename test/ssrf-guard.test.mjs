/**
 * SSRF guard tests: every non-public destination the fallback must refuse.
 *
 * Fully offline by construction — each rejected URL throws before any I/O, and the
 * resolution checks use an injected resolver.
 *
 * @module dsh-anysearch-fallback/test/ssrf-guard
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
    BLOCKED_URL_CODE,
    assertHostResolvesPublic,
    assertUrlAllowed,
    ipv6ToGroups,
    isBlockedAddress,
    isBlockedHostname,
} from '../lib/ssrf-guard.mjs';
import { fallbackFetchDirect } from '../lib/direct-fetch.mjs';

/** URLs that must be refused, each with the policy class it proves. */
const BLOCKED_URLS = [
    [pathToFileURL('unauthorized-config.txt').toString(), 'file: scheme'],
    ['data:text/html,<h1>hi</h1>', 'data: scheme'],
    ['ftp://example.com/pub', 'ftp: scheme'],
    ['blob:https://example.com/1234', 'blob: scheme'],
    ['javascript:alert(1)', 'javascript: scheme'],
    ['https://user:pass@example.com/', 'credentials embedded in the URL'],
    ['https://localhost/', 'localhost'],
    ['https://LOCALHOST/', 'localhost, other case'],
    ['http://foo.localhost/', '*.localhost'],
    ['http://printer.local/', '*.local'],
    ['http://vault.internal/', '.internal'],
    ['http://host.docker.internal/', 'docker host alias'],
    ['http://127.0.0.1/', 'IPv4 loopback'],
    ['http://127.1/', 'short-form loopback'],
    ['http://2130706433/', 'decimal loopback'],
    ['http://0x7f.0.0.1/', 'hex loopback'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped IPv6 loopback'],
    ['http://[::ffff:10.0.0.1]/', 'IPv4-mapped IPv6 private'],
    ['http://0.0.0.0/', 'unspecified IPv4'],
    ['http://10.0.0.1/', '10/8 private'],
    ['http://172.16.0.1/', '172.16/12 low edge'],
    ['http://172.31.255.254/', '172.16/12 high edge'],
    ['http://192.168.1.1/', '192.168/16 private'],
    ['http://169.254.169.254/', 'link-local cloud metadata'],
    ['http://100.64.0.1/', 'CGNAT 100.64/10'],
    ['http://[fc00::1]/', 'unique-local fc00::/7'],
    ['http://[fd12:3456::1]/', 'unique-local fd00::/8'],
    ['http://[fe80::1]/', 'link-local fe80::/10'],
    ['http://224.0.0.1/', 'multicast'],
];

/** Public URLs that must pass the guard unchanged. */
const ALLOWED_URLS = [
    'https://example.com/',
    'https://example.com:8443/path?a=1#frag',
    'http://example.com/plain-http',
    'https://1.1.1.1/',
    'https://[2606:4700:4700::1111]/',
    'https://xn--bcher-kva.example/',
];

test('every non-public destination is refused with the same error code', () => {
    for (const [url, why] of BLOCKED_URLS) {
        assert.throws(
            () => assertUrlAllowed(url),
            (error) => {
                assert.equal(error.code, BLOCKED_URL_CODE, `${why}: wrong code for ${url}`);
                assert.equal(error.name, 'BlockedUrlError', `${why}: wrong name for ${url}`);
                return true;
            },
            `${why}: ${url} was not refused`,
        );
    }
});

test('public http(s) URLs pass the guard', () => {
    for (const url of ALLOWED_URLS) {
        const parsed = assertUrlAllowed(url);
        assert.equal(parsed.protocol.startsWith('http'), true);
    }
});

test('empty, oversized, and malformed URLs are refused', () => {
    assert.throws(() => assertUrlAllowed(''), /empty URL/);
    assert.throws(() => assertUrlAllowed(`https://example.com/${'x'.repeat(3000)}`), /longer than 2048 characters/);
    assert.throws(() => assertUrlAllowed('not a url'), /invalid URL/);
    assert.throws(() => assertUrlAllowed(undefined), /empty URL/);
});

test('literal private addresses are recognized, including odd IPv6 spellings', () => {
    for (const address of ['127.0.0.1', '10.255.255.255', '172.20.0.1', '192.168.0.1', '169.254.1.1', '100.100.100.100', '0.0.0.0']) {
        assert.equal(isBlockedAddress(address), true, `${address} should be blocked`);
    }
    for (const address of ['::1', '::', 'fc00::1', 'fdff::1', 'fe80::abcd', '::ffff:192.168.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1']) {
        assert.equal(isBlockedAddress(address), true, `${address} should be blocked`);
    }
    for (const address of ['8.8.8.8', '1.0.0.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111']) {
        assert.equal(isBlockedAddress(address), false, `${address} should be allowed`);
    }
    for (const garbage of ['', 'not-an-ip', '999.1.1.1', 'gggg::1']) {
        assert.equal(isBlockedAddress(garbage), true, `${garbage} should be refused, not guessed at`);
    }
});

test('the blocked hostname list covers the internal naming conventions', () => {
    assert.equal(isBlockedHostname('localhost'), true);
    assert.equal(isBlockedHostname('LocalHost'), true);
    assert.equal(isBlockedHostname('a.b.localhost'), true);
    assert.equal(isBlockedHostname('nas.local'), true);
    assert.equal(isBlockedHostname('svc.internal'), true);
    assert.equal(isBlockedHostname('example.com'), false);
    assert.equal(isBlockedHostname(''), true);
});

test('IPv6 expansion handles compression, embedded quads, and zones', () => {
    assert.deepEqual(ipv6ToGroups('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(ipv6ToGroups('[::1]'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(ipv6ToGroups('0:0:0:0:0:ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
    assert.deepEqual(ipv6ToGroups('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
    assert.deepEqual(ipv6ToGroups('::ffff:1.1.1.1'), [0, 0, 0, 0, 0, 0xffff, 0x0101, 0x0101]);
    assert.deepEqual(ipv6ToGroups('fe80::1%eth0'), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(ipv6ToGroups('2606:4700:4700::1111'), [0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111]);
    assert.equal(ipv6ToGroups('1:2:3'), undefined);
    assert.equal(ipv6ToGroups('gggg::1'), undefined);
    assert.equal(ipv6ToGroups('127.0.0.1'), undefined, 'a dotted quad is not IPv6');
});

test('a hostname resolving to a private address is refused, and every answer is checked', async () => {
    const privateResolver = async () => [{ address: '10.0.0.5', family: 4 }];
    await assert.rejects(
        () => assertHostResolvesPublic('evil.example', privateResolver),
        (error) => {
            assert.equal(error.code, BLOCKED_URL_CODE);
            assert.match(error.message, /resolves to non-public address "10\.0\.0\.5"/);
            return true;
        },
    );
    const mixedResolver = async () => [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }];
    await assert.rejects(() => assertHostResolvesPublic('mixed.example', mixedResolver), /resolves to non-public address/);
    const emptyResolver = async () => [];
    await assert.rejects(() => assertHostResolvesPublic('void.example', emptyResolver), /resolved to no addresses/);
    const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];
    await assertHostResolvesPublic('example.com', publicResolver);
    await assertHostResolvesPublic('1.1.1.1', async () => {
        throw new Error('a literal must not be resolved again');
    });
});

test('the direct fetch refuses a guarded URL before any request is made', async () => {
    let called = false;
    const fetchImpl = async () => {
        called = true;
        throw new Error('must not be reached');
    };
    for (const [url, why] of BLOCKED_URLS) {
        await assert.rejects(
            () => fallbackFetchDirect(url, { fetchImpl }),
            (error) => {
                assert.equal(error.code, BLOCKED_URL_CODE, `${why}: ${url}`);
                return true;
            },
            `${why}: ${url} reached the network`,
        );
    }
    assert.equal(called, false, 'no guarded URL may produce a request');
});