import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { log } from 'apify';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { acquire, makeAuthenticatedProxyUrl } from '../src/acquisition/firefox.js';
import { localProxyConfiguration } from '../src/acquisition/proxy.js';
import { parseInput } from '../src/platform/input.js';
import { loadLocalEnvFile } from '../src/platform/local_env.js';
import { runActor } from '../src/platform/actor.js';

const productUrl = 'https://www.backmarket.com/en-us/p/ipad-air-2020-a14-series';
const credentials = { OXYLABS_USERNAME: 'wu_732a50ce', OXYLABS_PASSWORD: 'test=value=with-percent%' };
const budget = { acquisition: 30000, remaining: () => 30000 };

function fakeBrowser({ onLaunch = () => {}, onContext = () => {}, onClose = () => {} } = {}) {
    const page = { on() {}, route: async () => {}, mainFrame() { return {}; }, goto: async () => { throw new Error('offline'); } };
    return {
        launch: async options => {
            onLaunch(options);
            return {
                newContext: async options => {
                    onContext(options);
                    return { newPage: async () => page };
                },
                close: async () => onClose(),
            };
        },
    };
}

function fakeActor(isAtHome = false) {
    const values = {};
    return {
        values,
        isAtHome: () => isAtHome,
        init: async () => {},
        on: () => {},
        setValue: async (key, value) => { values[key] = value; },
        getInput: async () => ({ url: productUrl }),
        exit: async () => {},
        pushData: async () => {},
    };
}

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}

async function getThroughProxy(proxyUrl) {
    const proxy = new URL(proxyUrl);
    return new Promise((resolve, reject) => {
        const req = request({ hostname: proxy.hostname, port: proxy.port, method: 'GET',
            path: 'http://target.invalid/product', headers: { host: 'target.invalid' } }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        req.on('error', reject);
        req.end();
    });
}

test('sin credenciales selecciona directo; con credenciales validas selecciona Oxylabs', () => {
    const direct = localProxyConfiguration({});
    assert.equal(direct.settings.mode, 'direct');
    assert.equal(direct.settings.enabled, false);
    assert.equal(direct.proxy, null);

    const oxylabs = localProxyConfiguration(credentials);
    assert.equal(oxylabs.settings.mode, 'local-external-proxy');
    assert.equal(oxylabs.settings.enabled, true);
    assert.deepEqual(oxylabs.proxy, {
        server: 'https://unblock.oxylabs.io:60000',
        username: credentials.OXYLABS_USERNAME,
        password: credentials.OXYLABS_PASSWORD,
    });
    assert.equal(localProxyConfiguration({ ...credentials, BACKMARKET_LOCAL_PROXY_MODE: 'direct' }).settings.mode, 'direct');
});

test('modo Oxylabs explicito sin credenciales falla con codigo claro', () => {
    assert.throws(() => localProxyConfiguration({ BACKMARKET_LOCAL_PROXY_MODE: 'oxylabs' }),
        { code: 'OXYLABS_CREDENTIALS_MISSING' });
    assert.throws(() => localProxyConfiguration({ ...credentials, OXYLABS_PASSWORD: 'REEMPLAZAR_LOCALMENTE' }),
        { code: 'OXYLABS_CREDENTIALS_MISSING' });
    assert.throws(() => localProxyConfiguration({ ...credentials, OXYLABS_HOST: 'proxy.example.invalid' }),
        { code: 'OXYLABS_ENDPOINT_INVALID' });
});

test('Node carga .env.local solo fuera de Cloud y admite valores con signo igual', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backmarket-env-test-'));
    const file = join(directory, '.env.local');
    const variable = 'BACKMARKET_LOCAL_ENV_TEST_VALUE';
    const previous = process.env[variable];
    delete process.env[variable];
    try {
        await writeFile(file, `${variable}=before=after\n`, 'utf8');
        assert.equal(loadLocalEnvFile({ path: file, isCloud: true }), false);
        assert.equal(process.env[variable], undefined);
        assert.equal(loadLocalEnvFile({ path: file, isCloud: false }), true);
        assert.equal(process.env[variable], 'before=after');
    } finally {
        delete process.env[variable];
        if (previous !== undefined) process.env[variable] = previous;
        await rm(directory, { recursive: true, force: true });
    }
});

