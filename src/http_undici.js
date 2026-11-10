import { Agent, ProxyAgent, fetch as httpFetch } from 'undici';
import { load } from 'cheerio';
import { bounded } from './budget.js';
import { classifyHttp, event } from './diagnostics.js';
import { challengeUrl, productUrlIdentity, safeUrl, selectionState } from './input.js';
import { ExtractionError } from './values.js';

// Derived from the searcher's safe classifier. Never log arbitrary error
// messages/codes: fetch causes can contain proxy URLs and credentials.
const allowedCodes = new Set([
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT',
    'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED', 'ERR_TLS_HANDSHAKE_TIMEOUT',
    'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
    'UND_ERR_ABORTED', 'UND_ERR_PRX_TLS', 'UND_ERR_INVALID_ARG', 'UND_ERR_CLOSED', 'UND_ERR_DESTROYED',
]);
export function connectionFailure(error, { stage, proxy, elapsedMs, aborted = false, timedOut = false }) {
    const queue = [error], seen = new Set(), codes = [];
    let connectStatus = null, proxyAuthRequired = false;
    while (queue.length && seen.size < 20) {
        const current = queue.shift();
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);
        // Undici fetch converts an HTTP 407 response into this exact network
        // error before exposing headers. It is not evidence of CONNECT status.
        if (current.message === 'proxy authentication required') proxyAuthRequired = true;
        if (allowedCodes.has(current.code) && !codes.includes(current.code)) codes.push(current.code);
        if (current.code === 'UND_ERR_ABORTED' && typeof current.message === 'string') {
            const match = /^Proxy response \((\d{3})\) !== 200 when HTTP Tunneling$/.exec(current.message);
            if (match) connectStatus = Number(match[1]);
        }
        if (current.cause) queue.push(current.cause);
        if (Array.isArray(current.errors)) queue.push(...current.errors);
    }
    const code = aborted ? 'ABORTED' : timedOut ? 'TIMEOUT'
        : connectStatus !== null ? connectStatus === 407 ? 'PROXY_AUTH_ERROR' : 'PROXY_CONNECT_ERROR'
        : proxyAuthRequired ? 'PROXY_AUTH_ERROR'
        : codes.some(c => /TIMEOUT|ETIMEDOUT/.test(c)) ? 'TIMEOUT'
        : codes.some(c => /CERT|ERR_TLS_|ERR_SSL_|UND_ERR_PRX_TLS/.test(c)) ? 'TLS_ERROR'
        : codes.some(c => ['ENOTFOUND', 'EAI_AGAIN'].includes(c)) ? 'DNS_ERROR'
        : codes.some(c => ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET'].includes(c)) ? 'TCP_ERROR'
        : codes.some(c => c.startsWith('UND_ERR_')) ? 'UNDICI_ERROR' : 'NETWORK_ERROR';
    return { code, stage, proxy, elapsedMs, codes,
        ...(connectStatus !== null ? { connectStatus } : {}),
        ...(proxyAuthRequired ? { httpStatus: 407 } : {}),
        ...(timedOut ? { timeoutSource: 'local_http_deadline' } : {}) };
}

function dispatcherOptions(proxy, proxyMode) {
    const options = { connections: 1, pipelining: 1, allowH2: false };
    if (!proxy) return options;
    const uri = new URL(proxy.server);
    if (!['http:', 'https:'].includes(uri.protocol) || uri.username || uri.password)
        throw new ExtractionError('PROXY_CONFIGURATION_ERROR', 'http-start');
    // configureProxy() already decoded the SDK credentials; encode once for URI.
    uri.username = encodeURIComponent(proxy.username);
    uri.password = encodeURIComponent(proxy.password);
    return { ...options, uri: uri.href,
        // Same temporary Unblocker exception as the stable extractor, scoped to
        // this dispatcher only. Direct/Residential and proxyTls keep verification.
        ...(proxyMode === 'unblocker' ? { requestTls: { rejectUnauthorized: false } } : {}) };
}
function visibleChallenge(html) {
    const $ = load(html), title = $('title').text();
    $('script,style,noscript').remove();
    return /just a moment|attention required|access denied|verify.*human|security verification|captcha/i.test(title)
        || /bot-need-challenge/i.test($('body').text());
}

