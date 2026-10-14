/**
 * Unit tests for the guarded direct fetch: caps, timeouts, redirects, headers.
 *
 * Every case here uses an injected `fetchImpl`, so the suite performs no network I/O.
 *
 * @module dsh-anysearch-fallback/test/direct-fetch
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_FALLBACK_TIMEOUT_MS,
    FALLBACK_HEADERS,
    FALLBACK_MARKER,
    MAX_BODY_CHARS,
    MAX_RESPONSE_BYTES,
    buildFallbackContent,
    fallbackFetchDirect,
    readCappedBody,
} from '../lib/direct-fetch.mjs';
import { recordingLogger } from './helpers.mjs';

/** A resolver that answers every name with one public address. */
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

/** Headers double with case-insensitive `get`, like a real `Headers`. */
function headers(init = {}) {
    const map = new Map(Object.entries(init).map(([key, value]) => [key.toLowerCase(), String(value)]));
    return { get: (name) => (map.has(name.toLowerCase()) ? map.get(name.toLowerCase()) : null) };
}

/** A `Response` double whose body streams the supplied chunks. */
function fakeResponse({ status = 200, contentType = 'text/html; charset=utf-8', chunks = [], location } = {}) {
    let cancelled = false;
    let readerCancelled = false;
    let reads = 0;
    let index = 0;
    const body = {
        getReader: () => ({
            /**
             * Serve the next chunk; the stream ends when chunks run out.
             *
             * @returns `{ done, value }` like a real reader.
             */
            read: async () => {
                reads += 1;
                if (index >= chunks.length) return { done: true, value: undefined };
                const value = chunks[index];
                index += 1;
                return { done: false, value };
            },
            /** Record the abandonment the cap requires. */
            cancel: async () => {
                readerCancelled = true;
                cancelled = true;
            },
        }),
        cancel: async () => {
            cancelled = true;
            readerCancelled = true;
        },
    };
    return {
        status,
        headers: headers({ 'content-type': contentType, ...(location === undefined ? {} : { location }) }),
        body,
        get cancelled() {
            return cancelled;
        },
        get readerCancelled() {
            return readerCancelled;
        },
        get reads() {
            return reads;
        },
    };
}

/** `chunkBytes` worth of a repeating ASCII filler, as one chunk. */
function fill(size, char = 'x') {
    return new Uint8Array(Buffer.alloc(size, char));
}

test('a normal HTML page is reduced to marked text with a real title and status', async () => {
    const html = [
        '<!doctype html><html><head>',
        '<title>Example &amp; Friends</title>',
        '<style>body{color:red}</style><script>window.x = 1;</script>',
        '</head><body><h1>Hello</h1><p>World&nbsp;text &#8212; here</p><!-- note --></body></html>',
    ].join('');
    const fetchImpl = async () => fakeResponse({ chunks: [new TextEncoder().encode(html)] });
    const result = await fallbackFetchDirect('https://example.com/page', { fetchImpl, resolver: publicResolver });
    assert.equal(result.statusCode, 200);
    assert.equal(result.truncated, false);
    assert.equal(result.url, 'https://example.com/page');
    assert.equal(result.body.kind, 'text');
    assert.equal(result.body.content.split('\n')[0], FALLBACK_MARKER);
    assert.match(result.body.content, /\[title\] Example & Friends/);
    assert.match(result.body.content, /Hello/);
    assert.match(result.body.content, /World text — here/);
    assert.doesNotMatch(result.body.content, /window\.x|color:red|<!--/);
});

test('plain text bodies are normalized, not HTML-stripped', async () => {
    const fetchImpl = async () => fakeResponse({ contentType: 'text/plain', chunks: [new TextEncoder().encode('a  b\r\n\r\n\r\nc\n')] });
    const result = await fallbackFetchDirect('https://example.com/robots.txt', { fetchImpl, resolver: publicResolver });
    assert.equal(result.body.content, `${FALLBACK_MARKER}\n\na b\n\nc`);
});

