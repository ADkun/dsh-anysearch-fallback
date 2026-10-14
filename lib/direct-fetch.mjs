/**
 * Constrained, anonymous direct fetch used only as the AnySearch-extract fallback.
 *
 * Guarantees, all of them deliberate:
 * - HTTP(S) only, no URL credentials, no local/internal destination (literal or resolved).
 * - `redirect: 'manual'` with at most {@link MAX_REDIRECTS} hops; every hop repeats the
 *   scheme + host + resolution checks.
 * - A hard {@link MAX_RESPONSE_BYTES} byte cap read straight off `response.body`; the stream
 *   is abandoned at the cap. `response.text()` is never used anywhere in this package.
 * - Its own timeout plus the caller's `signal`, both reported distinctly.
 * - Fixed desktop-Chrome headers only: no Authorization, Cookie, Referer, or environment
 *   values; TLS verification untouched; nothing written to disk.
 *
 * @module dsh-anysearch-fallback/direct-fetch
 */

import { BlockedUrlError, assertHostAllowed, assertHostResolvesPublic, assertUrlAllowed } from './ssrf-guard.mjs';
import { decodeBodyBytes, extractTitle, htmlToText, isHtmlContentType, normalizePlainText } from './html-text.mjs';

/** Hard response-body byte cap (5 MB), mirroring the public HTTP fetch provider's `maxResponseBytes`. */
export const MAX_RESPONSE_BYTES = 5_000_000;

/** Character cap on the returned body, mirroring the public HTTP fetch provider's `maxBodyChars`. */
export const MAX_BODY_CHARS = 100_000;

/** Redirect hops followed, each re-validated. */
export const MAX_REDIRECTS = 3;

/** Fallback fetch timeout. Small on purpose: the tool budget is ~30s and extract already used some. */
export const DEFAULT_FALLBACK_TIMEOUT_MS = 15_000;

/** Fixed desktop Chrome user agent — a stand-in, never a credential. */
export const FALLBACK_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Request headers sent by the fallback: three, and none of them secret. */
export const FALLBACK_HEADERS = {
    'user-agent': FALLBACK_USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
};

/** First line of every fallback body, so a degraded result is never mistaken for a cleaned one. */
export const FALLBACK_MARKER =
    '[anysearch-fallback] 上游抽取失败（HTTP 422），以下为直抓原文，未经 AnySearch 正文清洗。';

/** Redirect statuses carrying a `Location`. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Error code used for every fallback-side failure. */
export const FALLBACK_ERROR_CODE = 'WEB_PROVIDER_ERROR';

/** Raised for fallback-side failures (timeout, abort, size, redirect, transport). */
export class FallbackFetchError extends Error {
    /**
     * @param message - reason to surface.
     * @param options - `code` (DSH-shaped error code) and `cause`.
     */
    constructor(message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'FallbackFetchError';
        this.code = options.code ?? FALLBACK_ERROR_CODE;
    }
}

/** Whether an error is this process's own timeout rather than the caller's cancellation. */
function isTimeoutError(error) {
    return (error instanceof DOMException && error.name === 'TimeoutError')
        || error?.name === 'TimeoutError'
        || error?.code === 'ETIMEDOUT';
}

/** Split a combined abort into the reason that actually fired. */
function classifyAbort(error, timeoutSignal, callerSignal, timeoutMs) {
    if (timeoutSignal.aborted) {
        return new FallbackFetchError(`fallback direct fetch timed out after ${timeoutMs} ms`, { code: 'WEB_FETCH_TIMEOUT', cause: error });
    }
    if (callerSignal?.aborted === true) {
        return new FallbackFetchError('fallback direct fetch aborted by the caller', { code: 'WEB_ABORTED', cause: callerSignal.reason ?? error });
    }
    if (isTimeoutError(error)) {
        return new FallbackFetchError(`fallback direct fetch timed out after ${timeoutMs} ms`, { code: 'WEB_FETCH_TIMEOUT', cause: error });
    }
    return undefined;
}

/**
 * Read a response body up to {@link MAX_RESPONSE_BYTES} bytes, then stop.
 *
 * The stream is consumed with an async reader and abandoned (`reader.cancel()`) the
 * moment the cap is crossed, so an oversized response never lands in memory whole
 * and `truncated` reports the cut truthfully.
 *
 * @param response - the fetch response whose body is read.
 * @returns the bytes read and whether the byte cap cut the body short.
 */
