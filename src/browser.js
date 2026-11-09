
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
export async function acquire(input, { proxy = null, proxyMode = 'direct', budget, signal, browserType = chromium } = {}) {
    const started = performance.now(), remaining = () => Math.min(budget.remaining(budget.acquisition), budget.remaining());
    const tlsVerified = proxyMode !== 'unblocker';
    const report = { status: 'running', navigationCount: 0, directApiRequests: 0, requests: [], redirects: [],
        resourceErrors: [], navigationFailures: [], browserClosed: false, stage: 'browser-start', tlsVerified,
        http2Disabled: input.disableHttp2 === true };
    report.proxyTransport = { mode: proxyMode, configured: Boolean(proxy),
        usernameProvided: Boolean(proxy?.username), passwordProvided: Boolean(proxy?.password),
        credentialBinding: proxy ? 'playwright-launch-fields' : 'none' };
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
            ...(report.http2Disabled ? { args: ['--disable-http2'] } : {}),
            ...(process.platform === 'win32' && process.env.APIFY_IS_AT_HOME !== '1' ? { channel: 'chrome' } : {}),
            timeout: Math.max(1, remaining() - 2000), ...(proxy ? { proxy } : {}) });
        launch.then(b => { if (closing) b.close().catch(() => {}); }, () => {});
        browser = await bounded(launch, remaining() - 2000, signal, 'browser-start');
        report.browserStartupSeconds = (performance.now() - started) / 1000;
        context = await bounded(browser.newContext({ ignoreHTTPSErrors: !tlsVerified }), remaining() - 2000, signal, 'context-start');
        event('PROXY_TRANSPORTE', { ...report.proxyTransport, http2Disabled: report.http2Disabled });
        event('TLS', { verified: tlsVerified });
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
            const diagnosis = navigationFailure(request.failure()?.errorText, 'navigation', 'requestfailed');
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
            const failure = classifyHttp(category, status, explicit);
            if (!doc && !kind && !explicit && status < 400) return;
            const item = { url: safeUrl(response.url()), category, httpStatus: status, contentType: headers['content-type'] ?? '',
                contentLengthBytes: /^\d+$/.test(headers['content-length'] ?? '') ? Number(headers['content-length']) : null,
                cfRay: headers['cf-ray'] ?? null };
            report.requests.push(item); event('HTTP', item);
            if (failure) {
                report.cfRay = item.cfRay;
                fail(failure.status, failure.code, doc ? 'navigation' : 'commercial-response');
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
        event('NAVEGACION', { count: 1, max: 1, waitUntil: 'domcontentloaded', retries: 0 });
        const navigationStarted = performance.now();
        const navigation = page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: Math.max(1, remaining() - 2000) })
            .then(async () => {
                if (report.error || accepted) return;
                const document = await page.content();
                offerHtml(document, 'rendered-dom', page.url());
            }).catch(error => {
                if (accepted || closing || report.error) return;
                const documents = report.requests.filter(r => r.category === 'document');
                report.navigationError = { ...navigationFailure(error, 'navigation', 'page.goto'),
                    seconds: (performance.now() - navigationStarted) / 1000,
                    documentResponsesObserved: documents.length, httpStatus: documents.at(-1)?.httpStatus ?? null,
                    requestFailureSignals: [...new Set(report.navigationFailures.flatMap(d => d.signals))] };
                event('CAUSA_NAVEGACION', report.navigationError, 'warning');
                fail(report.navigationError.code === 'TIMEOUT' ? 'partial' : 'error', report.navigationError.code);
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
        event('ADQUISICION', { status: report.status, seconds: report.seconds, navigationCount: report.navigationCount, browserClosed: report.browserClosed });
    }
    return { html, responses, acquisition: report };
}
