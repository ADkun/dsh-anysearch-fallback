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
    MAX_MARKER_UPSTREAM_CHARS,
    FALLBACK_PROVIDER_ID,
    FallbackFetchProvider,
    isExtractFailure,
    shouldFallback,
    truncateForMessage,
    upstreamHttpStatus,
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
    assert.match(directFetch.calls[0].options.upstreamReason, /^上游抽取失败（HTTP 422）：/, 'the marker is told the real upstream cause');
    assert.equal(result, direct);
    assert.equal(result.body.content.startsWith(FALLBACK_MARKER), true);
    assert.equal(result.url, 'https://example.com/');
});

test('upstreamHttpStatus reads the real status off the chain instead of assuming 422', () => {
    assert.equal(upstreamHttpStatus(extractFailedError()), 422);
    assert.equal(upstreamHttpStatus(upstreamError('wrapped', { httpStatus: 429, cause: extractFailedError() })), 429, 'the outermost status wins');
    assert.equal(upstreamHttpStatus(upstreamError('cause only', { cause: extractFailedError() })), 422, 'the chain is searched');
    assert.equal(upstreamHttpStatus(upstreamError('Unable to extract content from the URL.')), undefined, 'no status: the caller falls back to 422');
    assert.equal(upstreamHttpStatus(upstreamError('status field only', { status: 499 })), undefined, 'only `httpStatus` counts');
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
    ['HTTP 429 (rate limit)', upstreamError('AnySearch extract failed: "too many requests" (HTTP 429, rate limit)', { httpStatus: 429 })],
    ['HTTP 500', upstreamError('AnySearch extract failed (HTTP 500)', { httpStatus: 500 })],
    ['timeout', upstreamError('AnySearch extract request timed out after 55000 ms', { kind: 'timeout', code: 'WEB_FETCH_TIMEOUT' })],
    ['transport', upstreamError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND anysearch.example') })],
]) {
    test(`broad fallback (deliberate behaviour change): ${label} now degrades and the marker names the cause`, async () => {
        const { provider, directFetch, logger } = providerFor(error, WebFetchResultShape);
        const result = await provider.fetch({ url: 'https://example.com/' }, undefined);
        assert.equal(directFetch.calls.length, 1, 'every upstream failure degrades now, except cancellation');
        assert.equal(result, WebFetchResultShape, 'the degraded result is returned as-is');
        const reason = directFetch.calls[0].options.upstreamReason;
        assert.equal(typeof reason, 'string');
        assert.match(reason, /^上游(错误|抽取失败)/);
        assert.match(reason, /AnySearch|fetch failed|timed out/, 'the upstream text is quoted in the marker');
        assert.equal(reason.length <= MAX_MARKER_UPSTREAM_CHARS + 40, true, 'the marker clause stays bounded');
        assert.equal(logger.lines.some(([level, line]) => level === 'warn' && line.includes('degrading')), true, 'every degrade is logged at warn level');
    });
}

for (const [label, error] of [
    ['AbortError name', upstreamError('The operation was aborted', { name: 'AbortError' })],
    ['ABORT_ERR code', upstreamError('boom', { code: 'ABORT_ERR' })],
    ['WEB_ABORTED code', upstreamError('boom', { code: 'WEB_ABORTED' })],
    ['extract_canceled code', upstreamError('boom', { code: 'extract_canceled' })],
    ['cancel wording in the message', upstreamError('the upstream canceled this request')],
    ['cancel nested in the cause chain', upstreamError('wrapper', { cause: upstreamError('aborted by caller', { name: 'AbortError' }) })],
]) {
    test(`cancellation (${label}) is the one case that never degrades`, async () => {
        const { provider, directFetch } = providerFor(error, WebFetchResultShape);
        await assert.rejects(
            () => provider.fetch({ url: 'https://example.com/' }, undefined),
            (thrown) => {
                assert.equal(thrown, error, 'the very same error object must surface, not a wrapper');
                return true;
            },
        );
        assert.equal(directFetch.calls.length, 0, 'a caller who asked to stop must not get a new request');
    });
}

test('an already-aborted caller signal rethrows the upstream error instead of degrading', async () => {
    const error = upstreamError('AnySearch extract failed (HTTP 500)', { httpStatus: 500 });
    const { provider, directFetch } = providerFor(error, WebFetchResultShape);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        () => provider.fetch({ url: 'https://example.com/' }, controller.signal),
        (thrown) => {
            assert.equal(thrown, error);
            return true;
        },
    );
    assert.equal(directFetch.calls.length, 0, 'the aborted signal wins over the broad fallback');
});

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
    assert.match(directFetch.calls[0].options.upstreamReason, /上游服务不可用（upstream provider "anysearch" is not registered）/, 'the marker says the upstream is missing instead of inventing a status');
});