// Same acquisition envelope as browser.js; commercial extraction stays in run.js.
// Exactly one application fetch, manual redirects, no fallback and no API calls.
export async function acquire(input, { proxy = null, proxyMode = 'direct', budget, signal,
    fetchImpl = httpFetch, makeDispatcher = options => options.uri ? new ProxyAgent(options) : new Agent(options) } = {}) {
    const started = performance.now(), controller = new AbortController();
    const remaining = () => Math.min(input.timeoutSeconds * 1000,
        budget ? Math.min(budget.remaining(budget.acquisition), budget.remaining()) : Infinity);
    const report = { status: 'running', transport: 'undici', stage: 'http-start',
        navigationCount: 0, httpRequestCount: 0, directApiRequests: 0, applicationRetries: 0,
        requests: [], redirects: [], tlsVerified: !(proxy && proxyMode === 'unblocker'), dispatcherClosed: false };
    let dispatcher, response, html = '', timedOut = false, timer;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
        productUrlIdentity(input.url);
        if (controller.signal.aborted) throw new ExtractionError('ABORTED', report.stage, 'aborted');
        const timeoutMs = Math.floor(remaining() - 2000); // reserve connection cleanup
        if (timeoutMs <= 0) throw new ExtractionError('TIMEOUT', report.stage, 'partial');
        report.timeoutMs = timeoutMs;
        dispatcher = makeDispatcher(dispatcherOptions(proxy, proxyMode));
        event('PROXY_TRANSPORTE', { transport: 'undici', mode: proxyMode, configured: Boolean(proxy),
            usernameProvided: Boolean(proxy?.username), passwordProvided: Boolean(proxy?.password), credentialBinding: proxy ? 'undici-proxy-uri' : 'none' });
        event('TLS', { transport: 'undici', verified: report.tlsVerified });
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        async function readDocument() {
            report.stage = 'request_before_headers'; report.httpRequestCount = 1;
            response = await fetchImpl(input.url, { dispatcher, signal: controller.signal,
                redirect: 'manual', headers: { accept: 'text/html' } });
            report.firstHttpSeconds = (performance.now() - started) / 1000;
            report.stage = 'response_body';
            const headers = response.headers, finalUrl = response.url || input.url;
            const status = response.status, type = headers.get('content-type') ?? '';
            const item = { category: 'document', url: safeUrl(finalUrl), httpStatus: status, contentType: type,
                contentLengthBytes: /^\d+$/.test(headers.get('content-length') ?? '') ? Number(headers.get('content-length')) : null,
                cfRay: headers.get('cf-ray'), bodyRead: { status: 'not-read', bytes: 0 } };
            report.requests.push(item); event('HTTP', item);
            const location = headers.get('location');
            const explicitChallenge = headers.get('cf-mitigated') === 'challenge' || challengeUrl(finalUrl)
                || (status >= 300 && status < 400 && location && challengeUrl(new URL(location, finalUrl).href));
            const failure = classifyHttp('document', status, explicitChallenge);
            if (failure) throw new ExtractionError(failure.code, report.stage, failure.status);
            if (status >= 300 && status < 400) {
                if (location) {
                    report.redirects.push({ sourceUrl: safeUrl(input.url), targetUrl: safeUrl(new URL(location, finalUrl).href), httpStatus: status });
                    event('REDIRECCION', report.redirects.at(-1));
                }
                throw new ExtractionError('UNEXPECTED_REDIRECT', 'redirect', 'partial');
            }
            if (status !== 200) throw new ExtractionError('HTTP_' + status, report.stage);
            if (!/^text\/html(?:\s*;|\s*$)/i.test(type)) throw new ExtractionError('INVALID_CONTENT_TYPE', report.stage);
            if (new URL(finalUrl).origin !== new URL(input.url).origin)
                throw new ExtractionError('UNEXPECTED_REDIRECT', 'redirect', 'partial');
            report.finalUrl = safeUrl(finalUrl);
            report.pageSelection = selectionState(input.url, finalUrl);
            if (item.contentLengthBytes > input.maxHtmlBytes) throw new ExtractionError('RESPONSE_TOO_LARGE', report.stage, 'partial');
            if (!response.body) throw new ExtractionError('EMPTY_RESPONSE', report.stage);
            const chunks = []; let size = 0;
            item.bodyRead.status = 'reading';
            for await (const chunk of response.body) {
                if (controller.signal.aborted) throw new ExtractionError('ABORTED', report.stage, 'aborted');
                size += chunk.byteLength; item.bodyRead.bytes = size;
                if (size > input.maxHtmlBytes) throw new ExtractionError('RESPONSE_TOO_LARGE', report.stage, 'partial');
                chunks.push(Buffer.from(chunk));
            }
            if (controller.signal.aborted) throw new ExtractionError('ABORTED', report.stage, 'aborted');
            const document = Buffer.concat(chunks).toString('utf8');
            item.bodyRead.status = 'read';
            if (!document.trim()) throw new ExtractionError('EMPTY_RESPONSE', report.stage);
            if (visibleChallenge(document)) throw new ExtractionError('ACCESS_CHALLENGE', 'html-validation', 'blocked');
            html = document; report.htmlSource = 'http-response';
            report.htmlReadySeconds = (performance.now() - started) / 1000;
            event('HTML_LISTO', { transport: 'undici', bytes: size, source: report.htmlSource, commercialValidationPending: true });
        }
        await bounded(readDocument(), timeoutMs, controller.signal, 'http-request');
        report.status = 'received';
    } catch (error) {
        html = '';
        const diagnosis = connectionFailure(error, { stage: report.stage, proxy: Boolean(proxy),
            elapsedMs: performance.now() - started, aborted: Boolean(signal?.aborted), timedOut: timedOut || error?.code === 'TIMEOUT' });
        const known = error instanceof ExtractionError && !timedOut && !signal?.aborted;
        report.error = { code: known ? error.code : diagnosis.code, stage: known ? error.stage : report.stage };
        report.status = known ? error.status : diagnosis.code === 'ABORTED' ? 'aborted' : diagnosis.code === 'TIMEOUT' ? 'partial' : 'error';
        report.failureStage = report.error.stage;
        if (!known) report.connectionDiagnostic = diagnosis;
        const body = report.requests.at(-1)?.bodyRead;
        if (body?.status === 'reading') body.status = 'failed';
        event('PARADA', { transport: 'undici', status: report.status, ...report.error }, 'warning');
    } finally {
        clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', abort);
        const closeStart = performance.now();
        const closeRemaining = () => Math.max(1, Math.min(2000 - (performance.now() - closeStart),
            budget ? budget.remaining() : Infinity));
        if (response?.body && !response.body.locked) {
            try { await bounded(Promise.resolve().then(() => response.body.cancel()), Math.min(200, closeRemaining()), null, 'http-body-close'); } catch { /* Aborting already releases fetch resources. */ }
        }
        if (dispatcher) {
            try { await bounded(Promise.resolve().then(() => dispatcher.close()), Math.min(1000, closeRemaining()), null, 'http-close'); report.dispatcherClosed = true; }
            catch {
                report.closeError = 'DISPATCHER_CLOSE_FAILED';
                try { await bounded(Promise.resolve().then(() => dispatcher.destroy()), closeRemaining(), null, 'http-destroy'); report.dispatcherClosed = true; report.dispatcherDestroyed = true; }
                catch { report.closeError = 'DISPATCHER_DESTROY_FAILED'; }
            }
        }
        report.closeSeconds = (performance.now() - closeStart) / 1000;
        report.seconds = (performance.now() - started) / 1000;
        event('ADQUISICION', { transport: 'undici', status: report.status, seconds: report.seconds,
            httpRequestCount: report.httpRequestCount, dispatcherClosed: report.dispatcherClosed });
    }
    return { html, responses: {}, acquisition: report };
}
