import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { MockAgent } from 'undici';
import { load } from 'cheerio';
import { log } from 'apify';
import Ajv from 'ajv';
import { acquire, connectionFailure } from '../src/http_undici.js';
import { parseInput } from '../src/input.js';
import { extractHtml } from '../src/extract.js';
import { fields, assertProduct } from '../src/contract.js';
import { runActor } from '../src/run.js';
import { Budget } from '../src/budget.js';
log.setLevel(log.LEVELS.OFF);
const ids = ['eda80a12-a40b-4faa-b0f6-438bea90f1e5', '393000c0-1f19-43fc-9f89-e6faf3f3bd46'];
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
function fixture(id = ids[0]) {
    const base = './fixtures/reference/' + id + '/';
    const html = read(base + 'commercial.html'), expected = JSON.parse(read(base + 'python-output.json'));
    return { html, expected, data: JSON.parse(load(html)('#captured-commercial-data').html()).data };
}
const inputFor = (url = fixture().expected.url) => parseInput({ url, transport: 'undici', proxyConfiguration: { useApifyProxy: false } });
const response = (body = fixture().html, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
const fakeDispatcher = () => ({ async close() {}, async destroy() {} });
const fakeAcquire = (input, fetchImpl, context = {}) => acquire(input, { makeDispatcher: fakeDispatcher, fetchImpl, ...context });
async function mocked(html = fixture().html, url = fixture().expected.url, status = 200, headers = {}) {
    const mock = new MockAgent(); mock.disableNetConnect();
    const target = new URL(url);
    mock.get(target.origin).intercept({ path: target.pathname + target.search, method: 'GET' })
        .reply(status, html, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
    const result = await acquire(inputFor(url), { makeDispatcher: () => mock });
    mock.assertNoPendingInterceptors();
    return result;
}
class FakeActor {
    constructor(input) { this.input = input; this.records = []; this.values = {}; }
    async init() {}
    async getInput() { return this.input; }
    async setValue(key, value) { this.values[key] = structuredClone(value); }
    async pushData(value) { this.records.push(structuredClone(value)); }
    on() {}
    async exit() {}
}
async function runHttp(acquired, url = fixture().expected.url) {
    const actor = new FakeActor({ url, transport: 'undici', proxyConfiguration: { useApifyProxy: false } });
    const budget = new Budget({ elapsed: () => 0, hardExit: () => assert.fail('Watchdog must not fire') });
    const result = await runActor({ actor, budget, acquireFn: () => assert.fail('No Chromium or fallback'), httpAcquireFn: async () => acquired });
    return { ...result, actor };
}

test('transport defaults to Firefox normal mode; fast mode is opt-in and Firefox-only', () => {
    const schema = JSON.parse(read('../.actor/input_schema.json'));
    const validate = new Ajv({ strict: false }).compile(schema);
    const url = fixture().expected.url;
    assert.equal(schema.properties.transport.default, 'firefox');
    assert.equal(schema.properties.firefoxFastMode.default, false);
    assert.deepEqual(schema.properties.transport.enum, ['chromium', 'firefox', 'undici']);
    assert.equal(parseInput({ url }).transport, 'firefox');
    assert.equal(parseInput({ url }).firefoxFastMode, false);
    for (const transport of ['chromium', 'firefox', 'undici']) { assert.equal(parseInput({ url, transport }).transport, transport); assert.equal(validate({ url, transport }), true); }
    assert.equal(parseInput({ url, transport:'firefox', firefoxFastMode:true }).firefoxFastMode, true);
    assert.equal(validate({ url, transport:'firefox', firefoxFastMode:true }), true);
    assert.throws(() => parseInput({ url, transport:'chromium', firefoxFastMode:true }), e => e.code === 'INVALID_INPUT');
    for (const transport of ['', 'UNDICI', null, false, {}, 'auto']) {
        assert.throws(() => parseInput({ url, transport }), e => e.code === 'INVALID_INPUT');
        assert.equal(validate({ url, transport }), false);
    }
});
test('omitted transport selects Firefox; explicit Chromium retains its acquisition path', async () => {
    for (const [transport, expectedTransport] of [[undefined, 'firefox'], ['firefox', 'firefox'], ['chromium', 'chromium']]) {
        const { html, expected } = fixture();
        const actor = new FakeActor({ url: expected.url, ...(transport ? { transport } : {}), proxyConfiguration: { useApifyProxy: false } });
        let chromiumCalls = 0, firefoxCalls = 0;
        const result = await runActor({ actor, budget: new Budget({ elapsed: () => 0 }),
            acquireFn: async input => { chromiumCalls++; assert.equal(input.transport, 'chromium'); return { html, responses: {}, acquisition: { status: 'received', requests: [] } }; },
            firefoxAcquireFn: async input => { firefoxCalls++; assert.equal(input.transport, 'firefox'); return { html, responses: {}, acquisition: { status: 'received', requests: [] } }; },
            httpAcquireFn: () => assert.fail('Undici must be opt-in') });
        assert.equal(result.exitCode, 0); assert.deepEqual(actor.records, [expected]);
        assert.equal(result.state.transport, expectedTransport); assert.equal(result.state.extractionMethod, 'nuxt');
        assert.equal(chromiumCalls, expectedTransport === 'chromium' ? 1 : 0);
        assert.equal(firefoxCalls, expectedTransport === 'firefox' ? 1 : 0);
    }
});
for (const id of ids) test('Undici MockAgent keeps all eleven reference fields and shared Actor states: ' + id, async () => {
    const { html, expected } = fixture(id);
    const acquired = await mocked(html, expected.url);
    assert.equal(acquired.acquisition.status, 'received'); assert.equal(acquired.acquisition.dispatcherClosed, true);
    assert.equal(acquired.acquisition.httpRequestCount, 1); assert.equal(acquired.acquisition.navigationCount, 0);
    assert.equal(acquired.acquisition.directApiRequests, 0); assert.deepEqual(acquired.responses, {});
    const result = await runHttp(acquired, expected.url);
    assert.equal(result.exitCode, 0); assert.deepEqual(result.actor.records, [expected]);
    assertProduct(result.actor.records[0]); assert.deepEqual(Object.keys(result.actor.records[0]), fields);
    assert.equal(result.state.transport, 'undici'); assert.equal(result.metadata.transport, 'undici');
    assert.equal(result.state.extractionMethod, 'nuxt'); assert.equal(result.metadata.extractionMethod, 'nuxt');
    assert.equal(result.metadata.priceVerification.status, 'verified');
    assert.equal(result.state.status, id === ids[0] ? 'success' : 'partial');
    assert.ok(result.state.timings.acquisition >= 0); assert.ok(result.state.timings.totalWork >= result.state.timings.acquisition);
});
test('real Undici fetch with MockAgent integrates through runActor transport selection', async () => {
    const { html, expected } = fixture(), mock = new MockAgent(); mock.disableNetConnect();
    const url = new URL(expected.url);
    mock.get(url.origin).intercept({ path: url.pathname }).reply(200, html, { headers: { 'content-type': 'text/html' } });
    const actor = new FakeActor({ url: expected.url, transport: 'undici', proxyConfiguration: { useApifyProxy: false } });
    const result = await runActor({ actor, budget: new Budget({ elapsed: () => 0 }),
        acquireFn: () => assert.fail('No Chromium'), httpAcquireFn: (input, context) => acquire(input, { ...context, makeDispatcher: () => mock }) });
    mock.assertNoPendingInterceptors(); assert.equal(result.exitCode, 0); assert.deepEqual(actor.records, [expected]);
});
test('official SDK Unblocker setup and required diagnostics stay free of credentials', async () => {
    const { html, expected } = fixture();
    const actor = new FakeActor({ url: expected.url, transport: 'undici', proxyAccessAuthorized: true });
    let urlCalls = 0, dispatcherOptions;
    actor.createProxyConfiguration = async options => {
        assert.deepEqual(options, { useApifyProxy: true, groups: ['UNBLOCKER'] });
        return { newUrl: async (...args) => { urlCalls++; assert.deepEqual(args, []); return 'http://groups-UNBLOCKER:PRIVATE_PASSWORD@proxy.invalid:8000'; } };
    };
    const lines = [], methods = ['info', 'warning', 'error'], original = Object.fromEntries(methods.map(m => [m, log[m]]));
    for (const method of methods) log[method] = (message, data) => lines.push({ message, data });
    let result;
    try {
        result = await runActor({ actor, budget: new Budget({ elapsed: () => 0 }), acquireFn: () => assert.fail('No browser'),
            httpAcquireFn: (input, context) => acquire(input, { ...context, fetchImpl: async () => response(html),
                makeDispatcher: options => { dispatcherOptions = options; return fakeDispatcher(); } }) });
    } finally { for (const method of methods) log[method] = original[method]; }
    assert.equal(result.exitCode, 0); assert.equal(urlCalls, 1); assert.equal(dispatcherOptions.requestTls.rejectUnauthorized, false);
    for (const tag of ['TRANSPORTE', 'PROXY', 'TLS', 'HTTP', 'HTML_LISTO', 'TIEMPO_ADQUISICION', 'PRECIO_VERIFICADO', 'GUARDADO', 'FIN'])
        assert.ok(lines.some(line => line.message === '[' + tag + ']'), tag);
    assert.equal(lines.find(line => line.message === '[TRANSPORTE]').data.transport, 'undici');
    assert.equal(lines.find(line => line.message === '[FIN]').data.transport, 'undici');
    assert.doesNotMatch(JSON.stringify(lines), /PRIVATE_PASSWORD|proxy\.invalid|proxy-authorization/);
});
test('full URL including l and offerType is passed exactly once; redirects stay manual', async () => {
    const url = fixture().expected.url + '?offerType=0&l=12'; let calls = 0;
    const result = await fakeAcquire(inputFor(url), async (target, options) => {
        calls++; assert.equal(target, url); assert.equal(options.redirect, 'manual');
        assert.deepEqual(options.headers, { accept: 'text/html' }); assert.equal(options.headers['proxy-authorization'], undefined);
        return response();
    });
    assert.equal(calls, 1); assert.equal(result.acquisition.pageSelection.status, 'preserved');
    assert.equal(extractHtml(result.html, inputFor(url)).output.url, url);
    for (const suffix of ['?l=12&l=13', '?l=', '?token=private', '?grade=10', '?offerType=0&extra=1'])
        assert.throws(() => inputFor(fixture().expected.url + suffix));
});
test('loss of commercial selection is rejected by the original shared guard', async () => {
    const url = fixture().expected.url + '?l=12&offerType=0';
    const acquired = await fakeAcquire(inputFor(url), async () => {
        const res = response(); Object.defineProperty(res, 'url', { value: url.split('?')[0] }); return res;
    });
    const result = await runHttp(acquired, url);
    assert.equal(result.state.error.code, 'SELECTED_PRICE_UNVERIFIED'); assert.equal(result.actor.records.length, 0);
});
test('synthetic Nuxt serialization of real commerce uses the unchanged data-only decoder', async () => {
    const { data, expected } = fixture(), table = [];
    function encode(v) { const i = table.length; table.push(null); table[i] = Array.isArray(v) ? v.map(encode)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, child]) => [k, encode(child)])) : v; return i; }
    encode({ data: { ['products/' + ids[0]]: data } });
    const html = '<script>throw new Error("MUST_NOT_EXECUTE")</script><script id="__NUXT_DATA__" type="application/json">' + JSON.stringify(table) + '</script>';
    const result = await runHttp(await mocked(html));
    assert.equal(result.exitCode, 0); assert.deepEqual(result.actor.records, [expected]);
    assert.equal(result.metadata.sourceDiagnostics.commercialSources.pickers, 'nuxt');
});
for (const status of [301, 302, 303, 307, 308, 401, 403, 429, 502, 590]) test('HTTP ' + status + ' stops without retry, follow or Dataset record', async () => {
    const acquired = await mocked('error', undefined, status, { location: fixture().expected.url });
    const code = status < 400 ? 'UNEXPECTED_REDIRECT' : status === 407 ? 'PROXY_AUTH_ERROR' : status === 590 ? 'APIFY_PROXY_HTTP_590' : 'HTTP_' + status;
    assert.equal(acquired.acquisition.error.code, code); assert.equal(acquired.html, '');
    assert.equal(acquired.acquisition.httpRequestCount, 1); assert.equal(acquired.acquisition.dispatcherClosed, true);
    assert.equal(acquired.acquisition.status, [401, 403].includes(status) ? 'blocked' : status < 400 ? 'partial' : 'error');
    assert.equal((await runHttp(acquired)).actor.records.length, 0);
});
test('an exposed HTTP 407 is classified as proxy authentication failure', async () => {
    const acquired = await fakeAcquire(inputFor(), async () => response('', 407));
    assert.equal(acquired.acquisition.error.code, 'PROXY_AUTH_ERROR');
    assert.equal(acquired.acquisition.requests[0].httpStatus, 407);
    assert.equal((await runHttp(acquired)).actor.records.length, 0);
});
test('fetch can suppress upstream 407 details; no CONNECT status is invented', async () => {
    const acquired = await mocked('', undefined, 407);
    assert.equal(acquired.acquisition.error.code, 'NETWORK_ERROR');
    assert.deepEqual(acquired.acquisition.requests, []);
    assert.equal(acquired.acquisition.connectionDiagnostic.connectStatus, undefined);
    assert.equal(acquired.acquisition.dispatcherClosed, true);
});
for (const [name, body, headers, code] of [
    ['non-HTML', '{}', { 'content-type': 'application/json' }, 'INVALID_CONTENT_TYPE'],
    ['empty HTML', '', {}, 'EMPTY_RESPONSE'],
    ['challenge', '<title>Just a moment</title>', {}, 'ACCESS_CHALLENGE'],
    ['visible challenge', '<body>bot-need-challenge</body>', {}, 'ACCESS_CHALLENGE'],
    ['challenge header', fixture().html, { 'cf-mitigated': 'challenge' }, 'ACCESS_CHALLENGE'],
    ['declared oversized HTML', 'x', { 'content-length': '999999999' }, 'RESPONSE_TOO_LARGE'],
]) test(name + ' is rejected before extraction', async () => {
    const acquired = await mocked(body, undefined, 200, headers);
    assert.equal(acquired.acquisition.error.code, code); assert.equal(acquired.html, '');
});
test('decoded streamed size is limited even for compressed responses', async () => {
    const body = gzipSync('x'.repeat(2048)); const mock = new MockAgent(); mock.disableNetConnect();
    const input = inputFor(), url = new URL(input.url); input.maxHtmlBytes = 1024;
    mock.get(url.origin).intercept({ path: url.pathname }).reply(200, body, { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': String(body.length) } });
    const acquired = await acquire(input, { makeDispatcher: () => mock });
    assert.equal(acquired.acquisition.error.code, 'RESPONSE_TOO_LARGE'); assert.equal(acquired.html, '');
    assert.equal(acquired.acquisition.dispatcherClosed, true);
});
for (const [nestedCode, code] of [['CERT_HAS_EXPIRED', 'TLS_ERROR'], ['UND_ERR_PRX_TLS', 'TLS_ERROR'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'TLS_ERROR'], ['UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT'], ['UND_ERR_HEADERS_TIMEOUT', 'TIMEOUT'],
    ['UND_ERR_BODY_TIMEOUT', 'TIMEOUT'], ['ENOTFOUND', 'DNS_ERROR'], ['ECONNRESET', 'TCP_ERROR']])
    test('nested ' + nestedCode + ' is classified and resources close without exposing secrets', async () => {
        const error = new Error('https://user:PRIVATE_PASSWORD@proxy.invalid', { cause: Object.assign(new Error('token=PRIVATE_TOKEN'), { code: nestedCode }) });
        const acquired = await fakeAcquire(inputFor(), async () => { throw error; });
        assert.equal(acquired.acquisition.error.code, code); assert.equal(acquired.acquisition.dispatcherClosed, true);
        assert.doesNotMatch(JSON.stringify(acquired), /PRIVATE_|proxy\.invalid|token=/);
        assert.equal((await runHttp(acquired)).actor.records.length, 0);
    });
test('failed CONNECT distinguishes authentication 407 from proxy 590', () => {
    for (const status of [407, 590]) {
        const error = new Error('fetch failed', { cause: Object.assign(new Error('Proxy response (' + status + ') !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' }) });
        const diagnostic = connectionFailure(error, { stage: 'request_before_headers', proxy: true, elapsedMs: 10 });
        assert.equal(diagnostic.code, status === 407 ? 'PROXY_AUTH_ERROR' : 'PROXY_CONNECT_ERROR'); assert.equal(diagnostic.connectStatus, status);
    }
});
const shortDeadline = { acquisition: 48_000, remaining: () => 2020 };
test('deadline covers a fetch waiting for headers, even if injected fetch ignores AbortSignal', async () => {
    const acquired = await fakeAcquire(inputFor(), async () => new Promise(() => {}), { budget: shortDeadline });
    assert.equal(acquired.acquisition.error.code, 'TIMEOUT'); assert.equal(acquired.acquisition.status, 'partial');
    assert.equal(acquired.acquisition.dispatcherClosed, true);
});
test('deadline also aborts a stalled response body', async () => {
    const acquired = await fakeAcquire(inputFor(), async (_url, { signal }) => new Response(new ReadableStream({
        start(controller) { signal.addEventListener('abort', () => controller.error(new Error('Abort')), { once: true }); },
    }), { headers: { 'content-type': 'text/html' } }), { budget: shortDeadline });
    assert.equal(acquired.acquisition.error.code, 'TIMEOUT'); assert.equal(acquired.acquisition.failureStage, 'response_body');
    assert.equal(acquired.acquisition.dispatcherClosed, true);
});
test('caller abort or exhausted budget prevents starting a request', async () => {
    const controller = new AbortController(); controller.abort();
    for (const context of [{ signal: controller.signal }, { budget: { acquisition: 0, remaining: () => 0 } }]) {
        const acquired = await fakeAcquire(inputFor(), () => assert.fail('No request'), context);
        assert.equal(acquired.acquisition.httpRequestCount, 0);
        assert.equal(acquired.acquisition.error.code, context.signal ? 'ABORTED' : 'TIMEOUT');
    }
});
test('TLS exception belongs only to the Unblocker dispatcher; credentials encode exactly once', async () => {
    const envValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    for (const mode of ['direct', 'residential', 'datacenter', 'unblocker']) {
        const proxy = mode === 'direct' ? null : { server: 'http://proxy.invalid:8000', username: 'groups-UNBLOCKER', password: 'PRIVATE:@%+ value' };
        let options;
        const acquired = await acquire(inputFor(), { proxy, proxyMode: mode, fetchImpl: async () => response(), makeDispatcher: value => { options = value; return fakeDispatcher(); } });
        if (proxy) { const url = new URL(options.uri); assert.equal(decodeURIComponent(url.username), proxy.username); assert.equal(decodeURIComponent(url.password), proxy.password); }
        assert.equal(options.requestTls?.rejectUnauthorized, mode === 'unblocker' ? false : undefined);
        assert.equal(options.proxyTls, undefined); assert.equal(options.allowH2, false);
        assert.equal(acquired.acquisition.tlsVerified, mode !== 'unblocker');
        assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, envValue);
        assert.doesNotMatch(JSON.stringify(acquired), /PRIVATE|groups-UNBLOCKER|proxy\.invalid/);
    }
});
test('dispatcher close failure is destroyed without masking a primary HTTP error', async () => {
    let destroyed = false;
    const acquired = await fakeAcquire(inputFor(), async () => response('', 403), { makeDispatcher: () => ({
        async close() { throw new Error('PRIVATE'); }, async destroy() { destroyed = true; },
    }) });
    assert.equal(destroyed, true); assert.equal(acquired.acquisition.error.code, 'HTTP_403');
    assert.equal(acquired.acquisition.dispatcherDestroyed, true); assert.equal(acquired.acquisition.closeError, 'DISPATCHER_CLOSE_FAILED');
});
test('short URL still requires page identity and an associated selected offer', async () => {
    const { html, expected } = fixture(), short = expected.url.replace('/' + ids[0], '');
    const good = await runHttp(await mocked('<link rel="canonical" href="' + expected.url + '">' + html, short), short);
    assert.equal(good.exitCode, 0); assert.deepEqual(good.actor.records, [{ ...expected, url: short }]);
    const bad = await runHttp(await mocked(html, short), short);
    assert.equal(bad.state.error.code, 'SHORT_URL_IDENTITY_UNVERIFIED'); assert.equal(bad.actor.records.length, 0);
});
for (const corruption of ['price', 'currency', 'uuid', 'missing-offer']) test('shared commercial validation still rejects ' + corruption, async () => {
    const { data } = fixture(), selected = data.pickers.pickerGroups.flatMap(g => g.items).find(i => i.selected);
    if (corruption === 'price') selected.price.amount = '0.01';
    if (corruption === 'currency') selected.price.currency = 'EUR';
    if (corruption === 'uuid') selected.productId = ids[1];
    if (corruption === 'missing-offer') data.pickers.selectedOffer = {};
    const html = '<script id="captured-commercial-data" type="application/json">' + JSON.stringify({ productId: ids[0], data }) + '</script>';
    const result = await runHttp(await mocked(html));
    assert.equal(result.state.error.code, 'SELECTED_PRICE_UNVERIFIED'); assert.equal(result.actor.records.length, 0);
});
