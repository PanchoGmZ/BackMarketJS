
import { log } from 'apify';
import { ExtractionError } from './values.js';
export function event(tag, data = {}, level = 'info') { log[level]('[' + tag + ']', data); }
export function navigationFailure(error, stage = 'navigation') {
    let message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
    message = message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '[URL]')
        .replace(/\b(password|passwd|username|token|authorization|cookie)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, '[PRIVATE]');
    const signals = [...new Set(message.match(/(?<![A-Z0-9_])(?:net::)?ERR_[A-Z0-9_]{1,70}\b/g) ?? [])].map(s => s.replace('net::', ''));
    const has = pattern => signals.some(s => pattern.test(s));
    const code = error instanceof ExtractionError ? error.code
        : has(/^ERR_(CERT_|SSL_|PROXY_CERTIFICATE)/) ? 'TLS_ERROR'
        : has(/^ERR_(PROXY_AUTH_REQUESTED|INVALID_AUTH_CREDENTIALS)$/) ? 'PROXY_AUTH_ERROR'
        : signals.includes('ERR_TUNNEL_CONNECTION_FAILED') ? 'PROXY_TUNNEL_ERROR'
        : signals.includes('ERR_PROXY_CONNECTION_FAILED') ? 'PROXY_CONNECTION_ERROR'
        : signals.length ? 'CHROMIUM_' + signals.at(-1)
        : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NAVIGATION_ERROR';
    return { code: /^[A-Z][A-Z0-9_]{1,90}$/.test(code) ? code : 'NAVIGATION_ERROR', stage,
        signals, rawMessageOmitted: true, failureType: 'navigation' };
}
export function classifyHttp(category, status, explicitChallenge = false) {
    const required = category === 'document' || category === 'commercial';
    if (explicitChallenge && (required || category === 'protection')) return { status: 'blocked', code: 'ACCESS_CHALLENGE' };
    if (required && [401, 403].includes(status)) return { status: 'blocked', code: 'HTTP_' + status };
    if (required && status >= 400) return { status: 'error',
        code: status === 407 ? 'PROXY_AUTH_ERROR' : status >= 590 && status <= 599 ? 'APIFY_PROXY_HTTP_' + status : 'HTTP_' + status };
    return null;
}