test('la URL del upstream codifica una sola vez la contrasena con igual', () => {
    const value = makeAuthenticatedProxyUrl({
        server: 'https://unblock.oxylabs.io:60000',
        username: credentials.OXYLABS_USERNAME,
        password: credentials.OXYLABS_PASSWORD,
    });
    const url = new URL(value);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'unblock.oxylabs.io');
    assert.equal(url.port, '60000');
    assert.equal(decodeURIComponent(url.username), credentials.OXYLABS_USERNAME);
    assert.equal(decodeURIComponent(url.password), credentials.OXYLABS_PASSWORD);
    assert.match(url.password, /%3D/);
});

test('proxy-chain envia Basic Authentication y acepta un upstream HTTPS sin llamar a Oxylabs', async () => {
    let authorization;
    const upstream = createServer((req, res) => {
        authorization = req.headers['proxy-authorization'];
        res.end('ok');
    });
    let localProxyUrl;
    let secureProxyUrl;
    try {
        const port = await listen(upstream);
        const upstreamUrl = makeAuthenticatedProxyUrl({
            server: `http://127.0.0.1:${port}`,
            username: credentials.OXYLABS_USERNAME,
            password: credentials.OXYLABS_PASSWORD,
        });
        localProxyUrl = await anonymizeProxy({ url: upstreamUrl });
        assert.equal(await getThroughProxy(localProxyUrl), 200);
        assert.equal(authorization, `Basic ${Buffer.from(`${credentials.OXYLABS_USERNAME}:${credentials.OXYLABS_PASSWORD}`).toString('base64')}`);

        const httpsUrl = makeAuthenticatedProxyUrl({
            server: 'https://unblock.oxylabs.io:60000',
            username: credentials.OXYLABS_USERNAME,
            password: credentials.OXYLABS_PASSWORD,
        });
        secureProxyUrl = await anonymizeProxy({ url: httpsUrl, ignoreProxyCertificate: true });
        assert.match(secureProxyUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

        const anonymizeSource = await readFile(new URL('../node_modules/proxy-chain/dist/anonymize_proxy.js', import.meta.url), 'utf8');
        const chainSource = await readFile(new URL('../node_modules/proxy-chain/dist/chain.js', import.meta.url), 'utf8');
        const basicSource = await readFile(new URL('../node_modules/proxy-chain/dist/utils/get_basic.js', import.meta.url), 'utf8');
        assert.match(anonymizeSource, /ignoreUpstreamProxyCertificate: ignoreProxyCertificate/);
        assert.match(chainSource, /https\.request/);
        assert.match(chainSource, /rejectUnauthorized: !handlerOpts\.ignoreUpstreamProxyCertificate/);
        assert.match(basicSource, /Buffer\.from\(auth\)\.toString\('base64'\)/);
    } finally {
        if (secureProxyUrl) await closeAnonymizedProxy(secureProxyUrl, true);
        if (localProxyUrl) await closeAnonymizedProxy(localProxyUrl, true);
        await new Promise(resolve => upstream.close(resolve));
    }
});

test('Oxylabs usa Firefox headless, loopback, excepciones TLS locales y cierre completo sin filtrar secretos', async () => {
    let launchOptions, contextOptions, bridgeOptions, browserClosed = 0, proxyClosed = 0;
    const messages = [];
    const originalLog = Object.fromEntries(['info', 'warning', 'error'].map(level => [level, log[level]]));
    for (const level of Object.keys(originalLog)) log[level] = (...args) => messages.push(args);
    try {
        const result = await acquire(parseInput({ url: productUrl }), {
            proxy: { server: 'https://unblock.oxylabs.io:60000',
                username: credentials.OXYLABS_USERNAME, password: credentials.OXYLABS_PASSWORD },
            proxyMode: 'local-external-proxy',
            localDirect: true,
            budget,
            browserType: fakeBrowser({
                onLaunch: value => { launchOptions = value; },
                onContext: value => { contextOptions = value; },
                onClose: () => { browserClosed++; },
            }),
            anonymizeProxyFn: async value => { bridgeOptions = value; return 'http://127.0.0.1:43210'; },
            closeAnonymizedProxyFn: async () => { proxyClosed++; },
        });
        assert.equal(launchOptions.headless, true);
        assert.deepEqual(launchOptions.proxy, { server: 'http://127.0.0.1:43210' });
        assert.equal(contextOptions.ignoreHTTPSErrors, true);
        assert.equal(bridgeOptions.ignoreProxyCertificate, true);
        assert.equal(decodeURIComponent(new URL(bridgeOptions.url).password), credentials.OXYLABS_PASSWORD);
        assert.equal(browserClosed, 1);
        assert.equal(proxyClosed, 1);
        assert.equal(result.acquisition.proxyBridge.closeStatus, 'closed');
        assert.equal(result.acquisition.tlsVerified, false);
        assert.doesNotMatch(JSON.stringify(messages), /test=value=with-percent%|wu_732a50ce/);
    } finally {
        for (const [level, original] of Object.entries(originalLog)) log[level] = original;
    }
});

test('Cloud conserva su modo Apify UNBLOCKER, su puente y su configuracion TLS', async () => {
    let launchOptions, contextOptions, bridgeOptions;
    const previous = process.env.APIFY_IS_AT_HOME;
    process.env.APIFY_IS_AT_HOME = '1';
    try {
        const result = await acquire(parseInput({ url: productUrl }), {
            proxy: { server: 'http://proxy.example.invalid:8000', username: 'cloud-user', password: 'cloud-pass' },
            proxyMode: 'unblocker',
            budget,
            browserType: fakeBrowser({
                onLaunch: value => { launchOptions = value; },
                onContext: value => { contextOptions = value; },
            }),
            anonymizeProxyFn: async value => { bridgeOptions = value; return 'http://127.0.0.1:43211'; },
            closeAnonymizedProxyFn: async () => {},
        });
        assert.equal(launchOptions.headless, true);
        assert.deepEqual(Object.keys(bridgeOptions), ['url']);
        assert.equal(contextOptions.ignoreHTTPSErrors, true);
        assert.equal(result.acquisition.tlsVerified, false);
        assert.equal(result.acquisition.proxyBridge.closeStatus, 'closed');
    } finally {
        if (previous === undefined) delete process.env.APIFY_IS_AT_HOME;
        else process.env.APIFY_IS_AT_HOME = previous;
    }
});

test('runActor conecta Oxylabs en local y no usa la configuracion local en Cloud', async () => {
    let localOptions, cloudOptions, cloudProxySettings;
    const local = fakeActor(false);
    await runActor({ actor: local, env: credentials, budget: undefined,
        acquireFn: async (_input, options) => {
            localOptions = options;
            return { html: '', acquisition: { status: 'error', error: { code: 'OFFLINE_TEST' }, requests: [] } };
        },
        proxyFn: async () => { throw new Error('local execution must not create an Apify proxy'); },
    });
    assert.equal(localOptions.proxyMode, 'local-external-proxy');
    assert.equal(localOptions.proxy.server, 'https://unblock.oxylabs.io:60000');
    assert.equal(local.values.RUN_STATE.proxy.mode, 'local-external-proxy');
    assert.equal(JSON.stringify(local.values.RUN_STATE.proxy).includes(credentials.OXYLABS_PASSWORD), false);

    const cloud = fakeActor(true);
    await runActor({ actor: cloud, env: credentials, budget: undefined,
        proxyFn: async (_actor, settings) => { cloudProxySettings = settings; return { server: 'http://cloud-proxy.invalid' }; },
        acquireFn: async (_input, options) => {
            cloudOptions = options;
            return { html: '', acquisition: { status: 'error', error: { code: 'OFFLINE_TEST' }, requests: [] } };
        },
    });
    assert.equal(cloudProxySettings.mode, 'unblocker');
    assert.equal(cloudOptions.proxyMode, 'unblocker');
});

test('runActor falla claramente cuando Oxylabs se solicita sin credenciales', async () => {
    let acquisitionCalls = 0;
    const actor = fakeActor(false);
    const result = await runActor({ actor, env: { BACKMARKET_LOCAL_PROXY_MODE: 'oxylabs' },
        acquireFn: async () => { acquisitionCalls++; throw new Error('must not acquire'); },
    });
    assert.equal(acquisitionCalls, 0);
    assert.equal(result.state.error.code, 'OXYLABS_CREDENTIALS_MISSING');
});

test('esquemas Apify existentes siguen siendo JSON valido con Input publico de solo URL', async () => {
    const names = ['actor.json', 'input_schema.json', 'output_schema.json', 'dataset_schema.json', 'key_value_store_schema.json'];
    const schemas = await Promise.all(names.map(name => readFile(new URL(`../.actor/${name}`, import.meta.url), 'utf8').then(JSON.parse)));
    assert.deepEqual(Object.keys(schemas[1].properties), ['url']);
    assert.deepEqual(schemas[1].required, ['url']);
});
