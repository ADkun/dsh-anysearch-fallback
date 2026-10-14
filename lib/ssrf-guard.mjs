/**
 * Zero-dependency URL/destination guard for the constrained direct fetch.
 *
 * Rejects: non-HTTP(S) schemes, URLs carrying credentials, local/internal
 * hostnames, and every non-public IP literal — including the legacy
 * decimal/octal/hex spellings (`http://2130706433/`, `http://0x7f.1/`,
 * `http://0177.0.0.1/`) that WHATWG `URL` normalizes to dotted quads.
 *
 * This mirrors the intent of `@deepseek-ai/dsh-web-fetch-http`'s
 * `isPublicIpAddress` / `resolvePublicAddresses` (that package's `lib/index.js`
 * lines 35-79) but is implemented here from scratch: its `exports` map hides
 * the deep path and its `ipaddr.js` dependency is not resolvable from a local
 * plugin, and this plugin must stay dependency-free.
 *
 * @module dsh-anysearch-fallback/ssrf-guard
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** URL length cap, matching the HTTP fetch provider's public limit. */
export const MAX_URL_LENGTH = 2048;

/** Hostname suffixes that never denote a public destination. */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'];

/** Exact hostnames that never denote a public destination. */
const BLOCKED_HOSTS = new Set(['localhost', 'host.docker.internal']);

