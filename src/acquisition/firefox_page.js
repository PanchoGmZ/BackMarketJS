
import { firefox } from 'playwright';
import { load } from 'cheerio';
import { bounded, memoryObservation } from '../shared/budget.js';
import { classifyHttp, event, navigationFailure } from '../shared/diagnostics.js';
import { challengeUrl, safeUrl, selectionState } from '../platform/input.js';

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
async function acquireAttempt(input, { proxy = null, proxyMode = 'direct', budget, signal, browserType = firefox,
    attemptNumber = 1, proxyBridge = false, localDirect = false } = {}) {
    const started = performance.now(), remaining = () => Math.min(budget.remaining(budget.acquisition), budget.remaining());
    const tlsVerified = proxyMode !== 'unblocker';
    const fastMode = input.firefoxFastMode === true;
    const report = { status: 'running', navigationCount: 0, directApiRequests: 0, requests: [], redirects: [],
        resourceErrors: [], navigationFailures: [], browserClosed: false, stage: 'browser-start', tlsVerified,
        attemptNumber, transport: 'firefox',
        fastMode, fastModeBlockedResources: { image: 0, font: 0, media: 0 }, timings: {
            browserLaunchSeconds: null, contextSetupSeconds: null, pageSetupSeconds: null, routeSetupSeconds: null,
            navigationWaitUntil: fastMode ? 'commit' : 'domcontentloaded', navigationStartedSeconds: null,
            documentHeadersSeconds: null, documentBodyReadSeconds: null, navigationWaitSeconds: null,
            domContentLoadedSeconds: null, pageContentSeconds: null, htmlPreparationSeconds: 0, browserCloseSeconds: null,
        } };
    report.proxyTransport = { mode: proxyMode, configured: Boolean(proxy),
        usernameProvided: proxyBridge ? false : Boolean(proxy?.username),
        passwordProvided: proxyBridge ? false : Boolean(proxy?.password),
        credentialBinding: proxyBridge ? 'proxy-chain-loopback' : proxy ? 'playwright-launch-fields' : 'none' };
    let browser, context, page, html = '', accepted = false, closing = false;
    const manualAllowed = localDirect && !proxy && proxyMode === 'direct';
    let challengeSeen = false, challengeStarted = null, challengeTimer;
    const manualChallengeUrl = value => {
        try { const u = new URL(value); return u.origin === origin && /^\/testchallengepage\/?$/i.test(u.pathname); } catch { return false; }
    };
    const responses = {}, tasks = new Set(), ready = deferred(), stopped = deferred();
    const mainDocumentRead = deferred();
    let mainDocumentTask = null, deniedOptional = new Set(), navigationStarted = null;
    const origin = new URL(input.url).origin, base = '/product-page/products/' + input.productId;
    const paths = input.productId === null ? new Map()
        : new Map([[base, 'product'], [base + '/pickers', 'pickers'], [base + '/technical_specifications', 'specifications']]);
    function fail(status, code, stage = report.stage) {
        if (report.error) return;
        report.status = status; report.failureStage = stage; report.error = { code, stage };
        event('PARADA', { status, code, stage }, 'warning'); stopped.resolve();
    }
    function offerHtml(value, source, url, challengeChecked = false) {
        const prepareStarted = report.timings ? performance.now() : null;
        try {
            if (report.error || accepted) return;
            if (challengeSeen && (manualChallengeUrl(url) || new URL(url).origin !== origin || !/^\/en-us\/p\//i.test(new URL(url).pathname)
                || !['selectedOffer', 'pickerGroups', 'specifications'].every(k => value.includes(k)))) return;
            const doc = report.requests.filter(r => r.category === 'document').at(-1);
            if (!doc || doc.httpStatus !== 200 || !doc.contentType.includes('text/html')) return;
            if (typeof value !== 'string' || Buffer.byteLength(value) > input.maxHtmlBytes) { fail('partial', 'HTML_TOO_LARGE'); return; }
            if (!challengeChecked && visibleChallenge(value)) { fail('blocked', 'ACCESS_CHALLENGE', 'html-validation'); return; }
            html = value; accepted = true; report.htmlSource = source; report.finalUrl = safeUrl(url);
            report.pageSelection = selectionState(input.url, url);
            report.htmlReadySeconds = (performance.now() - started) / 1000;
            event('HTML_LISTO', { bytes: Buffer.byteLength(value), source, commercialValidationPending: true });
            if (challengeSeen) event('DESAFIO_LOCAL', { resultado: 'verificacion_completada', segundos: challengeStarted === null ? null : (performance.now() - challengeStarted) / 1000, urlFinal: safeUrl(url) });
            ready.resolve();
        } finally {
            if (report.timings) report.timings.htmlPreparationSeconds += (performance.now() - prepareStarted) / 1000;
        }
    }
    async function readResponse(response, item, kind) {
        const bodyStarted = report.timings && item.category === 'document' ? performance.now() : null;
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
                if (manualAllowed && manualChallengeUrl(response.url())) return;
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
        } finally {
            if (report.timings && item.category === 'document')
                report.timings.documentBodyReadSeconds = (performance.now() - bodyStarted) / 1000;
        }
    }
    let monitor;
    try {
        const launch = browserType.launch({ headless: localDirect ? false : process.env.APIFY_IS_AT_HOME === '1' || process.platform !== 'win32',
            timeout: Math.max(1, remaining() - 2000), ...(proxy ? { proxy } : {}) });
        launch.then(b => { if (closing) b.close().catch(() => {}); }, () => {});
        browser = await bounded(launch, remaining() - 2000, signal, 'browser-start');
        report.browserStartupSeconds = (performance.now() - started) / 1000;
        if (report.timings) report.timings.browserLaunchSeconds = report.browserStartupSeconds;
        const contextStarted = performance.now();
        context = await bounded(browser.newContext({ ignoreHTTPSErrors: !tlsVerified }), remaining() - 2000, signal, 'context-start');
        if (report.timings) report.timings.contextSetupSeconds = (performance.now() - contextStarted) / 1000;
        event('PROXY_TRANSPORTE', { transport: 'firefox', ...report.proxyTransport });
        event('TLS', { transport: 'firefox', verified: tlsVerified });
        const pageStarted = performance.now();
        page = await context.newPage();
        if (manualAllowed) {
            page.on('close', () => { if (!closing && challengeSeen && !accepted) fail('blocked', 'ACCESS_CHALLENGE', 'browser-closed'); });
            page.on('domcontentloaded', () => {
                if (challengeSeen && !manualChallengeUrl(page.url()) && !report.error && !accepted) {
                    const task = page.content().then(document => offerHtml(document, 'rendered-dom-after-verification', page.url())).catch(() => {});
                    tasks.add(task); task.finally(() => tasks.delete(task));
                }
                if (!manualChallengeUrl(page.url()) || report.error || accepted) return;
                challengeSeen = true;
                if (challengeStarted !== null) return;
                challengeStarted = performance.now();
                event('DESAFIO_LOCAL', { resultado: 'espera_manual', mensaje: 'Página de verificación detectada. Esperando interacción manual (máximo 25 segundos).', url: safeUrl(page.url()) });
                challengeTimer = setTimeout(() => {
                    event('DESAFIO_LOCAL', { resultado: 'tiempo_agotado', segundos: (performance.now() - challengeStarted) / 1000, urlFinal: safeUrl(page.url()) }, 'warning');
                    fail('blocked', 'ACCESS_CHALLENGE', 'manual-verification');
                }, Math.max(1, Math.min(25000, remaining() - 2000)));
            });
        }
        if (report.timings) report.timings.pageSetupSeconds = (performance.now() - pageStarted) / 1000;
        if (report.timings) page.on('domcontentloaded', () => {
            if (report.timings.domContentLoadedSeconds === null)
                report.timings.domContentLoadedSeconds = (performance.now() - started) / 1000;
        });
        // Bind events and routes before the only Page.goto().
        const routeSetupStarted = performance.now();
        await page.route('**/*', async route => {
            const request = route.request(), url = new URL(request.url());
            if (fastMode) {
                const resourceType = request.resourceType();
                if (Object.hasOwn(report.fastModeBlockedResources, resourceType)) {
                    report.fastModeBlockedResources[resourceType]++;
                    return route.abort();
                }
            }
            if (deniedOptional.has(url.origin + url.pathname)) return route.abort();
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
                if (challengeUrl(request.url()) && !(manualAllowed && manualChallengeUrl(request.url()))) { fail('blocked', 'ACCESS_CHALLENGE', 'redirect'); return route.abort(); }
                if (url.origin !== origin) { fail('partial', 'UNEXPECTED_REDIRECT', 'redirect'); return route.abort(); }
            }
            return route.continue();
        });
        if (report.timings) report.timings.routeSetupSeconds = (performance.now() - routeSetupStarted) / 1000;
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
            if (doc && report.timings && navigationStarted !== null) {
                report.timings.documentHeadersSeconds = (performance.now() - navigationStarted) / 1000;
                if (fastMode)
                    report.timings.navigationWaitSeconds = report.timings.documentHeadersSeconds;
            }
            if (report.firstHttpSeconds === undefined) report.firstHttpSeconds = (performance.now() - started) / 1000;
            const location = headers.location;
            if (location && [301,302,303,307,308].includes(status)) {
                const target = new URL(location, response.url()).href;
                if (manualAllowed && doc && manualChallengeUrl(target)) challengeSeen = true;
                report.redirects.push({ sourceUrl: safeUrl(response.url()), targetUrl: safeUrl(target), httpStatus: status,
                    type: challengeUrl(target) ? 'verification' : 'normal', cfRay: headers['cf-ray'] ?? null });
                event('REDIRECCION', report.redirects.at(-1));
            }
            const explicit = url.origin === origin && (headers['cf-mitigated'] === 'challenge' || challengeUrl(response.url())
                || (doc && location && challengeUrl(new URL(location, response.url()).href)));
            const bridgeFailure = proxyBridge ? proxyChainFailure(status, response.statusText()) : null;
            if (manualAllowed && doc && manualChallengeUrl(response.url())) challengeSeen = true;
            const allowManualResponse = manualAllowed && ((doc && (manualChallengeUrl(response.url()) || (location && manualChallengeUrl(new URL(location, response.url()).href)))) || (challengeSeen && category === 'protection'));
            // A verification document may itself be served with HTTP 403. Let
            // Firefox display only that HTML document for manual interaction.
            const manualChallengeDocument = manualAllowed && doc && status === 403
                && manualChallengeUrl(response.url()) && /\btext\/html\b/i.test(headers['content-type'] ?? '');
            const failure = bridgeFailure ? { status: 'error', code: bridgeFailure.code }
                : proxyBridge && status === 407 ? { status: 'error', code: 'HTTP_407' }
                : manualChallengeDocument ? null
                : classifyHttp(category, status, allowManualResponse ? false : explicit);
            if (!doc && !kind && !explicit && status < 400) return;
            const item = { url: safeUrl(response.url()), category, httpStatus: status, contentType: headers['content-type'] ?? '',
                contentLengthBytes: /^\d+$/.test(headers['content-length'] ?? '') ? Number(headers['content-length']) : null,
                cfRay: headers['cf-ray'] ?? null,
                ...(bridgeFailure ? { proxyBridgeFailure: bridgeFailure.category } : {}) };
            report.requests.push(item); event('HTTP', item);
            if (failure) {
                if (challengeSeen && manualAllowed) event('DESAFIO_LOCAL', { resultado: 'acceso_denegado', codigo: failure.code, segundos: challengeStarted === null ? null : (performance.now() - challengeStarted) / 1000, urlFinal: safeUrl(response.url()) }, 'warning');
                if (doc) mainDocumentRead.resolve(null);
                report.cfRay = item.cfRay;
                if (bridgeFailure)
                    event('PROXY_BRIDGE', { status: 'error', code: bridgeFailure.code, category: bridgeFailure.category,
                        upstreamStatus: status }, 'warning');
                fail(failure.status, failure.code, bridgeFailure ? 'proxy-bridge' : doc ? 'navigation' : 'commercial-response');
                return;
            }
            if (status >= 400 && !manualChallengeDocument) {
                report.resourceErrors.push(item);
                event(category === 'optional' ? 'RECURSO_OPCIONAL' : 'RECURSO_SECUNDARIO', { status, category }, 'warning');
                if (category === 'optional') deniedOptional.add(url.origin + url.pathname);
            }
            if (doc && status !== 200 && ![301,302,303,307,308].includes(status)) mainDocumentRead.resolve(null);
            if (status === 200 && (doc || kind)) {
                const task = readResponse(response, item, kind);
                if (doc) { mainDocumentTask = task; mainDocumentRead.resolve(task); }
                tasks.add(task); task.finally(() => tasks.delete(task));
            }
        });
        monitor = setInterval(() => { memoryObservation().then(observation => {
            report.memory = observation;
            if (observation.mb > input.maxMemoryMb) fail('partial', 'MEMORY_LIMIT', 'resources');
        }).catch(() => {}); }, 1000);
        report.stage = 'navigation'; report.navigationCount = 1;
        const waitUntil = fastMode ? 'commit' : 'domcontentloaded';
        event('NAVEGACION', { transport: 'firefox', count: 1, max: 1, waitUntil, retries: 0 });
        navigationStarted = performance.now();
        if (report.timings) report.timings.navigationStartedSeconds = (navigationStarted - started) / 1000;
        const navigation = page.goto(input.url, { waitUntil, timeout: Math.max(1, remaining() - 2000) })
            .then(async () => {
                if (report.timings) report.timings.navigationWaitSeconds = (performance.now() - navigationStarted) / 1000;
                if (report.error || accepted) return;
                if (manualAllowed && (challengeSeen || manualChallengeUrl(page.url()))) return;
                if (fastMode) {
                    const documentTask = await bounded(Promise.race([
                        mainDocumentRead.promise,
                        stopped.promise.then(() => null),
                    ]), remaining() - 2000, signal, 'document-response');
                    if (report.error) return;
                    if (documentTask) await bounded(documentTask, remaining() - 2000, signal, 'document-body');
                    if (report.error || accepted) return;
                    const contentStarted = performance.now();
                    const document = await page.content();
                    if (report.timings) report.timings.pageContentSeconds = (performance.now() - contentStarted) / 1000;
                    offerHtml(document, 'rendered-dom-fast', page.url());
                    return;
                }
                const document = await page.content();
                offerHtml(document, 'rendered-dom', page.url());
            }).catch(error => {
                if (accepted || closing || report.error) return;
                if (manualAllowed && challengeSeen && !page.isClosed()) return;
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
        if (manualAllowed && challengeSeen && !accepted && !report.error)
            await bounded(Promise.race([ready.promise, stopped.promise]), remaining() - 2000, signal, 'manual-verification');
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
        closing = true; clearInterval(monitor); clearTimeout(challengeTimer); report.stage = 'browser-close';
        const startClose = performance.now();
        if (browser) try { await bounded(browser.close(), 2000, null, 'browser-close'); report.browserClosed = true; } catch { report.closeError = 'BROWSER_CLOSE_TIMEOUT'; }
        report.closeSeconds = (performance.now() - startClose) / 1000;
        if (report.timings) report.timings.browserCloseSeconds = report.closeSeconds;
        report.seconds = (performance.now() - started) / 1000;
        if (html && report.status !== 'received') report.candidateBeforeAccessFailure = true;
        event('ADQUISICION_INTENTO', { attempt: attemptNumber, status: report.status, seconds: report.seconds,
            navigationCount: report.navigationCount, browserClosed: report.browserClosed });
    }
    return { html, responses, acquisition: report };
}

