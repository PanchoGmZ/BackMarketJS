
import { UUID_SOURCE, ExtractionError, record } from '../shared/values.js';
const keys = new Set(['l', 'offerType']);
const selectionValue = /^[A-Za-z0-9_.-]{1,100}$/;
const productPath = new RegExp('^/en-us/p/([^/]+)(?:/(' + UUID_SOURCE + '))?/?$', 'i');
export function productUrlIdentity(value) {
    let url;
    try { url = new URL(value); } catch { throw new ExtractionError('INVALID_PRODUCT_URL', 'input'); }
    const match = url.pathname.match(productPath);
    if (url.protocol !== 'https:' || url.host !== 'www.backmarket.com' || url.username || url.password || url.hash || !match
        || (!match[2] && !/^[a-z0-9][a-z0-9-]*$/i.test(match[1])))
        throw new ExtractionError('INVALID_PRODUCT_URL', 'input');
    selectionParameters(value);
    return { slug: match[1], productId: match[2]?.toLowerCase() ?? null };
}
export function selectionParameters(value, strict = true) {
    const url = new URL(value), result = {};
    for (const [k, v] of url.searchParams) {
        if (!keys.has(k)) { if (strict) throw new ExtractionError('INVALID_URL_QUERY', 'input'); continue; }
        if (Object.hasOwn(result, k) || !selectionValue.test(v)) throw new ExtractionError('INVALID_URL_SELECTION', 'input');
        result[k] = v;
    }
    return result;
}
export function selectionState(requestedUrl, finalUrl) {
    const requested = selectionParameters(requestedUrl);
    let final = {}, ambiguous = false;
    try { final = selectionParameters(finalUrl, false); } catch { ambiguous = true; }
    const preserved = !ambiguous && Object.entries(requested).every(([k, v]) => final[k] === v);
    return { requested, final, status: Object.keys(requested).length ? preserved ? 'preserved' : 'changed_or_removed' : 'not_requested' };
}
export function challengeUrl(value) {
    try { return /^\/(testchallengepage|captcha)(\/|$)/i.test(decodeURIComponent(new URL(value).pathname)); } catch { return false; }
}
export function safeUrl(value) {
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol)) return '[INVALID_URL]';
        const allowed = productPath.test(url.pathname)
            || new RegExp('^/(product-page/products|reviews/v1/products)/' + UUID_SOURCE + '(/pickers|/technical_specifications|/reviews)?/?$', 'i').test(url.pathname);
        let path = allowed ? url.pathname : '/[secondary]';
        if (challengeUrl(value)) path = '/testchallengepage';
        if (url.pathname.startsWith('/cdn-cgi/challenge-platform/')) path = '/cdn-cgi/challenge-platform/[resource]';
        const query = new URLSearchParams([...url.searchParams].filter(([k,v]) => keys.has(k) && selectionValue.test(v)));
        return url.origin + path + (query.size ? '?' + query.toString() : '');
    } catch { return '[INVALID_URL]'; }
}
export function parseInput(raw, env = process.env) {
    if (!record(raw)) throw new ExtractionError('INVALID_INPUT', 'input');
    const allowed = new Set(['url', 'firefoxFastMode', 'outputFormat', 'diagnosticMode', 'diagnosticTimeoutSeconds', 'proxyConfiguration', 'proxyAccessAuthorized']);
    if (Object.keys(raw).some(k => !allowed.has(k))) throw new ExtractionError('UNKNOWN_INPUT_FIELD', 'input');
    const value = { firefoxFastMode: false, outputFormat: 'reference1688', diagnosticMode: false, diagnosticTimeoutSeconds: 180,
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['UNBLOCKER'] },
        proxyAccessAuthorized: false, ...raw };
    if (typeof value.url !== 'string' || typeof value.firefoxFastMode !== 'boolean' || value.outputFormat !== 'reference1688'
        || typeof value.diagnosticMode !== 'boolean' || !Number.isInteger(value.diagnosticTimeoutSeconds)
        || value.diagnosticTimeoutSeconds < 30 || value.diagnosticTimeoutSeconds > 180) throw new ExtractionError('INVALID_INPUT', 'input');
    const identity = productUrlIdentity(value.url);
    const maxHtmlBytes = Number(env.BACKMARKET_MAX_HTML_BYTES ?? 4194304);
    const maxMemoryMb = Number(env.BACKMARKET_MAX_MEMORY_MB ?? 1024);
    const timeoutSeconds = value.diagnosticMode ? value.diagnosticTimeoutSeconds - 20 : Number(env.BACKMARKET_TIMEOUT_SECONDS ?? 48);
    if (!Number.isInteger(maxHtmlBytes) || maxHtmlBytes < 1024 || maxHtmlBytes > 8388608
        || !Number.isInteger(maxMemoryMb) || maxMemoryMb < 256 || maxMemoryMb > 2048
        || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || (!value.diagnosticMode && timeoutSeconds > 48))
        throw new ExtractionError('INVALID_RESOURCE_LIMIT', 'input');
    return { ...value, productId: identity.productId, maxHtmlBytes, maxMemoryMb, timeoutSeconds };
}
