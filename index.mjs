/**
 * dsh-anysearch-fallback — a local DSH bundle that makes `web_fetch` degrade
 * instead of failing when the AnySearch extractor cannot read a page.
 *
 * Registered as the selected `fetchProvider` in this bundle's `cordis.patch.yml`;
 * it delegates to the AnySearch provider and, only for HTTP 422 ("cannot extract"),
 * retries the URL itself through a constrained, anonymous, browser-UA direct fetch.
 *
 * Zero runtime dependencies: node builtins only, no DSH internals imported.
 *
 * @module dsh-anysearch-fallback
 */

import { FallbackFetchProvider, FALLBACK_PROVIDER_ID, DEFAULT_UPSTREAM_PROVIDER_ID } from './lib/fallback-provider.mjs';
import { DEFAULT_FALLBACK_TIMEOUT_MS } from './lib/direct-fetch.mjs';

/** Cordis plugin name; must equal the `id` of this bundle's insert line. */
export const name = 'dsh-anysearch-fallback';

/** The web seam this plugin extends. */
export const inject = ['web'];

/**
 * Read the plugin's options from a plain config object, with defaults.
 *
 * No schema library is used on purpose (the plugin must not depend on one).
 *
 * @param config - the resolved loader config (may be `undefined`).
 * @returns `{ upstreamProviderId, timeoutMs }`.
 */
export function resolveConfig(config = {}) {
    const raw = config ?? {};
    const upstreamProviderId = typeof raw.upstreamProviderId === 'string' && raw.upstreamProviderId.trim().length > 0
        ? raw.upstreamProviderId.trim()
        : DEFAULT_UPSTREAM_PROVIDER_ID;
    const timeoutMs = Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
        ? raw.timeoutMs
        : DEFAULT_FALLBACK_TIMEOUT_MS;
    return { upstreamProviderId, timeoutMs };
}

/**
 * Register the fallback fetch provider with the web service.
 *
 * @param ctx - the plugin context; `ctx.web` supplies `registerFetchProvider`.
 * @param config - `{ upstreamProviderId?, timeoutMs? }`.
 */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const provider = new FallbackFetchProvider({
        ctx,
        upstreamProviderId: resolved.upstreamProviderId,
        timeoutMs: resolved.timeoutMs,
        logger: ctx.logger,
    });
    const dispose = ctx.web.registerFetchProvider(provider);
    ctx.logger?.debug?.(`anysearch-fallback: registered fetch provider "${FALLBACK_PROVIDER_ID}"`);
    return dispose;
}

export { FALLBACK_PROVIDER_ID, DEFAULT_UPSTREAM_PROVIDER_ID, FallbackFetchProvider };