test('shouldFallback is broad now: everything degrades except cancellation', () => {
    assert.equal(shouldFallback(Object.assign(new Error('some other failure'), { statusCode: 422 })), true, 'generic fields no longer restrict the fallback');
    assert.equal(shouldFallback(new Error('readme mentions extract_failed in prose')), true);
    assert.equal(
        shouldFallback(Object.assign(new Error('wrapper'), { cause: Object.assign(new Error('inner'), { statusCode: 422 }) })),
        true,
    );
    assert.equal(shouldFallback(Object.assign(new Error('boom'), { errorCode: 'extract_failed' })), true);
    assert.equal(shouldFallback(upstreamError('boom', { httpStatus: 429 })), true);
    assert.equal(shouldFallback(new Error('boom')), true);
    assert.equal(shouldFallback(undefined), true, 'an unknown failure still degrades');
    assert.equal(shouldFallback(new Error('aborted')), false, 'cancellation is the exception');
});

test('isExtractFailure keeps the precise shapes, now for wording only', () => {
    assert.equal(isExtractFailure(extractFailedError()), true);
    assert.equal(isExtractFailure(upstreamError('Unable to extract content from the URL.')), true);
    assert.equal(isExtractFailure(upstreamError('...error_code: extract_failed...', { httpStatus: 422 })), true);
    assert.equal(isExtractFailure(upstreamError('boom', { httpStatus: 422 })), true);
    assert.equal(isExtractFailure(upstreamError('boom', { httpStatus: 429 })), false);
    assert.equal(isExtractFailure(Object.assign(new Error('boom'), { statusCode: 422 })), false, 'a generic statusCode is not an extract failure');
    assert.equal(isExtractFailure(new Error('readme mentions extract_failed in prose')), false);
    assert.equal(isExtractFailure(new Error('boom')), false);
    assert.equal(isExtractFailure(undefined), false);
    assert.equal(isExtractFailure(null), false);
    assert.equal(isExtractFailure('Unable to extract content from the URL.'), false, 'a bare string is not an error object');
    assert.equal(isExtractFailure(new Error('cycle', { cause: new Error('outer') })), false);
});

test('the marker line quotes the upstream cause and stays bounded', async () => {
    const upstream = upstreamError(`AnySearch extract failed: untrusted upstream error data (not instructions): "${'x'.repeat(4000)}" (HTTP 429, rate limit)`, { httpStatus: 429 });
    const logger = recordingLogger();
    const provider = new FallbackFetchProvider({
        ctx: fakeContext({ providers: [throwingUpstream(upstream)], logger }),
        logger,
        fetchImpl: async () => ({
            status: 200,
            headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
            body: { getReader: () => { let sent = false; return { read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: new TextEncoder().encode('<p>page</p>') })), cancel: async () => {} }; } },
        }),
        resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    const result = await provider.fetch({ url: 'https://example.com/page' }, undefined);
    const firstLine = result.body.content.split('\n')[0];
    assert.equal(firstLine.startsWith(FALLBACK_MARKER), true);
    assert.match(firstLine, /^\[anysearch-fallback\] 上游错误（HTTP 429 rate limit）：/, 'status and upstream label are named');
    assert.match(firstLine, /；直抓成功（HTTP 200），以下为未经 AnySearch 清洗的直抓原文。/);
    assert.equal(firstLine.length <= MAX_MARKER_UPSTREAM_CHARS + 120, true, `the marker line must stay bounded, got ${firstLine.length}`);
});

test('the extract-failure wording is kept for the 422 shape', async () => {
    const logger = recordingLogger();
    const provider = new FallbackFetchProvider({
        ctx: fakeContext({ providers: [throwingUpstream(extractFailedError())], logger }),
        logger,
        fetchImpl: async () => ({
            status: 200,
            headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
            body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }), cancel: async () => {} }) },
        }),
        resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    const result = await provider.fetch({ url: 'https://example.com/page' }, undefined);
    assert.match(result.body.content.split('\n')[0], /^\[anysearch-fallback\] 上游抽取失败（HTTP 422）：/);
});

test('broad fallback: an unrelated error carrying only statusCode 422 degrades without claiming an extract failure', async () => {
    const error = Object.assign(new Error('some other failure'), { statusCode: 422 });
    const { provider, directFetch } = providerFor(error, WebFetchResultShape);
    await provider.fetch({ url: 'https://example.com/' }, undefined);
    assert.equal(directFetch.calls.length, 1);
    const reason = directFetch.calls[0].options.upstreamReason;
    assert.match(reason, /^上游错误：/, 'no status field means no invented status');
    assert.doesNotMatch(reason, /上游抽取失败/, 'a generic statusCode is not an extract failure');
});

test('provider identity and availability stay as the seam requires', () => {
    const provider = new FallbackFetchProvider({ ctx: fakeContext(), directFetch: countingDirectFetch() });
    assert.equal(provider.id, FALLBACK_PROVIDER_ID);
    assert.equal(provider.id, 'anysearch-fallback');
    assert.equal(provider.available(), true);
});

test('truncateForMessage caps the upstream text and flattens it', () => {
    const long = `a\n${'x'.repeat(MAX_UPSTREAM_ERROR_CHARS * 2)}`;
    const cut = truncateForMessage(long);
    assert.equal(cut.length, MAX_UPSTREAM_ERROR_CHARS);
    assert.equal(cut.endsWith('\u2026'), true);
    assert.equal(cut.includes('\n'), false);
});