import { constants } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ExtractionError } from '../shared/values.js';

function encodeRecordKey(key) {
    return encodeURIComponent(key).replaceAll(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function readLocalStoreInput(root, env, key) {
    const storageDir = env.APIFY_LOCAL_STORAGE_DIR ?? env.CRAWLEE_STORAGE_DIR ?? 'storage';
    const storeId = env.APIFY_DEFAULT_KEY_VALUE_STORE_ID ?? 'default';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(storeId)) return undefined;
    const filePath = resolve(root, storageDir, 'key_value_stores', storeId, `${encodeRecordKey(key)}.json`);
    try {
        return JSON.parse((await readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
    } catch {
        return undefined;
    }
}

async function hasExplicitInputOverride(root, env) {
    const temporaryKey = [env.ACTOR_INPUT_KEY, env.APIFY_INPUT_KEY, env.CRAWLEE_INPUT_KEY]
        .find(key => typeof key === 'string' && key.startsWith('__CLI_'));
    if (!temporaryKey) return false;

    // The CLI also materializes an old stored INPUT under __CLI_INPUT on a
    // plain run. That is not an explicit override when both records match.
    const baseKey = temporaryKey.slice('__CLI_'.length);
    const [temporaryInput, storedInput] = await Promise.all([
        readLocalStoreInput(root, env, temporaryKey),
        readLocalStoreInput(root, env, baseKey),
    ]);
    if (temporaryInput === undefined || storedInput === undefined) return true;
    return !isDeepStrictEqual(temporaryInput, storedInput);
}

export async function loadLocalInput({ root = process.cwd(), env = process.env,
    isCloud = process.env.APIFY_IS_AT_HOME === '1' } = {}) {
    if (isCloud) return { origin: 'apify', rawInput: undefined };
    if (await hasExplicitInputOverride(root, env)) return { origin: 'apify-cli', rawInput: undefined };

    const inputPath = resolve(root, 'input.json');
    const templatePath = resolve(root, 'input.template.json');
    let content;
    try {
        content = await readFile(inputPath, 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT') throw new ExtractionError('LOCAL_INPUT_READ_ERROR', 'input');
        try {
            await copyFile(templatePath, inputPath, constants.COPYFILE_EXCL);
        } catch (copyError) {
            if (copyError?.code !== 'EEXIST') throw new ExtractionError('LOCAL_INPUT_TEMPLATE_ERROR', 'input');
        }
        try {
            content = await readFile(inputPath, 'utf8');
        } catch {
            throw new ExtractionError('LOCAL_INPUT_READ_ERROR', 'input');
        }
    }

    try {
        return { origin: 'input.json', rawInput: JSON.parse(content.replace(/^\uFEFF/, '')) };
    } catch {
        throw new ExtractionError('INVALID_LOCAL_INPUT_JSON', 'input');
    }
}
