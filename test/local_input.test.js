import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from 'apify';
import { loadLocalInput } from '../src/platform/local_input.js';
import { runActor } from '../src/platform/actor.js';

const rootUrl = 'https://www.backmarket.com/en-us/p/ipad-air-2020-a14-series';
const cliUrl = 'https://www.backmarket.com/en-us/p/ipad-air-2022-m2-series';
const cloudUrl = 'https://www.backmarket.com/en-us/p/ipad-pro-2024-m4';
const credentials = { OXYLABS_USERNAME: 'wu_732a50ce', OXYLABS_PASSWORD: 'test-secret=must-not-log' };

function testBudget() {
    return { total: 55000, acquisition: 48000, work: 52000, elapsed: () => 0,
        remaining: () => 55000, configure() {}, stop() {} };
}

function testActor({ isAtHome = false, input = null } = {}) {
    const values = {};
    let inputReads = 0;
    return {
        values,
        get inputReads() { return inputReads; },
        isAtHome: () => isAtHome,
        init: async () => {},
        on: () => {},
        setValue: async (key, value) => { values[key] = value; },
        getInput: async () => { inputReads++; return input; },
        exit: async () => {},
        pushData: async () => {},
    };
}

async function withTempProject(fn) {
    const root = await mkdtemp(join(tmpdir(), 'backmarket-input-test-'));
    try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('solo usa el INPUT canonico de Storage e ignora la raiz y los Inputs CLI', async () => {
    await withTempProject(async root => {
        const storageInput = { url: rootUrl };
        const otherInput = { url: cliUrl };
        await writeFile(join(root, 'input.template.json'), JSON.stringify({ url: cloudUrl }), 'utf8');
        await writeFile(join(root, 'input.json'), JSON.stringify(otherInput), 'utf8');
        const storageInputPath = join(root, 'storage', 'key_value_stores', 'default', 'INPUT.json');
        await mkdir(join(root, 'storage', 'key_value_stores', 'default'), { recursive: true });
        await writeFile(storageInputPath, JSON.stringify(storageInput), 'utf8');
        await writeFile(join(root, 'storage', 'key_value_stores', 'default', '__CLI_INPUT.json'), JSON.stringify(otherInput), 'utf8');

        const cliEnv = {
            ACTOR_INPUT_KEY: '__CLI_INPUT', APIFY_INPUT_KEY: '__CLI_INPUT', CRAWLEE_INPUT_KEY: '__CLI_INPUT',
        };
        const selected = await loadLocalInput({ root, isCloud: false });
        assert.equal(selected.origin, 'storage/key_value_stores/default/INPUT.json');
        assert.deepEqual(selected.rawInput, storageInput);
        assert.deepEqual(JSON.parse(await readFile(storageInputPath, 'utf8')), storageInput);

        const ignoredCliInput = await loadLocalInput({ root, env: cliEnv, isCloud: false });
        assert.equal(ignoredCliInput.origin, selected.origin);
        assert.deepEqual(ignoredCliInput.rawInput, storageInput);
        assert.deepEqual(JSON.parse(await readFile(join(root, 'input.json'), 'utf8')), otherInput);
    });
});

test('si falta el INPUT canonico, falla sin leer otras fuentes ni crear archivos', async () => {
    await withTempProject(async root => {
        const storageInputPath = join(root, 'storage', 'key_value_stores', 'default', 'INPUT.json');
        await writeFile(join(root, 'input.template.json'), JSON.stringify({ url: cloudUrl }), 'utf8');
        await writeFile(join(root, 'input.json'), JSON.stringify({ url: cliUrl }), 'utf8');
        await assert.rejects(loadLocalInput({ root, isCloud: false }), error => error.code === 'LOCAL_STORAGE_INPUT_MISSING');
        await assert.rejects(readFile(storageInputPath, 'utf8'), { code: 'ENOENT' });
    });
});

test('un INPUT vacio no se sustituye por la plantilla ni por input.json', async () => {
    await withTempProject(async root => {
        const emptyInput = {};
        await writeFile(join(root, 'input.template.json'), JSON.stringify({ url: rootUrl }), 'utf8');
        await writeFile(join(root, 'input.json'), JSON.stringify({ url: cliUrl }), 'utf8');
        const store = join(root, 'storage', 'key_value_stores', 'default');
        await mkdir(store, { recursive: true });
        await writeFile(join(store, 'INPUT.json'), JSON.stringify(emptyInput), 'utf8');

        const selected = await loadLocalInput({ root, isCloud: false });
        assert.equal(selected.origin, 'storage/key_value_stores/default/INPUT.json');
        assert.deepEqual(selected.rawInput, emptyInput);
        assert.deepEqual(JSON.parse(await readFile(join(store, 'INPUT.json'), 'utf8')), emptyInput);
    });
});

test('el Input de CLI no desplaza el registro INPUT de Storage aunque sea distinto', async () => {
    await withTempProject(async root => {
        const storedInput = { url: rootUrl };
        const cliInput = { url: cliUrl };
        const store = join(root, 'storage', 'key_value_stores', 'default');
        await mkdir(store, { recursive: true });
        await writeFile(join(store, 'INPUT.json'), JSON.stringify(storedInput), 'utf8');
        await writeFile(join(store, '__CLI_INPUT.json'), JSON.stringify(cliInput), 'utf8');

        const selected = await loadLocalInput({ root, env: { APIFY_INPUT_KEY: '__CLI_INPUT' }, isCloud: false });
        assert.equal(selected.origin, 'storage/key_value_stores/default/INPUT.json');
        assert.deepEqual(selected.rawInput, storedInput);
    });
});

test('Cloud no lee el Input de Storage y runActor usa el Input oficial', async () => {
    await withTempProject(async root => {
        const selection = await loadLocalInput({ root, env: {}, isCloud: true });
        assert.deepEqual(selection, { origin: 'apify', rawInput: undefined });
        await assert.rejects(readFile(join(root, 'storage', 'key_value_stores', 'default', 'INPUT.json'), 'utf8'), { code: 'ENOENT' });

        let acquiredUrl, proxyMode;
        const actor = testActor({ isAtHome: true, input: { url: cloudUrl } });
        const localSecretArg = { url: rootUrl };
        await runActor({ actor, rawInput: localSecretArg, inputSource: 'apify', env: credentials, budget: testBudget(),
            proxyFn: async (_actor, settings) => { assert.deepEqual(settings.groups, ['UNBLOCKER']); return null; },
            acquireFn: async input => {
                acquiredUrl = input.url;
                return { html: '', acquisition: { status: 'error', error: { code: 'OFFLINE_TEST' }, requests: [] } };
            },
        });
        assert.equal(acquiredUrl, cloudUrl);
        assert.equal(actor.inputReads, 1);
    });
});

test('runActor usa el INPUT local canonico y registra el origen sin filtrar secretos', async () => {
    const messages = [];
    const original = log.info;
    log.info = (...args) => messages.push(args);
    try {
        let acquiredUrl, proxyMode;
        const staleStorageInput = { url: 'https://www.backmarket.com/en-us/p/iphone-15' };
        const actor = testActor({ input: staleStorageInput });
        await runActor({ actor, rawInput: { url: rootUrl }, inputSource: 'storage/key_value_stores/default/INPUT.json', env: credentials, budget: testBudget(),
            proxyFn: async () => { throw new Error('local execution must not create an Apify proxy'); },
            acquireFn: async (input, options) => {
                acquiredUrl = input.url;
                proxyMode = options.proxyMode;
                return { html: '', acquisition: { status: 'error', error: { code: 'OFFLINE_TEST' }, requests: [] } };
            },
        });
        assert.equal(acquiredUrl, rootUrl);
        assert.equal(proxyMode, 'local-external-proxy');
        assert.equal(actor.inputReads, 0);
        assert.match(JSON.stringify(messages), /storage\/key_value_stores\/default\/INPUT\.json/);
        assert.doesNotMatch(JSON.stringify(messages), /test-secret=must-not-log|wu_732a50ce/);
    } finally {
        log.info = original;
    }
});

test('esquema de Input existente sigue exponiendo solo url', async () => {
    const schema = JSON.parse(await readFile(new URL('../.actor/input_schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(schema.properties), ['url']);
    assert.deepEqual(schema.required, ['url']);
});
