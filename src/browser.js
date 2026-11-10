
import { chromium } from 'playwright';
import { load } from 'cheerio';
import { bounded, memoryObservation } from './budget.js';
import { classifyHttp, event, navigationFailure } from './diagnostics.js';
import { challengeUrl, safeUrl, selectionState } from './input.js';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function visibleChallenge(html) {
    const $ = load(html), title = $('title').text();
    $('script,style,noscript').remove();
    return /just a moment|verify.*human|security verification|captcha/i.test(title) || /bot-need-challenge/i.test($('body').text());
}
function proxyChainFailure(status, statusText) {
    // proxy-chain writes a custom status text: upstream responses use
    // `UPSTREAM<status>`; socket errors use their Node error code. Its
    // CONNECT failure codes are reserved by the library for this bridge.
    if (status === 597 && /^UPSTREAM(?:401|407)$/.test(statusText))
        return { code: 'PROXY_UPSTREAM_AUTH_REJECTED', category: 'upstream-auth-rejected' };
    if (status === 590 && /^UPSTREAM\d{3}$/.test(statusText))
        return { code: 'PROXY_UPSTREAM_HTTP_ERROR', category: 'upstream-response' };
    const failures = {
        504: { code: 'PROXY_UPSTREAM_CONNECTION_ERROR', category: 'upstream-timeout', reasons: ['ETIMEDOUT'] },
        592: { code: 'PROXY_UPSTREAM_CONNECTION_ERROR', category: 'upstream-response', reasons: [/^UPSTREAM\d+$/] },
        593: { code: 'PROXY_UPSTREAM_CONNECTION_ERROR', category: 'upstream-dns', reasons: ['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME'] },
        594: { code: 'PROXY_UPSTREAM_CONNECTION_ERROR', category: 'upstream-connection', reasons: ['ECONNREFUSED'] },
        595: { code: 'PROXY_UPSTREAM_CONNECTION_ERROR', category: 'upstream-connection', reasons: ['ECONNRESET'] },
        596: { code: 'PROXY_UPSTREAM_CONNECTION_ERROR', category: 'upstream-connection', reasons: ['EPIPE'] },
        599: { code: 'PROXY_UPSTREAM_CONNECTION_ERROR', category: 'upstream-connection', reasons: ['Upstream Closed Early', 'ECONNRESET', 'ETIMEDOUT'] },
    };
    const failure = failures[status];
    return failure?.reasons.some(reason => reason instanceof RegExp ? reason.test(statusText) : reason === statusText)
        ? { code: failure.code, category: failure.category } : null;
}
function proxyBridgeNavigationFailure(diagnosis) {
    if (diagnosis.category === 'proxy-authentication')
        return { code: 'PROXY_UPSTREAM_AUTH_REJECTED', category: 'upstream-auth-rejected' };
    if (diagnosis.category === 'proxy-connection' || diagnosis.category === 'proxy-tunnel')
        return { code: 'PROXY_BRIDGE_CONNECTION_ERROR', category: 'bridge-connection-undetermined' };
    return null;
}
const RECOVERY_DELAY_MS = 2500;
// Keep enough time for a cold browser start, navigation, and bounded close.
const MIN_SECOND_ATTEMPT_WINDOW_MS = 10000;
const CLEANUP_RESERVE_MS = 2000;