test('the exact fallback headers are sent, and nothing else', async () => {
    let seen;
    const fetchImpl = async (url, options) => {
        seen = { url: url.toString(), options };
        return fakeResponse({ chunks: [new TextEncoder().encode('<title>t</title>ok')] });
    };
    await fallbackFetchDirect('https://example.com/', { fetchImpl, resolver: publicResolver });
    assert.equal(seen.options.method, 'GET');
    assert.equal(seen.options.redirect, 'manual');
    assert.deepEqual(seen.options.headers, FALLBACK_HEADERS);
    assert.deepEqual(Object.keys(seen.options.headers).map((key) => key.toLowerCase()).sort(), ['accept', 'accept-language', 'user-agent']);
    assert.match(seen.options.headers['user-agent'], /Mozilla\/5\.0 .*Chrome\//);
    assert.equal('authorization' in seen.options.headers, false);
    assert.equal('cookie' in seen.options.headers, false);
    assert.equal('referer' in seen.options.headers, false);
    assert.equal(seen.options.dispatcher, undefined, 'TLS verification must not be overridden by a custom dispatcher');
});

test('the byte cap stops the stream at 5 MB and reports truncation', async () => {
    const chunk = fill(1_000_000);
    const response = fakeResponse({ chunks: [chunk, chunk, chunk, chunk, chunk, chunk] });
    const { bytes, truncatedByBytes } = await readCappedBody(response);
    assert.equal(bytes.byteLength, MAX_RESPONSE_BYTES);
    assert.equal(truncatedByBytes, true);
    assert.equal(response.reads, 5, 'the fifth 1 MB read lands exactly on the 5 MB cap and is the last one');
    assert.equal(response.cancelled, true, 'the stream must be abandoned, not drained');
    assert.equal(response.readerCancelled, true, 'the reader itself must be cancelled');

    // An endless stream: the cap must stop the loop, not the source running dry.
    let served = 0;
    let endlessCancelled = false;
    const endless = {
        status: 200,
        headers: headers({ 'content-type': 'text/plain' }),
        body: {
            getReader: () => ({
                read: async () => {
                    served += 1;
                    if (served > 200) throw new Error('the cap did not stop the read');
                    return { done: false, value: fill(1_000_000) };
                },
                cancel: async () => {
                    endlessCancelled = true;
                },
            }),
        },
    };
    const result = await readCappedBody(endless);
    assert.equal(result.bytes.byteLength, MAX_RESPONSE_BYTES);
    assert.equal(result.truncatedByBytes, true);
    assert.equal(served, 5, 'reading must stop right after the cap-crossing chunk');
    assert.equal(endlessCancelled, true);
});

test('a declared Content-Length over the cap is refused before reading', async () => {
    const response = fakeResponse({ chunks: [fill(10)] });
    response.headers = headers({ 'content-type': 'text/html', 'content-length': String(MAX_RESPONSE_BYTES + 1) });
    await assert.rejects(() => readCappedBody(response), /over the 5000000-byte cap/);
    assert.equal(response.reads, 0);
});

test('the rendered body is cut at the character cap and flagged as truncated', async () => {
    const html = `<title>big</title><p>${'y'.repeat(MAX_BODY_CHARS + 5_000)}</p>`;
    const fetchImpl = async () => fakeResponse({ chunks: [new TextEncoder().encode(html)] });
    const result = await fallbackFetchDirect('https://example.com/big', { fetchImpl, resolver: publicResolver });
    assert.equal(result.body.content.length, MAX_BODY_CHARS);
    assert.equal(result.truncated, true);
    assert.equal(result.body.content.startsWith(FALLBACK_MARKER), true, 'the marker survives the cut');
});

test('the redirect chain is re-validated on every hop and capped at three', async () => {
    const hops = [];
    const fetchImpl = async (url) => {
        hops.push(url.toString());
        if (hops.length <= 4) {
            return fakeResponse({ status: 302, chunks: [], location: `/hop-${hops.length}` });
        }
        return fakeResponse({ chunks: [new TextEncoder().encode('final')] });
    };
    await assert.rejects(
        () => fallbackFetchDirect('https://example.com/a', { fetchImpl, resolver: publicResolver }),
        /exceeded the maximum of 3 redirects/,
    );
    assert.equal(hops.length, 4, 'initial request plus three followed hops');

    const blocked = [];
    const hopToPrivate = async (url) => {
        blocked.push(url.toString());
        return { ...fakeResponse({ status: 302, chunks: [] }), headers: headers({ location: 'http://169.254.169.254/latest/meta-data/' }) };
    };
    await assert.rejects(
        () => fallbackFetchDirect('https://example.com/a', { fetchImpl: hopToPrivate, resolver: publicResolver }),
        (error) => {
            assert.equal(error.code, 'WEB_BLOCKED_URL');
            assert.match(error.message, /non-public IP address/);
            return true;
        },
    );
    assert.deepEqual(blocked, ['https://example.com/a'], 'the private hop must never be requested');
});

test('a non-2xx status is reported as-is instead of pretending success', async () => {
    const fetchImpl = async () => fakeResponse({ status: 404, chunks: [new TextEncoder().encode('<title>gone</title>not found')] });
    const result = await fallbackFetchDirect('https://example.com/missing', { fetchImpl, resolver: publicResolver });
    assert.equal(result.statusCode, 404);
    assert.match(result.body.content, /not found/);
});

test('a timeout is reported as a timeout and carries no caller-cancellation claim', async () => {
    const fetchImpl = async (url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason ?? new DOMException('aborted', 'AbortError')));
    });
    await assert.rejects(
        () => fallbackFetchDirect('https://example.com/slow', { fetchImpl, resolver: publicResolver, timeoutMs: 25 }),
        (error) => {
            assert.equal(error.code, 'WEB_FETCH_TIMEOUT');
            assert.match(error.message, /timed out after 25 ms/);
            return true;
        },
    );
});