function timeRemaining(budget) {
    return Math.max(0, Math.min(budget.remaining(budget.acquisition), budget.remaining()));
}
function seconds(ms) { return Math.round(ms) / 1000; }
function attemptSummary(result, number, remainingMs) {
    const report = result.acquisition;
    return { number, seconds: report.seconds, remainingSeconds: seconds(remainingMs), status: report.status,
        navigationCount: report.navigationCount, browserClosed: report.browserClosed,
        code: report.error?.code ?? null,
        documentResponsesObserved: report.navigationError?.documentResponsesObserved ?? null,
        httpStatus: report.navigationError?.httpStatus ?? report.requests.filter(r => r.category === 'document').at(-1)?.httpStatus ?? null };
}
export async function acquireOnce(input, options = {}) {
    const { budget } = options;
    event('INTENTO', { number: '1/1', transport: 'firefox', phase: 'starting', remainingSeconds: seconds(timeRemaining(budget)) });
    const result = await acquireAttempt(input, { ...options, attemptNumber: 1 });
    const summary = attemptSummary(result, 1, timeRemaining(budget));
    result.acquisition.attempts = [summary];
    result.acquisition.attemptCount = 1;
    event('INTENTO_RESULTADO', { ...summary, totalNavigationCount: summary.navigationCount });
    event('ADQUISICION', { status: result.acquisition.status, seconds: result.acquisition.seconds,
        navigationCount: result.acquisition.navigationCount, attempts: 1, browserClosed: result.acquisition.browserClosed,
        transport: 'firefox' });
    return result;
}
