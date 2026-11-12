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

test('input.json raiz prevalece sobre Storage y se conserva entre ejecuciones', async () => {
    await withTempProject(async root => {
        const privateInput = { url: rootUrl };
        const oldStorageInput = { url: 'https://www.backmarket.com/en-us/p/iphone-15-128-gb-black-unlocked/c8fc0d62-5daa-48f0-ba1e-4c41b4612249' };
        await writeFile(join(root, 'input.template.json'), JSON.stringify(privateInput), 'utf8');
        await writeFile(join(root, 'input.json'), JSON.stringify(privateInput), 'utf8');
        const storageInputPath = join(root, 'storage', 'key_value_stores', 'default', 'INPUT.json');
        await mkdir(join(root, 'storage', 'key_value_stores', 'default'), { recursive: true });
        await writeFile(storageInputPath, JSON.stringify(oldStorageInput), 'utf8');
        await writeFile(join(root, 'storage', 'key_value_stores', 'default', '__CLI_INPUT.json'), JSON.stringify(oldStorageInput), 'utf8');

        const selected = await loadLocalInput({ root, env: {
            ACTOR_INPUT_KEY: '__CLI_INPUT', APIFY_INPUT_KEY: '__CLI_INPUT', CRAWLEE_INPUT_KEY: '__CLI_INPUT',
        }, isCloud: false });
        assert.equal(selected.origin, 'input.json');
        assert.deepEqual(selected.rawInput, privateInput);
        assert.deepEqual(JSON.parse(await readFile(storageInputPath, 'utf8')), oldStorageInput);

        await writeFile(join(root, 'input.json'), JSON.stringify({ url: cliUrl }), 'utf8');
        const nextRun = await loadLocalInput({ root, env: { APIFY_INPUT_KEY: 'INPUT' }, isCloud: false });
        assert.equal(nextRun.rawInput.url, cliUrl);
    });
});

test('si falta input.json se crea una vez desde la plantilla sin sobrescribirlo', async () => {
    await withTempProject(async root => {
        const template = { url: rootUrl };
        const edited = { url: cliUrl };
        await writeFile(join(root, 'input.template.json'), JSON.stringify(template), 'utf8');
        const first = await loadLocalInput({ root, env: {}, isCloud: false });
        assert.equal(first.origin, 'input.json');
        assert.deepEqual(first.rawInput, template);
        assert.deepEqual(JSON.parse(await readFile(join(root, 'input.json'), 'utf8')), template);

        await writeFile(join(root, 'input.json'), JSON.stringify(edited), 'utf8');
        const second = await loadLocalInput({ root, env: {}, isCloud: false });
        assert.deepEqual(second.rawInput, edited);
        assert.deepEqual(JSON.parse(await readFile(join(root, 'input.json'), 'utf8')), edited);
    });
});

test('Apify CLI explicito conserva prioridad y no crea input.json local', async () => {
    await withTempProject(async root => {
        await writeFile(join(root, 'input.template.json'), JSON.stringify({ url: rootUrl }), 'utf8');
        const cliEnv = {
            ACTOR_INPUT_KEY: '__CLI_INPUT', APIFY_INPUT_KEY: '__CLI_INPUT', CRAWLEE_INPUT_KEY: '__CLI_INPUT',
        };
        const selected = await loadLocalInput({ root, env: cliEnv, isCloud: false });
        assert.equal(selected.origin, 'apify-cli');
        assert.equal(selected.rawInput, undefined);
        await assert.rejects(readFile(join(root, 'input.json'), 'utf8'), { code: 'ENOENT' });
    });
});

test('la clave temporal de CLI que solo replica Storage no desplaza input.json', async () => {
    await withTempProject(async root => {
        const oldInput = { url: 'https://www.backmarket.com/en-us/p/iphone-15' };
        await writeFile(join(root, 'input.template.json'), JSON.stringify({ url: rootUrl }), 'utf8');
        const store = join(root, 'storage', 'key_value_stores', 'default');
        await mkdir(store, { recursive: true });
        await writeFile(join(store, 'INPUT.json'), JSON.stringify(oldInput), 'utf8');
        await writeFile(join(store, '__CLI_INPUT.json'), JSON.stringify(oldInput), 'utf8');

        const selected = await loadLocalInput({ root, env: { APIFY_INPUT_KEY: '__CLI_INPUT' }, isCloud: false });
        assert.equal(selected.origin, 'input.json');
        assert.deepEqual(selected.rawInput, { url: rootUrl });
    });
});

test('un Input CLI diferente del Input antiguo conserva prioridad', async () => {
    await withTempProject(async root => {
        const oldInput = { url: 'https://www.backmarket.com/en-us/p/iphone-15' };
        const explicitInput = { url: cliUrl };
        await writeFile(join(root, 'input.template.json'), JSON.stringify({ url: rootUrl }), 'utf8');
        const store = join(root, 'storage', 'key_value_stores', 'default');
        await mkdir(store, { recursive: true });
        await writeFile(join(store, 'INPUT.json'), JSON.stringify(oldInput), 'utf8');
        await writeFile(join(store, '__CLI_INPUT.json'), JSON.stringify(explicitInput), 'utf8');

        const selected = await loadLocalInput({ root, env: { APIFY_INPUT_KEY: '__CLI_INPUT' }, isCloud: false });
        assert.equal(selected.origin, 'apify-cli');
        assert.equal(selected.rawInput, undefined);
        await assert.rejects(readFile(join(root, 'input.json'), 'utf8'), { code: 'ENOENT' });
    });
});

test('Cloud no lee ni crea input.json local y runActor usa el Input oficial', async () => {
    await withTempProject(async root => {
        await writeFile(join(root, 'input.template.json'), JSON.stringify({ url: rootUrl }), 'utf8');
        const selection = await loadLocalInput({ root, env: {}, isCloud: true });
        assert.deepEqual(selection, { origin: 'apify', rawInput: undefined });
        await assert.rejects(readFile(join(root, 'input.json'), 'utf8'), { code: 'ENOENT' });

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

test('runActor usa la URL local directa y registra solo el origen, sin leer Storage ni filtrar secretos', async () => {
    const messages = [];
    const original = log.info;
    log.info = (...args) => messages.push(args);
    try {
        let acquiredUrl, proxyMode;
        const staleStorageInput = { url: 'https://www.backmarket.com/en-us/p/iphone-15' };
        const actor = testActor({ input: staleStorageInput });
        await runActor({ actor, rawInput: { url: rootUrl }, inputSource: 'input.json', env: credentials, budget: testBudget(),
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
        assert.match(JSON.stringify(messages), /"origin":"input\.json"/);
        assert.doesNotMatch(JSON.stringify(messages), /test-secret=must-not-log|wu_732a50ce/);
    } finally {
        log.info = original;
    }
});

test('esquema de Input existente sigue exponiendo solo url', async () => {
    const schema = JSON.parse(await readFile(new URL('../.actor/input_schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(schema.properties), ['url']);
    assert.deepEqual(schema.required, ['url']);
    const template = JSON.parse(await readFile(new URL('../input.template.json', import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(template), ['url']);
    assert.equal(template.url, rootUrl);
});
