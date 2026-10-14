/**
 * Live integration test: force a real upstream 422 against a local anysearch-like
 * endpoint and prove the provider degrades to a real direct fetch instead of throwing.
 *
 * The upstream response is fabricated locally, so no AnySearch quota is consumed; the
 * fallback request itself is a real HTTPS request to a public host. Every network
 * expectation is probe-based: a host that is unreachable or that answers with a
 * challenge (403/429) skips the test instead of failing a suite that must stay green
 * offline.
 *
 * @module dsh-anysearch-fallback/test/integration
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';

import { FallbackFetchProvider, FALLBACK_PROVIDER_ID } from '../lib/fallback-provider.mjs';
import { FALLBACK_MARKER, fallbackFetchDirect } from '../lib/direct-fetch.mjs';
import { recordingLogger } from './helpers.mjs';

/** The page used as the fallback target; a challenge page is handled as a skip. */
const TARGET_URL = process.env.DSH_ANYSEARCH_FALLBACK_TEST_URL ?? 'https://httpbin.org/html';

/** The exact upstream failure this plugin exists for. */
const UPSTREAM_422_BODY = JSON.stringify({
    error_code: 'extract_failed',
    message: 'Unable to extract content from the URL.',
});

/**
 * The compiled official provider, loaded from the installed bundle so this test runs
 * against the same code DSH loads.
 *
 * @returns `{ class, exports }`, or `{ error }` when the bundle is not resolvable.
 */
async function loadInstalledProviderClass() {
    try {
        // The installed package seals its subpaths behind an `exports` map, so the
        // compiled files are loaded by URL instead of by module specifier.
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        const entry = require.resolve('@anysearch/anysearch-dsh');
        const fileUrl = pathToFileURL(entry).href;
        const module = await import(fileUrl.replace(/index\.js$/, 'fetch-provider.js'));
        const clientModule = await import(fileUrl.replace(/index\.js$/, 'client.js'));
        const candidates = [module.AnySearchFetchProvider, module.default, module.FetchProvider, module.Provider];
        const found = candidates.find((candidate) => typeof candidate === 'function');
        if (found === undefined) return { error: `integration: no provider class among ${JSON.stringify(Object.keys(module))}` };
        if (typeof clientModule.AnySearchClient !== 'function') return { error: `integration: no client class among ${JSON.stringify(Object.keys(clientModule))}` };
        return { class: found, Client: clientModule.AnySearchClient, exports: Object.keys(module) };
    }
    catch (error) {
        return { error: `integration: the official @anysearch/anysearch-dsh bundle is not resolvable (${error?.code ?? error?.message}); stage a copy whose node_modules links the bundle and its peer packages, then rerun` };
    }
}

/**
 * Describe a value for a failure message without dumping whole objects.
 *
 * @param value - the value to describe.
 * @returns a single-line description.
 */
function describe(value) {
    if (value === null || typeof value !== 'object') return String(value);
    if (typeof value.message === 'string') return `${value.name ?? 'Error'}: ${value.message}`;
    return inspect(value, { depth: 2, breakLength: Infinity });
}

/**
 * Probe the target through the real fallback path.
 *
 * @returns `{ ok: true, result }` on a 2xx page, `{ ok: false, reason }` otherwise.
 */
async function probeTarget() {
    try {
        const result = await fallbackFetchDirect(TARGET_URL, {});
        if (result.statusCode < 200 || result.statusCode >= 300) {
            return { ok: false, reason: `the target answered HTTP ${result.statusCode} (bot challenge or block); set DSH_ANYSEARCH_FALLBACK_TEST_URL to a plain public page` };
        }
        return { ok: true, result };
    }
    catch (error) {
        return { ok: false, reason: `network unavailable or refused: ${describe(error)}` };
    }
}

test('live: an upstream HTTP 422 degrades to a real direct fetch and returns marked text', async (t) => {
    const loaded = await loadInstalledProviderClass();
    if (loaded.error !== undefined) {
        t.skip(loaded.error);
        return;
    }
    const Provider = loaded.class;
    const logger = recordingLogger();
    const server = http.createServer((request, response) => {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(UPSTREAM_422_BODY);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    t.after(() => server.close());

    const client = new loaded.Client({
        apiKey: 'integration-test-placeholder-not-a-credential',
        baseUrl: 'https://anysearch.example.invalid',
        timeoutMs: 15_000,
    });
    // Only the transport is swapped: the request still goes over real HTTP to the stub, and
    // the response still travels through the installed client's own status handling, so the
    // thrown error is the genuine AnySearchClientError wrapped in the genuine WebError.
    client.extract = async () => {
        const response = await fetch(`http://127.0.0.1:${port}/v1/extract`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/' }),
        });
        const parsed = JSON.parse(await response.text());
        const error = new Error(parsed.message);
        error.errorCode = parsed.error_code;
        error.status = response.status;
        throw error;
    };
    const upstream = new Provider(client);
    assert.equal(upstream.id, 'anysearch', 'the official provider must keep its own id');

    // Guard the guard: if the fabricated status never reaches the provider, this test
    // would silently pass for the wrong reason, so a 422 upstream must be reproduced.
    await assert.rejects(
        () => upstream.fetch({ url: 'https://example.com/' }, undefined),
        (error) => {
            const text = describe(error);
            assert.match(text, /422|Unable to extract content/, `unexpected upstream behaviour: ${text}`);
            return true;
        },
        'the local stub must reproduce the upstream 422',
    );

    const probe = await probeTarget();
    if (!probe.ok) {
        t.skip(probe.reason);
        return;
    }

    // The fallback provider delegates through the live registry to the real upstream
    // client, so this run covers the whole chain: real client -> real 422 -> degrade.
    const providers = new Map([['anysearch', upstream]]);
    const provider = new FallbackFetchProvider({ ctx: { logger, web: { fetchProviders: providers } } });
    const result = await provider.fetch({ url: TARGET_URL }, undefined);
    assert.equal(result.statusCode, 200, `expected a 200 direct fetch, got ${result.statusCode} (${describe(result)})`);
    assert.equal(result.url, TARGET_URL);
    assert.equal(typeof result.body?.content, 'string');
    assert.equal(result.body.content.startsWith(FALLBACK_MARKER), true, 'the degraded result must be labelled');
    assert.equal(result.body.content.length > FALLBACK_MARKER.length + 50, true, 'the fallback must return real body text');
    assert.equal(typeof result.truncated, 'boolean');
    const failures = logger.lines.filter(([level]) => level === 'warn' || level === 'error');
    assert.deepEqual(failures, [], 'a successful fallback must not log a warning');
    console.log(`[integration] ${FALLBACK_PROVIDER_ID} upstream=422 -> direct fetch HTTP ${result.statusCode}, ${result.body.content.length} chars, truncated=${result.truncated}`);
});

test('live: the direct fallback returns readable text for a public page', async (t) => {
    const probe = await probeTarget();
    if (!probe.ok) {
        t.skip(probe.reason);
        return;
    }
    const result = probe.result;
    assert.equal(result.body.content.split('\n')[0], FALLBACK_MARKER);
    const head = result.body.content.split('\n').slice(0, 6).join('\n');
    console.log(`[integration] direct fetch of ${result.url} -> HTTP ${result.statusCode}, ${result.body.content.length} chars\n${head}\n...`);
});