import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionError } from '../shared/values.js';

const INPUT_ORIGIN = 'storage/key_value_stores/default/INPUT.json';

export async function loadLocalInput({ root = process.cwd(), isCloud = process.env.APIFY_IS_AT_HOME === '1' } = {}) {
    if (isCloud) return { origin: 'apify', rawInput: undefined };

    let content;
    try {
        content = await readFile(resolve(root, INPUT_ORIGIN), 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') throw new ExtractionError('LOCAL_STORAGE_INPUT_MISSING', 'input');
        throw new ExtractionError('LOCAL_STORAGE_INPUT_READ_ERROR', 'input');
    }

    try {
        return { origin: INPUT_ORIGIN, rawInput: JSON.parse(content.replace(/^\uFEFF/, '')) };
    } catch {
        throw new ExtractionError('INVALID_LOCAL_STORAGE_INPUT_JSON', 'input');
    }
}
