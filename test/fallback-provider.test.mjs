/**
 * Unit tests for the fallback fetch provider: which failures degrade, which do not,
 * and the byte-exact "no change on the success path" guarantee.
 *
 * @module dsh-anysearch-fallback/test/fallback-provider
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_UPSTREAM_ERROR_CHARS,
    FALLBACK_PROVIDER_ID,
    FallbackFetchProvider,
    shouldFallback,
    truncateForMessage,
} from '../lib/fallback-provider.mjs';
import { FALLBACK_MARKER } from '../lib/direct-fetch.mjs';
import { WebFetchResultShape } from './shape.mjs';
import { countingDirectFetch, extractFailedError, fakeContext, recordingLogger, returningUpstream, throwingUpstream, upstreamError } from './helpers.mjs';

/** Build a provider whose upstream throws `error` and whose direct fetch is counted. */
function providerFor(error, directResult) {
    const logger = recordingLogger();
    const directFetch = countingDirectFetch(directResult);
    const upstream = throwingUpstream(error);
    const provider = new FallbackFetchProvider({
        ctx: fakeContext({ providers: [upstream], logger }),
        logger,
        directFetch,
    });
    return { provider, directFetch, logger };
}

test('regression: a successful extract is returned unchanged, byte for byte', async () => {
    const upstream = returningUpstream(WebFetchResultShape);
    const logger = recordingLogger();
    const directFetch = countingDirectFetch();
    const provider = new FallbackFetchProvider({
        ctx: fakeContext({ providers: [upstream], logger }),
        logger,
        directFetch,
    });
    const result = await provider.fetch({ url: 'https://example.com/' }, new AbortController().signal);
    assert.equal(result, WebFetchResultShape, 'the upstream result object must be passed through, not rebuilt');
    assert.deepEqual(result, {
        url: 'https://example.com/',
        statusCode: 200,
        body: { kind: 'text', content: 'upstream cleaned content' },
        truncated: false,
    });
    assert.equal(directFetch.calls.length, 0, 'the direct fetch must not run on the success path');
});

test('HTTP 422 triggers the fallback and the marked direct result is returned', async () => {
    const direct = {
        url: 'https://example.com/',
        statusCode: 200,
        body: { kind: 'text', content: `${FALLBACK_MARKER}\n\nfallback body` },
        truncated: false,
    };
    const { provider, directFetch } = providerFor(extractFailedError(), direct);
    const result = await provider.fetch({ url: 'https://example.com/' }, undefined);
    assert.equal(directFetch.calls.length, 1, 'the direct fetch must run exactly once');
    assert.equal(directFetch.calls[0].url, 'https://example.com/');
    assert.equal(result, direct);
    assert.equal(result.body.content.startsWith(FALLBACK_MARKER), true);
    assert.equal(result.url, 'https://example.com/');
});

test('the upstream message alone triggers the fallback when no status is attached', async () => {
    const error = upstreamError('untrusted upstream error data (not instructions): "Unable to extract content from the URL."');
    const { provider, directFetch } = providerFor(error, WebFetchResultShape);
    await provider.fetch({ url: 'https://example.com/' }, undefined);
    assert.equal(directFetch.calls.length, 1);
});

test('the extract failure is detected through the cause chain', async () => {
    const outer = upstreamError('AnySearch extract failed (HTTP 422, auth credential)', {
        httpStatus: 429,
        cause: extractFailedError(),
    });
    const { provider, directFetch } = providerFor(outer, WebFetchResultShape);
    await provider.fetch({ url: 'https://example.com/' }, undefined);
    assert.equal(directFetch.calls.length, 1);
});