async function acquireAttempt(input, { proxy = null, proxyMode = 'direct', budget, signal, browserType = chromium,
    attemptNumber = 1, transport = 'chromium', proxyBridge = false } = {}) {
    const started = performance.now(), remaining = () => Math.min(budget.remaining(budget.acquisition), budget.remaining());
    const tlsVerified = proxyMode !== 'unblocker';
    const report = { status: 'running', navigationCount: 0, directApiRequests: 0, requests: [], redirects: [],
        resourceErrors: [], navigationFailures: [], browserClosed: false, stage: 'browser-start', tlsVerified,
        http2Disabled: transport === 'chromium' && input.disableHttp2 === true, attemptNumber,
        ...(transport === 'chromium' ? {} : { transport }) };
    report.proxyTransport = { mode: proxyMode, configured: Boolean(proxy),
        usernameProvided: proxyBridge ? false : Boolean(proxy?.username),
        passwordProvided: proxyBridge ? false : Boolean(proxy?.password),
        credentialBinding: proxyBridge ? 'proxy-chain-loopback' : proxy ? 'playwright-launch-fields' : 'none' };
    let browser, context, page, html = '', accepted = false, closing = false;
    const responses = {}, tasks = new Set(), ready = deferred(), stopped = deferred(), deniedOptional = new Set();
    const origin = new URL(input.url).origin, base = '/product-page/products/' + input.productId;
    const paths = input.productId === null ? new Map()
        : new Map([[base, 'product'], [base + '/pickers', 'pickers'], [base + '/technical_specifications', 'specifications']]);
    function fail(status, code, stage = report.stage) {
        if (report.error) return;
        report.status = status; report.failureStage = stage; report.error = { code, stage };
        event('PARADA', { status, code, stage }, 'warning'); stopped.resolve();
    }
    function offerHtml(value, source, url, challengeChecked = false) {
        if (report.error || accepted) return;
        const doc = report.requests.filter(r => r.category === 'document').at(-1);
        if (!doc || doc.httpStatus !== 200 || !doc.contentType.includes('text/html')) return;
        if (typeof value !== 'string' || Buffer.byteLength(value) > input.maxHtmlBytes) { fail('partial', 'HTML_TOO_LARGE'); return; }
        if (!challengeChecked && visibleChallenge(value)) { fail('blocked', 'ACCESS_CHALLENGE', 'html-validation'); return; }
        html = value; accepted = true; report.htmlSource = source; report.finalUrl = safeUrl(url);
        report.pageSelection = selectionState(input.url, url);
        report.htmlReadySeconds = (performance.now() - started) / 1000;
        event('HTML_LISTO', { bytes: Buffer.byteLength(value), source, commercialValidationPending: true });
        ready.resolve();
    }
    async function readResponse(response, item, kind) {
        item.bodyRead = { status: 'reading', bytes: null };
        try {
            if (Number(response.headers()['content-length']) > input.maxHtmlBytes) { fail('partial', 'RESPONSE_TOO_LARGE'); return; }
            const raw = await response.body();
            item.bodyRead = { status: 'read', bytes: raw.length };
            event('CUERPO', { kind: item.category, bytes: raw.length, contentLengthBytes: item.contentLengthBytes });
            if (raw.length > input.maxHtmlBytes) { fail('partial', 'RESPONSE_TOO_LARGE'); return; }
            if (kind) {
                if (!item.contentType.includes('application/json')) return;
                const obj = JSON.parse(raw.toString('utf8'));
                const valid = obj && !Array.isArray(obj) && typeof obj === 'object' && (
                    kind === 'product' ? obj.titles && Array.isArray(obj.images)
                    : kind === 'pickers' ? Array.isArray(obj.pickerGroups) : Array.isArray(obj.specifications));
                item.validJson = Boolean(valid);
                if (raw.includes(Buffer.from('bot-need-challenge'))) { fail('blocked', 'ACCESS_CHALLENGE', 'commercial-json'); return; }
                if (valid) responses[kind] = obj;
            } else {
                const document = raw.toString('utf8');
                if (visibleChallenge(document)) { fail('blocked', 'ACCESS_CHALLENGE', 'html-validation'); return; }
                if ((input.productId === null || document.toLowerCase().includes(input.productId))
                    && ['selectedOffer', 'pickerGroups', 'specifications'].every(k => document.includes(k)))
                    // This exact response body has already passed the challenge check above.
                    offerHtml(document, 'navigation-response', response.url(), true);
            }
        } catch (error) {
            item.bodyRead = { ...item.bodyRead, status: 'failed', code: 'RESPONSE_READ_OR_VALIDATION_ERROR',
                errorType: error?.name === 'SyntaxError' ? 'SyntaxError' : 'ResponseError' };
            event('LECTURA', { category: item.category, code: item.bodyRead.code, bytesRead: item.bodyRead.bytes }, 'warning');
        }
    }
    let monitor;
    try {
        const launch = browserType.launch({ headless: process.env.APIFY_IS_AT_HOME === '1' || process.platform !== 'win32',
            ...(transport === 'chromium' && report.http2Disabled ? { args: ['--disable-http2'] } : {}),
            ...(transport === 'chromium' && process.platform === 'win32' && process.env.APIFY_IS_AT_HOME !== '1' ? { channel: 'chrome' } : {}),
            timeout: Math.max(1, remaining() - 2000), ...(proxy ? { proxy } : {}) });
        launch.then(b => { if (closing) b.close().catch(() => {}); }, () => {});
        browser = await bounded(launch, remaining() - 2000, signal, 'browser-start');
        report.browserStartupSeconds = (performance.now() - started) / 1000;
        context = await bounded(browser.newContext({ ignoreHTTPSErrors: !tlsVerified }), remaining() - 2000, signal, 'context-start');
        event('PROXY_TRANSPORTE', { ...(transport === 'chromium' ? {} : { transport }), ...report.proxyTransport,
            http2Disabled: report.http2Disabled });
        event('TLS', { ...(transport === 'chromium' ? {} : { transport }), verified: tlsVerified });
        page = await context.newPage();
        // Bind events and routes before the only Page.goto().
        await page.route('**/*', async route => {
            const request = route.request(), url = new URL(request.url());
            if (deniedOptional.has(url.origin + url.pathname)) return route.abort();
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
                if (challengeUrl(request.url())) { fail('blocked', 'ACCESS_CHALLENGE', 'redirect'); return route.abort(); }
                if (url.origin !== origin) { fail('partial', 'UNEXPECTED_REDIRECT', 'redirect'); return route.abort(); }
            }
            return route.continue();
        });
        page.on('requestfailed', request => {
            if (closing || accepted || !request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
            let diagnosis = navigationFailure(request.failure()?.errorText, 'navigation', 'requestfailed');
            const bridgeFailure = proxyBridge ? proxyBridgeNavigationFailure(diagnosis) : null;
            if (bridgeFailure) {
                diagnosis = { ...diagnosis, ...bridgeFailure, stage: 'proxy-bridge' };
                event('PROXY_BRIDGE', { status: 'error', code: bridgeFailure.code, category: bridgeFailure.category }, 'warning');
            }
            report.navigationFailures.push(diagnosis); report.navigationFailures = report.navigationFailures.slice(-4);
            event('REQUEST_FAILED', { code: diagnosis.code, category: diagnosis.category, signals: diagnosis.signals }, 'warning');
        });
        page.on('response', response => {
            const url = new URL(response.url()), headers = response.headers();
            const doc = response.request().isNavigationRequest() && response.frame() === page.mainFrame();
            const kind = url.origin === origin ? paths.get(url.pathname) : null;
            const category = doc ? 'document' : kind ? 'commercial'
                : url.origin === origin && /^\/reviews\/v1\/products\/[^/]+\/reviews\/?$/.test(url.pathname) ? 'optional'
                : url.origin === origin && url.pathname.startsWith('/cdn-cgi/challenge-platform/') ? 'protection' : 'secondary';
            const status = response.status();
            if (report.firstHttpSeconds === undefined) report.firstHttpSeconds = (performance.now() - started) / 1000;
            const location = headers.location;
            if (location && [301,302,303,307,308].includes(status)) {
                const target = new URL(location, response.url()).href;
                report.redirects.push({ sourceUrl: safeUrl(response.url()), targetUrl: safeUrl(target), httpStatus: status,
                    type: challengeUrl(target) ? 'verification' : 'normal', cfRay: headers['cf-ray'] ?? null });
                event('REDIRECCION', report.redirects.at(-1));
            }
            const explicit = url.origin === origin && (headers['cf-mitigated'] === 'challenge' || challengeUrl(response.url())
                || (doc && location && challengeUrl(new URL(location, response.url()).href)));
            const bridgeFailure = proxyBridge ? proxyChainFailure(status, response.statusText()) : null;
            const failure = bridgeFailure ? { status: 'error', code: bridgeFailure.code }
                : proxyBridge && status === 407 ? { status: 'error', code: 'HTTP_407' }
                : classifyHttp(category, status, explicit);
            if (!doc && !kind && !explicit && status < 400) return;
            const item = { url: safeUrl(response.url()), category, httpStatus: status, contentType: headers['content-type'] ?? '',
                contentLengthBytes: /^\d+$/.test(headers['content-length'] ?? '') ? Number(headers['content-length']) : null,
                cfRay: headers['cf-ray'] ?? null,
                ...(bridgeFailure ? { proxyBridgeFailure: bridgeFailure.category } : {}) };
            report.requests.push(item); event('HTTP', item);
            if (failure) {
                report.cfRay = item.cfRay;
                if (bridgeFailure)
                    event('PROXY_BRIDGE', { status: 'error', code: bridgeFailure.code, category: bridgeFailure.category,
                        upstreamStatus: status }, 'warning');
                fail(failure.status, failure.code, bridgeFailure ? 'proxy-bridge' : doc ? 'navigation' : 'commercial-response');
                return;
            }
            if (status >= 400) {
                report.resourceErrors.push(item);
                event(category === 'optional' ? 'RECURSO_OPCIONAL' : 'RECURSO_SECUNDARIO', { status, category }, 'warning');
                if (category === 'optional') deniedOptional.add(url.origin + url.pathname);
            }
            if (status === 200 && (doc || kind)) {
                const task = readResponse(response, item, kind); tasks.add(task); task.finally(() => tasks.delete(task));
            }
        });
        monitor = setInterval(() => { memoryObservation().then(observation => {
            report.memory = observation;
            if (observation.mb > input.maxMemoryMb) fail('partial', 'MEMORY_LIMIT', 'resources');
        }).catch(() => {}); }, 1000);
        report.stage = 'navigation'; report.navigationCount = 1;
        event('NAVEGACION', { ...(transport === 'chromium' ? {} : { transport }), count: 1, max: 1, waitUntil: 'domcontentloaded', retries: 0 });
        const navigationStarted = performance.now();
        const navigation = page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: Math.max(1, remaining() - 2000) })
            .then(async () => {
                if (report.error || accepted) return;
                const document = await page.content();
                offerHtml(document, 'rendered-dom', page.url());
            }).catch(error => {
                if (accepted || closing || report.error) return;
                const documents = report.requests.filter(r => r.category === 'document');
                let diagnosis = navigationFailure(error, 'navigation', 'page.goto');
                const bridgeFailure = proxyBridge ? proxyBridgeNavigationFailure(diagnosis) : null;
                if (bridgeFailure) {
                    diagnosis = { ...diagnosis, ...bridgeFailure, stage: 'proxy-bridge' };
                    event('PROXY_BRIDGE', { status: 'error', code: bridgeFailure.code, category: bridgeFailure.category }, 'warning');
                }
                report.navigationError = { ...diagnosis,
                    seconds: (performance.now() - navigationStarted) / 1000,
                    documentResponsesObserved: documents.length, httpStatus: documents.at(-1)?.httpStatus ?? null,
                    requestFailureSignals: [...new Set(report.navigationFailures.flatMap(d => d.signals))] };
                event('CAUSA_NAVEGACION', report.navigationError, 'warning');
                fail(report.navigationError.code === 'TIMEOUT' ? 'partial' : 'error', report.navigationError.code,
                    bridgeFailure ? 'proxy-bridge' : 'navigation');
            });
        await bounded(Promise.race([ready.promise, stopped.promise, navigation]), remaining() - 2000, signal, 'navigation');
        if (accepted && !report.error) {
            if (tasks.size) await Promise.race([Promise.allSettled([...tasks]), new Promise(r => setTimeout(r, Math.min(200, remaining())))]);
            if (!report.error) report.status = 'received';
        } else if (!report.error) fail('partial', 'NO_HTML_RECEIVED');
    } catch (error) {
        if (!report.error) {
            report.navigationError = navigationFailure(error, report.stage, 'acquire');
            fail(error?.status ?? 'error', report.navigationError.code, report.stage);
        }
    } finally {
        closing = true; clearInterval(monitor); report.stage = 'browser-close';
        const startClose = performance.now();
        if (browser) try { await bounded(browser.close(), 2000, null, 'browser-close'); report.browserClosed = true; } catch { report.closeError = 'BROWSER_CLOSE_TIMEOUT'; }
        report.closeSeconds = (performance.now() - startClose) / 1000;
        report.seconds = (performance.now() - started) / 1000;
        if (html && report.status !== 'received') report.candidateBeforeAccessFailure = true;
        event('ADQUISICION_INTENTO', { attempt: attemptNumber, status: report.status, seconds: report.seconds,
            navigationCount: report.navigationCount, browserClosed: report.browserClosed });
    }
    return { html, responses, acquisition: report };
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitForRecovery(ms, signal, sleepImpl) {
    if (signal?.aborted) return false;
    let onAbort;
    const aborted = new Promise(resolve => {
        onAbort = () => resolve(false);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([Promise.resolve().then(() => sleepImpl(ms)).then(() => true), aborted]);
    } finally { signal?.removeEventListener('abort', onAbort); }
}
function timeRemaining(budget) {
    return Math.max(0, Math.min(budget.remaining(budget.acquisition), budget.remaining()));
}
function seconds(ms) { return Math.round(ms) / 1000; }
function retryEligible(result) {
    const report = result?.acquisition;
    return report?.error?.code === 'CHROMIUM_ERR_TOO_MANY_RETRIES'
        && report.failureStage === 'navigation'
        && report.navigationError?.source === 'page.goto'
        && report.navigationError.documentResponsesObserved === 0
        && !report.requests.some(request => request.category === 'document');
}
function attemptSummary(result, number, remainingMs) {
    const report = result.acquisition;
    return { number, seconds: report.seconds, remainingSeconds: seconds(remainingMs), status: report.status,
        navigationCount: report.navigationCount, browserClosed: report.browserClosed,
        code: report.error?.code ?? null,
        documentResponsesObserved: report.navigationError?.documentResponsesObserved ?? null,
        httpStatus: report.navigationError?.httpStatus ?? report.requests.filter(r => r.category === 'document').at(-1)?.httpStatus ?? null };
}
function finalizeAttempts(result, attempts, started, recovery) {
    const report = result.acquisition;
    report.attempts = attempts;
    report.attemptCount = attempts.length;
    report.navigationCount = attempts.reduce((count, attempt) => count + attempt.navigationCount, 0);
    report.seconds = (performance.now() - started) / 1000;
    report.recovery = recovery;
    // Retain observations from both navigations while keeping the HTML and
    // commercial response objects strictly from the final attempt.
    for (const key of ['requests', 'redirects', 'resourceErrors', 'navigationFailures']) {
        const earlier = attempts.length > 1 ? result._earlierAcquisition?.[key] ?? [] : [];
        report[key] = [...earlier, ...(report[key] ?? [])];
    }
    delete result._earlierAcquisition;
    event('ADQUISICION', { status: report.status, seconds: report.seconds, navigationCount: report.navigationCount,
        attempts: report.attemptCount, browserClosed: report.browserClosed, recoveryAttempted: recovery.attempted });
    return result;
}

export async function acquire(input, options = {}) {
    const started = performance.now();
    const { budget, signal, sleepImpl = delay } = options;
    event('INTENTO', { number: '1/2', phase: 'starting', remainingSeconds: seconds(timeRemaining(budget)) });
    const first = await acquireAttempt(input, { ...options, attemptNumber: 1 });
    const attempts = [attemptSummary(first, 1, timeRemaining(budget))];
    event('INTENTO_RESULTADO', { ...attempts[0], totalNavigationCount: attempts[0].navigationCount });
    let recovery = { attempted: false, skippedReason: null, initialFailure: null };
    if (!retryEligible(first)) {
        recovery.skippedReason = 'not-eligible';
        return finalizeAttempts(first, attempts, started, recovery);
    }

    recovery.initialFailure = first.acquisition.navigationError;
    if (!first.acquisition.browserClosed) {
        recovery.skippedReason = 'browser-close-failed';
        event('RECUPERACION_OMITIDA', { reason: recovery.skippedReason, code: first.acquisition.closeError ?? 'BROWSER_NOT_CLOSED' }, 'warning');
        return finalizeAttempts(first, attempts, started, recovery);
    }

    const beforeWaitMs = timeRemaining(budget);
    if (beforeWaitMs < RECOVERY_DELAY_MS + MIN_SECOND_ATTEMPT_WINDOW_MS + CLEANUP_RESERVE_MS) {
        recovery.skippedReason = 'insufficient-time';
        event('RECUPERACION_OMITIDA', { reason: recovery.skippedReason, remainingSeconds: seconds(beforeWaitMs),
            requiredSeconds: seconds(RECOVERY_DELAY_MS + MIN_SECOND_ATTEMPT_WINDOW_MS + CLEANUP_RESERVE_MS) }, 'warning');
        return finalizeAttempts(first, attempts, started, recovery);
    }

    event('RECUPERACION', { motivo: 'CHROMIUM_ERR_TOO_MANY_RETRIES', remainingSeconds: seconds(beforeWaitMs),
        delaySeconds: seconds(RECOVERY_DELAY_MS), maxNavigations: 2 });
    event('ESPERA_RECUPERACION', { seconds: seconds(RECOVERY_DELAY_MS) });
    const waited = await waitForRecovery(RECOVERY_DELAY_MS, signal, sleepImpl);
    if (!waited) {
        recovery.skippedReason = signal?.aborted ? 'aborted' : 'wait-interrupted';
        event('RECUPERACION_OMITIDA', { reason: recovery.skippedReason, remainingSeconds: seconds(timeRemaining(budget)) }, 'warning');
        return finalizeAttempts(first, attempts, started, recovery);
    }
    const afterWaitMs = timeRemaining(budget);
    if (afterWaitMs < MIN_SECOND_ATTEMPT_WINDOW_MS + CLEANUP_RESERVE_MS) {
        recovery.skippedReason = 'insufficient-time-after-wait';
        event('RECUPERACION_OMITIDA', { reason: recovery.skippedReason, remainingSeconds: seconds(afterWaitMs) }, 'warning');
        return finalizeAttempts(first, attempts, started, recovery);
    }
    if (signal?.aborted) {
        recovery.skippedReason = 'aborted';
        return finalizeAttempts(first, attempts, started, recovery);
    }

    recovery.attempted = true;
    event('INTENTO', { number: '2/2', phase: 'starting', remainingSeconds: seconds(afterWaitMs),
        navigationCount: attempts.reduce((count, attempt) => count + attempt.navigationCount, 0) });
    const second = await acquireAttempt(input, { ...options, attemptNumber: 2 });
    attempts.push(attemptSummary(second, 2, timeRemaining(budget)));
    event('INTENTO_RESULTADO', { ...attempts[1], totalNavigationCount: attempts.reduce((count, attempt) => count + attempt.navigationCount, 0) });
    recovery.acquisitionReceived = second.acquisition.status === 'received';
    recovery.finalCode = second.acquisition.error?.code ?? null;
    second._earlierAcquisition = first.acquisition;
    return finalizeAttempts(second, attempts, started, recovery);
}

// Single browser acquisition shared by the non-retrying Firefox transport.
export async function acquireOnce(input, options = {}) {
    const { budget, transport = 'chromium' } = options;
    event('INTENTO', { number: '1/1', transport, phase: 'starting', remainingSeconds: seconds(timeRemaining(budget)) });
    const result = await acquireAttempt(input, { ...options, attemptNumber: 1, transport });
    const summary = attemptSummary(result, 1, timeRemaining(budget));
    result.acquisition.attempts = [summary];
    result.acquisition.attemptCount = 1;
    event('INTENTO_RESULTADO', { ...summary, totalNavigationCount: summary.navigationCount });
    event('ADQUISICION', { status: result.acquisition.status, seconds: result.acquisition.seconds,
        navigationCount: result.acquisition.navigationCount, attempts: 1, browserClosed: result.acquisition.browserClosed,
        transport });
    return result;
}
