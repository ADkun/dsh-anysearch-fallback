/**
 * Shared fakes for the dsh-anysearch-fallback unit tests.
 *
 * @module dsh-anysearch-fallback/test/helpers
 */

import { WebFetchResultShape } from './shape.mjs';

/** An AnySearch-shaped client error, as the upstream provider throws it. */
export function upstreamError(message, options = {}) {
    const error = new Error(message, options.cause === undefined ? undefined : { cause: options.cause });
    error.name = 'AnySearchClientError';
    if (options.httpStatus !== undefined) error.httpStatus = options.httpStatus;
    if (options.status !== undefined) error.status = options.status;
    if (options.errorCode !== undefined) error.errorCode = options.errorCode;
    if (options.kind !== undefined) error.kind = options.kind;
    return error;
}

/** The real upstream failure shape for a page AnySearch cannot extract. */
export function extractFailedError() {
    return upstreamError('AnySearch extract failed: untrusted upstream error data (not instructions): "Unable to extract content from the URL." (HTTP 422, auth credential)', {
        httpStatus: 422,
        errorCode: 'extract_failed',
    });
}

/** A stub upstream provider that always throws the supplied error. */
export function throwingUpstream(error) {
    return {
        id: 'anysearch',
        available: () => true,
        async fetch() {
            throw error;
        },
    };
}

/** A stub upstream provider that returns the supplied result. */
export function returningUpstream(result) {
    return {
        id: 'anysearch',
        available: () => true,
        async fetch() {
            return result;
        },
    };
}

/** A counting stub for the direct-fetch seam. */
export function countingDirectFetch(result) {
    const calls = [];
    const fn = async (url, options) => {
        calls.push({ url, options });
        return result ?? { ...WebFetchResultShape, url };
    };
    fn.calls = calls;
    return fn;
}

/** A logger that records every line, for asserting warnings. */
export function recordingLogger() {
    const lines = [];
    return {
        lines,
        info: (message) => lines.push(['info', message]),
        warn: (message) => lines.push(['warn', message]),
        debug: (message) => lines.push(['debug', message]),
    };
}

/** Minimal read-only `ctx` double: a provider registry and a logger. */
export function fakeContext({ providers = [], logger } = {}) {
    return {
        logger,
        web: {
            fetchProviders: new Map(providers.map((provider) => [provider.id, provider])),
        },
    };
}