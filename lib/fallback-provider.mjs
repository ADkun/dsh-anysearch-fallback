/**
 * The `anysearch-fallback` fetch provider: delegate, degrade on upstream failure, label honestly.
 *
 * Flow of every `fetch()` call:
 * 1. Look the upstream AnySearch provider up in the live `ctx.web.fetchProviders` registry
 *    (read-only; no private field is read or written) and delegate to it.
 * 2. On success — return its result unchanged, byte for byte.
 * 3. On failure — degrade to a guarded direct fetch for **every** upstream error, with one
 *    exception: cancellation (the caller asked to stop, so no new request is sent). The
 *    returned body's first line names the upstream error, so a degraded result is never
 *    mistaken for an extract, and systemic failures (401 credentials, 402 quota, 429 rate
 *    limit) are still visible in the marker line and in a `warn` log line.
 * 4. If the direct fetch fails too, a combined error carries both sides plus an actionable hint.
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

/**
 * Own-property names that may carry an HTTP status along the chain.
 *
 * Deliberately just the one field the upstream actually sets: the official client's
 * `upstreamError()` puts the HTTP status on `httpStatus` (`client.js`, its own
 * `httpStatus` property) and nowhere else.
 *
 * The generic `status` / `statusCode` names are NOT consulted: unrelated error objects
 * carry them for their own purposes, and a stray `statusCode: 422` must not be read as
 * "the extractor cannot read this page" — that would silently swap a real failure for a
 * degraded fetch.
 */
const STATUS_FIELDS = ['httpStatus'];

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
 * Deliberately narrow: only that one sentence triggers, plain or JSON-escaped (the
 * upstream quotes its detail as JSON, hence the escaped form). The token
 * `extract_failed` is NOT matched as a substring — it counts only as the `errorCode`
 * field VALUE (see `shouldFallback`), so prose that merely mentions it cannot drag an
 * unrelated failure onto the fallback path.
 */
export function messageMatchesExtractFailure(text) {
    if (typeof text !== 'string') return false;
    return text.includes(EXTRACT_FAILED_MESSAGE)
        || text.includes(EXTRACT_FAILED_MESSAGE.replace(/"/g, '\\"'));
}

/**
 * Walk the `cause` chain, newest first, and return the first node the visitor accepts.
 *
 * @param error - the error thrown by the upstream provider.
 * @param visit - called per node; returning a non-`undefined` value stops the walk.
 * @returns the accepted value, or `undefined`.
 */
function walkCause(error, visit) {
    let node = error;
    const seen = new Set();
    for (let depth = 0; node !== null && node !== undefined && depth < MAX_CAUSE_DEPTH; depth += 1) {
        if (typeof node !== 'object' || seen.has(node)) break;
        seen.add(node);
        const hit = visit(node);
        if (hit !== undefined) return hit;
        node = node.cause;
    }
    return undefined;
}

/**
 * Whether this failure is the precise "cannot extract this page" shape.
 *
 * Narrow on purpose: it is no longer the trigger (every upstream error degrades), it only
 * selects more accurate wording for the marker line. Matches `httpStatus === 422` anywhere
 * on the chain, the `errorCode` field VALUE `extract_failed`, or the upstream message
 * saying the URL could not be extracted. A generic `statusCode: 422` or prose that merely
 * mentions `extract_failed` still does not count.
 *
 * @param error - the error thrown by the upstream provider.
 * @returns true when this is the extract-failure shape.
 */
export function isExtractFailure(error) {
    return walkCause(error, (node) => {
        for (const field of STATUS_FIELDS) {
            if (node[field] === EXTRACT_FAILED_STATUS) return true;
        }
        if (typeof node.errorCode === 'string' && node.errorCode === 'extract_failed') return true;
        if (messageMatchesExtractFailure(node.message)) return true;
        return undefined;
    }) ?? false;
}

/** Cancellation codes that mean "stop", from this plugin, DSH, or the upstream client. */
const CANCEL_CODES = new Set(['ABORT_ERR', 'WEB_ABORTED', 'extract_canceled']);

/** Message shapes that mean "stop" when no code is attached. */
const CANCEL_MESSAGE = /abort|cancel/i;

/**
 * Whether the upstream failed because the caller cancelled the operation.
 *
 * Cancellation is the ONE case that must not degrade: the caller already asked to stop, so
 * sending another request would fight the caller's intent. Checked along the `cause` chain,
 * because the abort can be wrapped by the upstream client's own error.
 *
 * @param error - the error thrown by the upstream provider.
 * @returns true when this failure is a cancellation.
 */
export function isCancellation(error) {
    return walkCause(error, (node) => {
        if (node.name === 'AbortError') return true;
        if (typeof node.code === 'string' && CANCEL_CODES.has(node.code)) return true;
        if (typeof node.message === 'string' && CANCEL_MESSAGE.test(node.message)) return true;
        return undefined;
    }) ?? false;
}

/**
 * Whether the degraded direct fetch must be attempted.
 *
 * Broad by design (user decision): **any** upstream error degrades, so `web_fetch` no longer
 * fails outright on a page AnySearch cannot serve. The single exception is cancellation.
 *
 * @param error - the error thrown by the upstream provider.
 * @returns true when the degraded direct fetch must be attempted.
 */
export function shouldFallback(error) {
    return !isCancellation(error);
}

/** Cap on the upstream text quoted into the marker line: a glance, not a log. */
export const MAX_MARKER_UPSTREAM_CHARS = 240;

/** Truncate text for inclusion in the marker line (flattened whitespace, bounded length). */
export function summarizeForMarker(text, limit = MAX_MARKER_UPSTREAM_CHARS) {
    return truncateForMessage(typeof text === 'string' ? text : String(text), limit);
}

/**
 * The short status label the upstream puts next to the status, when it does.
 *
 * The official client's message template ends with `(HTTP <status>, <label>, ...)`; the
 * label is a few words (`rate limit`, `auth credential`). It is quoted only when the shape
 * matches, so a non-matching message simply yields a status-less label.
 *
 * @param message - the upstream error message.
 * @returns the label, or `undefined`.
 */
export function upstreamStatusLabel(message) {
    if (typeof message !== 'string') return undefined;
    const match = /HTTP\s*\d{3}\s*,\s*([^),]{2,40}?)\)/.exec(message);
    return match === null ? undefined : match[1].trim();
}

