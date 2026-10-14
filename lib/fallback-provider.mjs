/**
 * The `anysearch-fallback` fetch provider: delegate, detect the 422 case, degrade safely.
 *
 * Flow of every `fetch()` call:
 * 1. Look the upstream AnySearch provider up in the live `ctx.web.fetchProviders` registry
 *    (read-only; no private field is read or written) and delegate to it.
 * 2. On success — return its result unchanged, byte for byte.
 * 3. On failure — fall back only when the failure is the "cannot extract this page" case.
 *    Every other failure (credentials, quota, network, timeout, cancellation) is rethrown
 *    untouched, so the model sees exactly the upstream error.
 *
 * @module dsh-anysearch-fallback/provider
 */

import { FALLBACK_ERROR_CODE, fallbackFetchDirect } from './direct-fetch.mjs';

/** This provider's registered id. */
export const FALLBACK_PROVIDER_ID = 'anysearch-fallback';

/** The upstream provider this one delegates to by default. */
export const DEFAULT_UPSTREAM_PROVIDER_ID = 'anysearch';

/** HTTP status that means "the upstream extractor cannot handle this page". */
export const EXTRACT_FAILED_STATUS = 422;

/** Upstream message that means the same thing when a status is unavailable. */
export const EXTRACT_FAILED_MESSAGE = 'Unable to extract content from the URL.';

/** Own-property names that may carry an HTTP status along the chain. */
const STATUS_FIELDS = ['httpStatus', 'status', 'statusCode'];

/** How many `cause` links are inspected. */
const MAX_CAUSE_DEPTH = 8;

/** Cap on the upstream text quoted into a combined error message. */
export const MAX_UPSTREAM_ERROR_CHARS = 2000;

