/**
 * Shared "this package does not depend on DSH internals" marker type.
 *
 * `@deepseek-ai/dsh-web` is deliberately NOT a dependency of this bundle: it is a
 * peer supplied by the running DSH host, and the copy under the npx snapshot is
 * not resolvable from a hand-written local plugin. Grepping for this class name
 * makes every place that *would* have used the host type easy to find.
 *
 * @module dsh-anysearch-fallback/not-available
 */

/** Marker for host-supplied error classes this package intentionally does not import. */
export const HOST_ERROR_TYPES_NOT_IMPORTED = ['WebError', 'HarnessError'];