/**
 * The upstream-cause clause of the marker line, with the real status when it is known.
 *
 * The precise extract-failure shapes read `上游抽取失败（HTTP 422）`; every other failure
 * reads `上游错误（HTTP 429 rate limit）`, or `上游错误` when no status is attached. Either
 * way the clause ends with a bounded, whitespace-flattened summary of the upstream message.
 *
 * @param error - the error thrown by the upstream provider.
 * @returns the clause, without the `[anysearch-fallback] ` prefix.
 */
export function markerUpstreamReason(error) {
    const summary = summarizeForMarker(describeError(error));
    if (isExtractFailure(error)) {
        return `上游抽取失败（HTTP ${upstreamHttpStatus(error) ?? EXTRACT_FAILED_STATUS}）：${summary}`;
    }
    const status = upstreamHttpStatus(error);
    if (status === undefined) return `上游错误：${summary}`;
    const label = upstreamStatusLabel(describeError(error));
    return `上游错误（HTTP ${status}${label === undefined ? '' : ` ${label}`}）：${summary}`;
}

/** A short, human-readable description of an error, for the combined message. */
export function describeError(error) {
    if (error instanceof Error) return error.message;
    return String(error);
}

/**
 * The HTTP status of the failed extract, read off the `cause` chain.
 *
 * Only the field the upstream really sets (`httpStatus`) is read. When no numeric status is
 * present — a message-only or `errorCode`-only match — `undefined` is returned and the
 * caller falls back to 422, the only "cannot extract" status we know of.
 *
 * @param error - the error thrown by the upstream provider.
 * @returns a status number, or `undefined`.
 */
export function upstreamHttpStatus(error) {
    let node = error;
    const seen = new Set();
    for (let depth = 0; node !== null && node !== undefined && depth < MAX_CAUSE_DEPTH; depth += 1) {
        if (typeof node !== 'object' || seen.has(node)) break;
        seen.add(node);
        if (Number.isFinite(node.httpStatus)) return node.httpStatus;
        node = node.cause;
    }
    return undefined;
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
            // No extract was attempted here, so there is no upstream error to quote: the marker
            // says exactly that instead of inventing a status.
            return await this.directFetch(request.url, {
                signal,
                logger: this.logger,
                timeoutMs: this.timeoutMs,
                fetchImpl: this.fetchImpl,
                resolver: this.resolver,
                upstreamReason: `上游服务不可用（upstream provider "${this.upstreamProviderId}" is not registered）`,
            });
        }

        let upstreamError;
        try {
            return await upstream.fetch(request, signal);
        }
        catch (error) {
            upstreamError = error;
        }

        if (!shouldFallback(upstreamError) || signal?.aborted === true) {
            // Cancellation — either the caller's signal already fired, or the failure is an
            // abort: do not send a new request behind the caller's back. The original error
            // surfaces untouched.
            throw upstreamError;
        }

        const upstreamText = truncateForMessage(describeError(upstreamError));
        const upstreamReason = markerUpstreamReason(upstreamError);
        // Systemic failures (401 credentials, 402 quota, 429 rate limit) now degrade too —
        // by decision — so the reason lives in the marker line and in this warn line.
        this.logger?.warn?.(`anysearch-fallback: upstream failed, degrading to a direct fetch for ${request.url} (${upstreamReason})`);
        try {
            const result = await this.directFetch(request.url, {
                signal,
                logger: this.logger,
                timeoutMs: this.timeoutMs,
                fetchImpl: this.fetchImpl,
                resolver: this.resolver,
                // The marker line quotes the upstream cause, status and all.
                upstreamReason,
            });
            this.logger?.info?.(`anysearch-fallback: upstream failed, direct fetch succeeded for ${result.url} (HTTP ${result.statusCode}${result.truncated ? ', truncated' : ''})`);
            return result;
        }
        catch (fallbackError) {
            const fallbackText = truncateForMessage(describeError(fallbackError));
            const cause = fallbackError instanceof Error ? fallbackError : upstreamError;
            this.logger?.warn?.(`anysearch-fallback: both paths failed for ${request.url}; upstream: ${upstreamText}; direct fetch: ${fallbackText}`);
            throw new FallbackFetchErrorWithContext([
                'anysearch-fallback: 上游失败（原因见下），直抓兜底也失败，请换来源或改用别的抓取方式。',
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