/** IPv4 blocks, as `[network, prefix length]` over the 32-bit value. */
const BLOCKED_IPV4_BLOCKS = [
    [0x00000000, 8], // 0.0.0.0/8 "this network"
    [0x0a000000, 8], // 10.0.0.0/8 private
    [0x64400000, 10], // 100.64.0.0/10 CGNAT
    [0x7f000000, 8], // 127.0.0.0/8 loopback
    [0xa9fe0000, 16], // 169.254.0.0/16 link-local (cloud metadata)
    [0xac100000, 12], // 172.16.0.0/12 private
    [0xc0a80000, 16], // 192.168.0.0/16 private
    [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
    [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
    [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
    [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
    [0xe0000000, 4], // 224.0.0.0/4 multicast
    [0xf0000000, 4], // 240.0.0.0/4 reserved
];

/** Error code carried on every guard rejection, so callers can branch on it. */
export const BLOCKED_URL_CODE = 'WEB_BLOCKED_URL';

/** Raised for every guard rejection. Carries `code: 'WEB_BLOCKED_URL'`. */
export class BlockedUrlError extends Error {
    /** @param message - human-readable reason, safe to surface to the model. */
    constructor(message) {
        super(message);
        this.name = 'BlockedUrlError';
        this.code = BLOCKED_URL_CODE;
    }
}

/** Strip the brackets WHATWG `URL` keeps around IPv6 hostnames. */
export function stripIpv6Brackets(hostname) {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Parse a dotted-quad into its 32-bit unsigned value; `undefined` when malformed. */
function ipv4ToInt(address) {
    const parts = address.split('.');
    if (parts.length !== 4) return undefined;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return undefined;
        const octet = Number(part);
        if (octet > 255) return undefined;
        value = (value * 256) + octet;
    }
    return value;
}

/**
 * Expand an IPv6 address into its eight 16-bit groups.
 *
 * Handles `::` compression, a trailing embedded IPv4 (`::ffff:127.0.0.1`) and a
 * zone suffix. Returns `undefined` when the text is not parseable.
 */
export function ipv6ToGroups(address) {
    let text = stripIpv6Brackets(address);
    const zone = text.indexOf('%');
    if (zone >= 0) text = text.slice(0, zone);
    if (text.length === 0) return undefined;
    // A trailing dotted quad (`::ffff:127.0.0.1`) is two hex groups at the end.
    const lastColon = text.lastIndexOf(':');
    const lastGroup = lastColon >= 0 ? text.slice(lastColon + 1) : text;
    let head = text;
    let tail = [];
    if (lastGroup.includes('.')) {
        const quad = text.slice(Math.max(text.lastIndexOf(':') + 1, 0));
        const embedded = ipv4ToInt(quad);
        if (embedded === undefined) return undefined;
        head = text.slice(0, text.lastIndexOf(':'));
        // The colon before the quad also closes the compression run (`::ffff:`), and the
        // quad needs one group of its own on the compressed side of it.
        if (!head.endsWith(':')) head += ':';
        tail = [(embedded >>> 16) & 0xffff, embedded & 0xffff];
    }
    // A single trailing colon is a short spelling of `::`; normalize before splitting so
    // `::ffff:` and `::ffff` both keep the compression point.
    else if (head.endsWith(':') && !head.endsWith('::')) head += ':';
    const halves = head.split('::');
    if (halves.length > 2) return undefined;
    const parseGroups = (segment) => {
        const groups = [];
        for (const group of segment.split(':').filter((part) => part.length > 0)) {
            if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
            groups.push(parseInt(group, 16));
        }
        return groups;
    };
    const left = halves[0].includes('.') ? undefined : parseGroups(halves[0]);
    const right = halves.length === 2 && !halves[1].includes('.') ? parseGroups(halves[1]) : (halves.length === 2 ? undefined : []);
    if (left === undefined || right === undefined) return undefined;
    // A left half with no groups is the compression point itself (`::ffff:` + quad, or a
    // leading `::`), and the groups after it still need one zero group of their own.
    if (left.length === 0) left.push(0);
    // `right` sits immediately after the compression point, while an embedded quad is the
    // tail of the address: the zero padding goes between them, so the quad lands last.
    const compressed = [...left, ...tail, ...right];
    if (halves.length === 1) return compressed.length === 8 ? compressed : undefined;
    const missing = 8 - compressed.length;
    if (missing < 1) return undefined;
    return [...left, ...new Array(missing).fill(0), ...right, ...tail];
}

/** Whether a dotted-quad falls in a blocked IPv4 block. */
function isBlockedIpv4(address) {
    const value = ipv4ToInt(address);
    if (value === undefined) return true;
    for (const [network, prefix] of BLOCKED_IPV4_BLOCKS) {
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        if (((value & mask) >>> 0) === ((network & mask) >>> 0)) return true;
    }
    return false;
}

/**
 * Whether the hostname is an IPv4-mapped/compatible IPv6 literal (`::ffff:a.b.c.d`, `::a.b.c.d`).
 *
 * Checked before general IPv6 parsing on purpose: WHATWG `URL` normalizes the short
 * mapped form to a hex dotted-quad tail (`[::ffff:7f00:1]`), and neither spelling
 * should depend on how the rest of the address happens to be spelled.
 */
function isMappedIpv4Literal(address) {
    const text = stripIpv6Brackets(address).toLowerCase();
    const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    if (dotted !== null) return isBlockedIpv4(dotted[1]);
    const hexTail = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(text);
    if (hexTail === null) return false;
    const high = parseInt(hexTail[1], 16);
    const low = parseInt(hexTail[2], 16);
    return isBlockedIpv4(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
}

/** Whether an IPv6 literal is loopback, unique-local, link-local, or mapped onto a blocked IPv4. */
function isBlockedIpv6(address) {
    const groups = ipv6ToGroups(address);
    if (groups === undefined) return true;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
    // ::1 / ::
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
    // fc00::/7 unique-local, fe80::/10 link-local
    if ((g0 & 0xfe00) === 0xfc00) return true;
    if ((g0 & 0xffc0) === 0xfe80) return true;
    // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
    const mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0);
    if (mapped) {
        const value = ((g6 * 65536) + g7) >>> 0;
        const dotted = [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
        return isBlockedIpv4(dotted);
    }
    return false;
}

/** Address families/values that a hostname must never resolve to. */
export function isBlockedAddress(address) {
    if (isMappedIpv4Literal(address)) return true;
    const family = isIP(stripIpv6Brackets(address));
    if (family === 4) return isBlockedIpv4(address);
    if (family === 6) return isBlockedIpv6(address);
    return true; // Unparseable: refuse rather than guess.
}

/** Whether a hostname is an obviously local/internal name (before resolution). */
export function isBlockedHostname(hostname) {
    const host = stripIpv6Brackets(hostname).toLowerCase();
    if (host.length === 0) return true;
    if (BLOCKED_HOSTS.has(host)) return true;
    if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
    return false;
}

/**
 * Validate a request URL and the literal destination it names.
 *
 * @param input - raw URL text.
 * @returns the parsed URL.
 * @throws {BlockedUrlError} for every rejection.
 */
export function assertUrlAllowed(input) {
    if (typeof input !== 'string' || input.length === 0) throw new BlockedUrlError('fallback fetch refused: empty URL');
    if (input.length > MAX_URL_LENGTH) throw new BlockedUrlError(`fallback fetch refused: URL longer than ${MAX_URL_LENGTH} characters`);
    let url;
    try {
        url = new URL(input);
    }
    catch {
        throw new BlockedUrlError(`fallback fetch refused: invalid URL ${JSON.stringify(input)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new BlockedUrlError(`fallback fetch refused: unsupported URL scheme ${JSON.stringify(url.protocol)} (only http and https are allowed)`);
    }
    if (url.username.length > 0 || url.password.length > 0) {
        throw new BlockedUrlError('fallback fetch refused: URL must not carry userinfo credentials (user:password@host)');
    }
    assertHostAllowed(url.hostname);
    return url;
}

/**
 * Validate a hostname: internal-name check plus a literal-address check.
 *
 * @param hostname - `URL.hostname`, brackets included for IPv6.
 * @throws {BlockedUrlError}
 */
export function assertHostAllowed(hostname) {
    const host = stripIpv6Brackets(hostname);
    if (isBlockedHostname(host)) throw new BlockedUrlError(`fallback fetch refused: internal hostname ${JSON.stringify(host)}`);
    if (isIP(host) !== 0 && isBlockedAddress(host)) throw new BlockedUrlError(`fallback fetch refused: non-public IP address ${JSON.stringify(host)}`);
}

/**
 * Resolve a hostname and refuse when ANY answer is non-public, or none arrives.
 *
 * TOCTOU boundary: this validates a *separate* resolution from the one the
 * connection then performs; the address is not pinned (no custom undici
 * dispatcher), so a server that changes its answer between the two lookups can
 * still reach a private address. See README "已知边界".
 *
 * @param hostname - `URL.hostname`, brackets included for IPv6.
 * @param resolver - injectable resolver, for tests.
 * @throws {BlockedUrlError}
 */
export async function assertHostResolvesPublic(hostname, resolver = lookup) {
    const host = stripIpv6Brackets(hostname);
    if (isIP(host) !== 0) return; // Literal already checked by assertHostAllowed.
    let answers;
    try {
        answers = await resolver(host, { all: true, order: 'verbatim' });
    }
    catch (error) {
        throw new BlockedUrlError(`fallback fetch refused: cannot resolve hostname ${JSON.stringify(host)} (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!Array.isArray(answers) || answers.length === 0) {
        throw new BlockedUrlError(`fallback fetch refused: hostname ${JSON.stringify(host)} resolved to no addresses`);
    }
    for (const answer of answers) {
        const address = answer?.address;
        if (typeof address !== 'string' || isBlockedAddress(address)) {
            throw new BlockedUrlError(`fallback fetch refused: hostname ${JSON.stringify(host)} resolves to non-public address ${JSON.stringify(String(address))}`);
        }
    }
}