test('the caller signal aborts the fallback and is reported as an abort', async () => {
    const controller = new AbortController();
    const fetchImpl = async (url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason ?? new DOMException('aborted', 'AbortError')));
    });
    const promise = fallbackFetchDirect('https://example.com/slow', {
        fetchImpl,
        resolver: publicResolver,
        signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('user pressed stop')), 20);
    await assert.rejects(promise, (error) => {
        assert.equal(error.code, 'WEB_ABORTED');
        assert.match(error.message, /aborted by the caller/);
        return true;
    });
});

test('an already-aborted signal never starts a request', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await assert.rejects(
        () => fallbackFetchDirect('https://example.com/', {
            fetchImpl: async () => {
                called = true;
                return fakeResponse({});
            },
            resolver: publicResolver,
            signal: controller.signal,
        }),
        /aborted before start/,
    );
    assert.equal(called, false);
});

test('an over-the-cap Content-Length surfaces as a size error, not a crash', async () => {
    const fetchImpl = async () => {
        const response = fakeResponse({ chunks: [] });
        response.headers = headers({ 'content-type': 'text/html', 'content-length': String(MAX_RESPONSE_BYTES + 1) });
        return response;
    };
    await assert.rejects(() => fallbackFetchDirect('https://example.com/huge', { fetchImpl, resolver: publicResolver }), (error) => {
        assert.equal(error.code, 'WEB_FETCH_TOO_LARGE');
        return true;
    });
});

test('buildFallbackContent keeps the marker first and tolerates an empty body', () => {
    assert.equal(buildFallbackContent('', 'text/html'), FALLBACK_MARKER);
    const withTitle = buildFallbackContent('<title>Only a title</title>', 'text/html');
    assert.equal(withTitle, `${FALLBACK_MARKER}\n[title] Only a title`);
    const noTitle = buildFallbackContent('<p>body only</p>', 'text/html');
    assert.equal(noTitle, `${FALLBACK_MARKER}\n\nbody only`);
});

test('a resolver failure is reported as a refused URL, and a transport failure as a provider error', async () => {
    await assert.rejects(
        () => fallbackFetchDirect('https://example.com/', {
            fetchImpl: async () => {
                throw new TypeError('fetch failed');
            },
            resolver: async () => {
                throw new Error('getaddrinfo ENOTFOUND example.com');
            },
        }),
        (error) => {
            assert.equal(error.code, 'WEB_BLOCKED_URL');
            assert.match(error.message, /cannot resolve hostname "example\.com"/);
            return true;
        },
    );
    await assert.rejects(
        () => fallbackFetchDirect('https://example.com/', {
            fetchImpl: async () => {
                throw new TypeError('fetch failed');
            },
            resolver: publicResolver,
        }),
        (error) => {
            assert.equal(error.code, 'WEB_PROVIDER_ERROR');
            assert.match(error.message, /fallback direct fetch failed: fetch failed/);
            return true;
        },
    );
});

test('the default timeout is the documented 15 s and warns are routed to the logger', async () => {
    assert.equal(DEFAULT_FALLBACK_TIMEOUT_MS, 15_000);
    const logger = recordingLogger();
    const fetchImpl = async () => fakeResponse({ contentType: 'text/html; charset=not-a-real-charset', chunks: [new TextEncoder().encode('ok')] });
    await fallbackFetchDirect('https://example.com/', { fetchImpl, resolver: publicResolver, logger });
    assert.equal(logger.lines.some(([level, line]) => level === 'warn' && line.includes('unsupported charset')), true);
});