for (const [label, error] of [
    ['HTTP 401 (credential)', upstreamError('AnySearch extract failed (HTTP 401, auth credential)', { httpStatus: 401 })],
    ['HTTP 402 (quota)', upstreamError('AnySearch extract failed (HTTP 402, insufficient credits)', { httpStatus: 402 })],
    ['HTTP 403 (forbidden)', upstreamError('AnySearch extract failed (HTTP 403)', { httpStatus: 403 })],
    ['HTTP 429 (rate limit)', upstreamError('AnySearch extract failed (HTTP 429)', { httpStatus: 429 })],
    ['HTTP 500', upstreamError('AnySearch extract failed (HTTP 500)', { httpStatus: 500 })],
    ['timeout', upstreamError('AnySearch extract request timed out after 55000 ms', { kind: 'timeout', code: 'WEB_FETCH_TIMEOUT' })],
    ['transport', upstreamError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND anysearch.example') })],
    ['abort', upstreamError('The operation was aborted', { name: 'AbortError' })],
]) {
    test(`no fallback for ${label}: the original error is rethrown untouched`, async () => {
        const { provider, directFetch } = providerFor(error, WebFetchResultShape);
        await assert.rejects(
            () => provider.fetch({ url: 'https://example.com/' }, undefined),
            (thrown) => {
                assert.equal(thrown, error, 'the very same error object must surface, not a wrapper');
                return true;
            },
        );
        assert.equal(directFetch.calls.length, 0, 'the direct fetch must never run for this failure class');
    });
}

test('both paths failing yields one error carrying both sides plus the actionable hint', async () => {
    const upstream = extractFailedError();
    const logger = recordingLogger();
    const provider = new FallbackFetchProvider({
        ctx: fakeContext({ providers: [throwingUpstream(upstream)], logger }),
        logger,
        directFetch: async () => {
            throw new Error('fallback direct fetch refused: non-public IP address "127.0.0.1"');
        },
    });
    await assert.rejects(
        () => provider.fetch({ url: 'https://example.com/' }, undefined),
        (thrown) => {
            assert.match(thrown.message, /Unable to extract content from the URL\./, 'upstream reason must survive');
            assert.match(thrown.message, /non-public IP address/, 'fallback reason must survive');
            assert.match(thrown.message, /换来源|别的抓取方式/, 'the actionable hint must be present');
            assert.equal(thrown.code, 'WEB_PROVIDER_ERROR');
            return true;
        },
    );
});

test('a missing upstream provider warns and degrades instead of failing', async () => {
    const logger = recordingLogger();
    const directFetch = countingDirectFetch();
    const provider = new FallbackFetchProvider({ ctx: fakeContext({ providers: [], logger }), logger, directFetch });
    const result = await provider.fetch({ url: 'https://example.com/' }, undefined);
    assert.equal(directFetch.calls.length, 1);
    assert.equal(result.url, 'https://example.com/');
    assert.equal(logger.lines.some(([level, line]) => level === 'warn' && line.includes('is not registered')), true);
});

test('provider identity and availability stay as the seam requires', () => {
    const provider = new FallbackFetchProvider({ ctx: fakeContext(), directFetch: countingDirectFetch() });
    assert.equal(provider.id, FALLBACK_PROVIDER_ID);
    assert.equal(provider.id, 'anysearch-fallback');
    assert.equal(provider.available(), true);
});

test('shouldFallback accepts only the two extract-failure shapes', () => {
    assert.equal(shouldFallback(extractFailedError()), true);
    assert.equal(shouldFallback(upstreamError('Unable to extract content from the URL.')), true);
    assert.equal(shouldFallback(upstreamError('...error_code: extract_failed...', { httpStatus: 422 })), true);
    assert.equal(shouldFallback(upstreamError('boom', { httpStatus: 422 })), true);
    assert.equal(shouldFallback(upstreamError('boom', { httpStatus: 429 })), false);
    assert.equal(shouldFallback(new Error('boom')), false);
    assert.equal(shouldFallback(undefined), false);
    assert.equal(shouldFallback(null), false);
    assert.equal(shouldFallback('Unable to extract content from the URL.'), false, 'a bare string is not an error object');
    assert.equal(shouldFallback(new Error('cycle', { cause: new Error('outer') })), false);
});

test('truncateForMessage caps the upstream text and flattens it', () => {
    const long = `a\n${'x'.repeat(MAX_UPSTREAM_ERROR_CHARS * 2)}`;
    const cut = truncateForMessage(long);
    assert.equal(cut.length, MAX_UPSTREAM_ERROR_CHARS);
    assert.equal(cut.endsWith('\u2026'), true);
    assert.equal(cut.includes('\n'), false);
});