export async function readCappedBody(response) {
    const declared = response.headers?.get?.('content-length') ?? null;
    if (declared !== null) {
        const length = Number(declared);
        if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
            await response.body?.cancel?.().catch(() => {});
            throw new FallbackFetchError(`fallback direct fetch: response declares ${length} bytes, over the ${MAX_RESPONSE_BYTES}-byte cap`, { code: 'WEB_FETCH_TOO_LARGE' });
        }
    }
    if (response.body === null || response.body === undefined) return { bytes: new Uint8Array(0), truncatedByBytes: false };
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let truncatedByBytes = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const remaining = MAX_RESPONSE_BYTES - total;
            if (value.byteLength >= remaining) {
                if (remaining > 0) chunks.push(value.subarray(0, remaining));
                total += Math.max(remaining, 0);
                // A chunk that lands exactly on the cap still had to be cut: the rest of
                // the response is abandoned, so the text is truncated either way.
                truncatedByBytes = true;
                break;
            }
            chunks.push(value);
            total += value.byteLength;
        }
    }
    finally {
        await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { bytes, truncatedByBytes };
}

/**
 * Build the model-facing body text: a fallback marker, the page title, then content.
 *
 * @param raw - decoded response text.
 * @param contentType - the response `Content-Type`.
 * @returns text whose first line is {@link FALLBACK_MARKER}.
 */
export function buildFallbackContent(raw, contentType) {
    const html = isHtmlContentType(contentType);
    const title = html ? extractTitle(raw) : undefined;
    const bodyText = html ? htmlToText(raw) : normalizePlainText(raw);
    const head = title === undefined || title.length === 0
        ? FALLBACK_MARKER
        : `${FALLBACK_MARKER}\n[title] ${title}`;
    return bodyText.length === 0 ? head : `${head}\n\n${bodyText}`;
}

/**
 * Fetch one URL anonymously under the constraints documented on this module.
 *
 * @param rawUrl - the URL to fetch.
 * @param options - `signal` (caller cancellation), `timeoutMs`, `logger`, `fetchImpl`, `resolver`.
 * @returns a `WebFetchResult`-shaped `{ url, statusCode, body, truncated }`.
 * @throws {BlockedUrlError} guard rejection.
 * @throws {FallbackFetchError} timeout, abort, size, redirect, or transport failure.
 */
export async function fallbackFetchDirect(rawUrl, options = {}) {
    const { signal, logger, fetchImpl = globalThis.fetch, resolver } = options;
    const timeoutMs = options.timeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS;
    if (signal?.aborted === true) throw new FallbackFetchError('fallback direct fetch aborted before start', { code: 'WEB_ABORTED', cause: signal.reason });

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    const warnings = [];
    const warn = (message) => {
        warnings.push(message);
        logger?.warn?.(message);
    };

    let current = assertUrlAllowed(rawUrl);
    let hops = 0;
    for (;;) {
        await assertHostResolvesPublic(current.hostname, resolver);
        let response;
        try {
            // No `dispatcher`/custom agent: the address cannot be pinned, so the resolution
            // above is a separate lookup (TOCTOU). See README "已知边界".
            response = await fetchImpl(current, {
                method: 'GET',
                redirect: 'manual',
                headers: { ...FALLBACK_HEADERS },
                signal: combined,
            });
        }
        catch (error) {
            const abort = classifyAbort(error, timeoutSignal, signal, timeoutMs);
            if (abort !== undefined) throw abort;
            throw new FallbackFetchError(`fallback direct fetch failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }

        if (REDIRECT_STATUSES.has(response.status)) {
            // The Location is set here, but the hop count is checked first: a response that
            // arrives over the hop budget is refused even when it happens to be well-formed.
            if (hops >= MAX_REDIRECTS) {
                throw new FallbackFetchError(`fallback direct fetch exceeded the maximum of ${MAX_REDIRECTS} redirects`, { code: 'WEB_REDIRECT_BLOCKED' });
            }
            const location = response.headers.get('location');
            await response.body?.cancel?.().catch(() => {});
            if (location === null) {
                throw new FallbackFetchError(`fallback direct fetch: redirect response (HTTP ${response.status}) without a Location header`);
            }
            let target;
            try {
                target = assertUrlAllowed(new URL(location, current).toString());
            }
            catch (error) {
                if (error instanceof BlockedUrlError) throw error;
                throw new FallbackFetchError(`fallback direct fetch: invalid redirect Location ${JSON.stringify(location)}`, { cause: error });
            }
            hops += 1;
            logger?.debug?.(`fallback direct fetch: following redirect ${hops} to ${target.toString()}`);
            current = target;
            continue;
        }

        const contentType = response.headers.get('content-type');
        const { bytes, truncatedByBytes } = await readCappedBody(response);
        const decoded = decodeBodyBytes(bytes, contentType, warn);
        const built = buildFallbackContent(decoded, contentType);
        // Two caps, mirroring the HTTP fetch provider: bytes off the stream, then characters
        // on the rendered text. `truncated` reports either cut, so the tool never claims a
        // complete page it did not deliver.
        const truncatedByChars = built.length > MAX_BODY_CHARS;
        const content = truncatedByChars ? built.slice(0, MAX_BODY_CHARS) : built;
        return {
            url: current.toString(),
            statusCode: response.status,
            body: { kind: 'text', content },
            truncated: truncatedByBytes || truncatedByChars,
        };
    }
}