/** Truncate text for inclusion in a combined error message. */
export function truncateForMessage(text, limit = MAX_UPSTREAM_ERROR_CHARS) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}\u2026`;
}

/**
 * Whether this exact text is the upstream "cannot extract" message.
 *
 * Deliberately narrow: the sentence alone triggers, plus the case where the upstream
 * message quotes it (its detail is JSON-encoded, hence the escaped form).
 */
export function messageMatchesExtractFailure(text) {
    if (typeof text !== 'string') return false;
    return text.includes(EXTRACT_FAILED_MESSAGE)
        || text.includes(EXTRACT_FAILED_MESSAGE.replace(/"/g, '\\"'))
        || text.includes('extract_failed');
}

/**
 * Walk the `cause` chain and decide whether the fallback is allowed.
 *
 * Only the two "cannot extract" shapes qualify: an HTTP 422 status anywhere on the
 * chain, or the upstream message saying the URL could not be extracted. A 429, a 401,
 * a timeout, a transport error, or a cancellation never qualifies.
 *
 * @param error - the error thrown by the upstream provider.
 * @returns true when the degraded direct fetch must be attempted.
 */
export function shouldFallback(error) {
    let node = error;
    const seen = new Set();
    for (let depth = 0; node !== null && node !== undefined && depth < MAX_CAUSE_DEPTH; depth += 1) {
        if (typeof node !== 'object' || seen.has(node)) break;
        seen.add(node);
        for (const field of STATUS_FIELDS) {
            if (node[field] === EXTRACT_FAILED_STATUS) return true;
        }
        if (typeof node.errorCode === 'string' && node.errorCode === 'extract_failed') return true;
        if (messageMatchesExtractFailure(node.message)) return true;
        node = node.cause;
    }
    return false;
}

/** A short, human-readable description of an error, for the combined message. */
export function describeError(error) {
    if (error instanceof Error) return error.message;
    return String(error);
}

/**
 * The degrading fetch provider.
 *
 * `available()` is always true: `web_fetch` must keep working even when the upstream
 * provider is missing (the direct fetch then runs without any extract attempt).
 */
export class FallbackFetchProvider {
    /** @param options - `ctx`, `upstreamProviderId`, `timeoutMs`, `logger`, test seams. */
    constructor(options = {}) {
        this.ctx = options.ctx;
        this.id = FALLBACK_PROVIDER_ID;
        this.upstreamProviderId = options.upstreamProviderId ?? DEFAULT_UPSTREAM_PROVIDER_ID;
        this.timeoutMs = options.timeoutMs;
        this.logger = options.logger;
        this.fetchImpl = options.fetchImpl;
        this.resolver = options.resolver;
        this.directFetch = options.directFetch ?? fallbackFetchDirect;
        this.logger?.info?.(`anysearch-fallback ready: upstream provider "${this.upstreamProviderId}", direct fetch capped at 5 MB / ${this.timeoutMs ?? 15000} ms`);
    }

    /** Always usable: the fallback path needs no credentials. */
    available() {
        return true;
    }

    /**
     * Resolve the upstream provider from the read-only provider registry.
     *
     * @returns the upstream provider, or `undefined` when it is not registered.
     */
    upstream() {
        const registry = this.ctx?.web?.fetchProviders;
        if (registry === undefined || registry === null) return undefined;
        return typeof registry.get === 'function' ? registry.get(this.upstreamProviderId) : undefined;
    }

    /** Warn once per call when the upstream provider is absent. */
    warnUpstreamMissing() {
        const message = `anysearch-fallback: upstream provider "${this.upstreamProviderId}" is not registered; serving a direct-fetch result with no AnySearch extraction (quality is lower than a cleaned extract)`;
        if (typeof this.logger?.warn === 'function') this.logger.warn(message);
        else console.warn(message);
    }

    /**
     * @param request - `{ url }` from the web seam.
     * @param signal - caller cancellation.
     * @returns the upstream result unchanged, or a marked direct-fetch result.
     */
    async fetch(request, signal) {
        const upstream = this.upstream();
        const upstreamAvailable = upstream !== undefined && typeof upstream.fetch === 'function';

        if (!upstreamAvailable) {
            this.warnUpstreamMissing();
            return await this.directFetch(request.url, {
                signal,
                logger: this.logger,
                timeoutMs: this.timeoutMs,
                fetchImpl: this.fetchImpl,
                resolver: this.resolver,
            });
        }

        let upstreamError;
        try {
            return await upstream.fetch(request, signal);
        }
        catch (error) {
            upstreamError = error;
        }

        if (!shouldFallback(upstreamError)) throw upstreamError;

        const upstreamText = truncateForMessage(describeError(upstreamError));
        try {
            const result = await this.directFetch(request.url, {
                signal,
                logger: this.logger,
                timeoutMs: this.timeoutMs,
                fetchImpl: this.fetchImpl,
                resolver: this.resolver,
            });
            this.logger?.info?.(`anysearch-fallback: upstream extract failed, direct fetch succeeded for ${result.url} (HTTP ${result.statusCode}${result.truncated ? ', truncated' : ''})`);
            return result;
        }
        catch (fallbackError) {
            const fallbackText = truncateForMessage(describeError(fallbackError));
            const cause = fallbackError instanceof Error ? fallbackError : upstreamError;
            throw new FallbackFetchErrorWithContext([
                'anysearch-fallback: 该页既无法被 AnySearch 抽取（上游错误见下），直抓兜底也失败，请换来源或改用别的抓取方式。',
                `上游错误: ${upstreamText}`,
                `直抓失败: ${fallbackText}`,
            ].join('\n'), { code: fallbackError?.code ?? FALLBACK_ERROR_CODE, cause });
        }
    }
}

/** Composite error for "both paths failed", carrying both sides plus the actionable hint. */
export class FallbackFetchErrorWithContext extends Error {
    /**
     * @param message - combined message: upstream reason, fallback reason, and the hint.
     * @param options - `code` and `cause`.
     */
    constructor(message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'WebError';
        this.code = options.code ?? FALLBACK_ERROR_CODE;
    }
}

