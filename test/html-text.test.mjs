/**
 * Unit tests for the HTML→text reduction and the plugin's wire-up.
 *
 * @module dsh-anysearch-fallback/test/html-text
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, inject, name, resolveConfig } from '../index.mjs';
import { decodeBodyBytes, decodeHtmlEntities, extractTitle, htmlToText, isHtmlContentType, normalizePlainText, parseCharset } from '../lib/html-text.mjs';

test('the plugin declares its seam and registers a provider with that id', () => {
    assert.equal(name, 'dsh-anysearch-fallback');
    assert.deepEqual(inject, ['web']);
    const registered = [];
    let disposeCalls = 0;
    const dispose = () => {
        disposeCalls += 1;
    };
    const ctx = {
        logger: { debug: () => {} },
        web: {
            registerFetchProvider: (provider) => {
                registered.push(provider);
                return dispose;
            },
        },
    };
    const returned = apply(ctx, { upstreamProviderId: 'anysearch', timeoutMs: 15000 });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].id, 'anysearch-fallback');
    assert.equal(registered[0].available(), true);
    assert.equal(typeof registered[0].fetch, 'function');
    assert.equal(returned, dispose);
    returned();
    assert.equal(disposeCalls, 1, 'the web seam disposer must be handed back to cordis');
});

test('plugin config defaults are applied for absent or invalid values', () => {
    assert.deepEqual(resolveConfig(), { upstreamProviderId: 'anysearch', timeoutMs: 15000 });
    assert.deepEqual(resolveConfig({}), { upstreamProviderId: 'anysearch', timeoutMs: 15000 });
    assert.deepEqual(resolveConfig({ upstreamProviderId: '  custom  ', timeoutMs: 1000 }), { upstreamProviderId: 'custom', timeoutMs: 1000 });
    assert.deepEqual(resolveConfig({ upstreamProviderId: '', timeoutMs: -1 }), { upstreamProviderId: 'anysearch', timeoutMs: 15000 });
    assert.deepEqual(resolveConfig({ upstreamProviderId: 'x', timeoutMs: 'nope' }), { upstreamProviderId: 'x', timeoutMs: 15000 });
});

test('entities are decoded, including numeric and unknown ones', () => {
    assert.equal(decodeHtmlEntities('a &amp; b &lt;i&gt; &quot;q&quot; &#39;s&#39;'), 'a & b <i> "q" \'s\'');
    assert.equal(decodeHtmlEntities('&#x41; &#65; &nbsp;x'), 'A A  x');
    assert.equal(decodeHtmlEntities('&notarealentity; &'), '&notarealentity; &');
    assert.equal(decodeHtmlEntities('&#x110000;'), '&#x110000;', 'out-of-range code points are left as written');
});

test('a title is extracted, trimmed, and length-capped', () => {
    assert.equal(extractTitle('<title>  Hello   world  </title>'), 'Hello world');
    assert.equal(extractTitle('<title>Q &amp; A</title>'), 'Q & A');
    assert.equal(extractTitle('<TITLE class=x>Upper</TITLE>'), 'Upper');
    assert.equal(extractTitle('<p>no title</p>'), undefined);
    assert.equal(extractTitle(`<title>${'t'.repeat(500)}</title>`).length, 300);
});

test('htmlToText drops scripts, styles, comments, and the title element', () => {
    const html = '<head><title>T</title><style>p{}</style></head><body><!-- c --><script>var x=1</script><noscript>n</noscript><p>Keep &amp; me</p></body>';
    const text = htmlToText(html);
    assert.equal(text, 'Keep & me');
});

test('htmlToText keeps block boundaries and collapses blank-line runs', () => {
    const text = htmlToText('<p>one</p><p>two</p>\n\n\n<div>three</div><br><span>four</span>');
    assert.equal(text, 'one\ntwo\nthree\nfour');
});

test('plain text is normalized without tag stripping', () => {
    assert.equal(normalizePlainText('a  b\r\n\r\n\r\nc\t\n'), 'a b\n\nc');
});

test('content types and charsets are parsed leniently', () => {
    assert.equal(isHtmlContentType('text/html'), true);
    assert.equal(isHtmlContentType('text/html; charset=utf-8'), true);
    assert.equal(isHtmlContentType('application/xhtml+xml'), true);
    assert.equal(isHtmlContentType('text/plain'), false);
    assert.equal(isHtmlContentType(undefined), false);
    assert.equal(parseCharset('text/html; charset="GBK"'), 'gbk');
    assert.equal(parseCharset('text/plain'), undefined);
    const bytes = new TextEncoder().encode('héllo');
    assert.equal(decodeBodyBytes(bytes, 'text/plain; charset=utf-8'), 'héllo');
    assert.equal(decodeBodyBytes(bytes, 'text/plain'), 'héllo');
    const warnings = [];
    assert.equal(decodeBodyBytes(bytes, 'text/plain; charset=bogus-charset', (message) => warnings.push(message)), 'héllo');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unsupported charset/);
});