/**
 * Minimal HTML→text reduction for the fallback body.
 *
 * Deliberately naive: this is a degraded path, not a replacement for AnySearch's
 * extractor. It strips `script`/`style`/`noscript`/`template`/comment bodies,
 * removes tags, decodes the common entities, and collapses whitespace — enough to
 * hand a model readable text, and documented as lower quality in the README.
 *
 * @module dsh-anysearch-fallback/html-text
 */

/** Named entities decoded in addition to numeric references. */
const NAMED_ENTITIES = new Map([
    ['amp', '&'],
    ['lt', '<'],
    ['gt', '>'],
    ['quot', '"'],
    ['apos', "'"],
    ['nbsp', ' '],
    ['ndash', '\u2013'],
    ['mdash', '\u2014'],
    ['hellip', '\u2026'],
    ['copy', '\u00a9'],
    ['reg', '\u00ae'],
    ['times', '\u00d7'],
    ['laquo', '\u00ab'],
    ['raquo', '\u00bb'],
    ['lsquo', '\u2018'],
    ['rsquo', '\u2019'],
    ['ldquo', '\u201c'],
    ['rdquo', '\u201d'],
    ['middot', '\u00b7'],
    ['bull', '\u2022'],
    ['deg', '\u00b0'],
    ['euro', '\u20ac'],
    ['pound', '\u00a3'],
    ['yen', '\u00a5'],
    ['sect', '\u00a7'],
    ['para', '\u00b6'],
    ['trade', '\u2122'],
    ['zwj', ''],
    ['zwnj', ''],
    ['#39', "'"],
]);

/** Decode numeric and common named HTML character references. */
export function decodeHtmlEntities(text) {
    return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,9});/g, (match, body) => {
        let codePoint;
        if (body.startsWith('#x') || body.startsWith('#X')) codePoint = parseInt(body.slice(2), 16);
        else if (body.startsWith('#')) codePoint = parseInt(body.slice(1), 10);
        else {
            const named = NAMED_ENTITIES.get(body.toLowerCase());
            if (named === undefined) return match;
            return named;
        }
        if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
        try {
            return String.fromCodePoint(codePoint);
        }
        catch {
            return match;
        }
    });
}

/** Extract the first `<title>` text, or `undefined` when there is none. */
export function extractTitle(html) {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (match === null) return undefined;
    const text = decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim();
    return text.length > 0 && text.length <= 300 ? text : text.slice(0, 300);
}

/** Reduce an HTML document to readable text (see module doc for the quality caveat). */
export function htmlToText(html) {
    let text = html;
    // The title is rendered separately by the caller; drop its element so it is not
    // repeated at the top of the body.
    text = text.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, ' ');
    for (const tag of ['script', 'style', 'noscript', 'template', 'svg', 'head']) {
        text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
    }
    text = text.replace(/<!--[\s\S]*?-->/g, ' ');
    text = text.replace(/<!(?:doctype|\[CDATA\[)[^>]*>/gi, ' ');
    // Block-level boundaries become newlines so paragraphs stay separated.
    text = text.replace(/<\/?(?:p|div|br|li|tr|h[1-6]|section|article|header|footer|table|ul|ol|dl|blockquote|pre|figure|nav|aside|form)\b[^>]*>/gi, '\n');
    text = text.replace(/<[^>]*>/g, ' ');
    text = decodeHtmlEntities(text);
    return text
        .replace(/[ \t\f\v\u00a0]+/g, ' ')
        .replace(/ *\n */g, '\n')
        // Neighbouring block tags each contribute one newline; those runs are padding,
        // not blank lines, so only real blank lines in the source survive.
        .replace(/\n{2,}/g, '\n')
        .trim();
}

/** Normalize an already-plain text body (CRLF, trailing spaces, whitespace runs). */
export function normalizePlainText(text) {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\f\v\u00a0]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Whether a response `Content-Type` denotes HTML. */
export function isHtmlContentType(contentType) {
    const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase();
    return mime === 'text/html' || mime === 'application/xhtml+xml';
}

/** The `charset` label declared by a `Content-Type`, lower-cased, or `undefined`. */
export function parseCharset(contentType) {
    const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '');
    return match?.[1]?.trim().toLowerCase();
}

/**
 * Decode response bytes with the declared charset, falling back to UTF-8.
 *
 * An unrecognized label falls back to UTF-8 rather than throwing: a degraded
 * fallback that returns slightly mangled text beats a hard failure here.
 */
export function decodeBodyBytes(bytes, contentType, onWarn) {
    const charset = parseCharset(contentType ?? '');
    if (charset === undefined || charset === 'utf-8' || charset === 'utf8') {
        return new TextDecoder('utf-8').decode(bytes);
    }
    try {
        return new TextDecoder(charset).decode(bytes);
    }
    catch {
        onWarn?.(`fallback fetch: unsupported charset ${JSON.stringify(charset)}, decoded as UTF-8`);
        return new TextDecoder('utf-8').decode(bytes);
    }
}