/**
 * The only shape the web seam accepts — copied from the contract, not from a host
 * import (the host package is not resolvable from a hand-written local plugin).
 *
 * @module dsh-anysearch-fallback/test/shape
 */

export const WebFetchResultShape = {
    url: 'https://example.com/',
    statusCode: 200,
    body: { kind: 'text', content: 'upstream cleaned content' },
    truncated: false,
};