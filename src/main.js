
import { Budget } from './shared/budget.js';
import { loadLocalEnvFile } from './platform/local_env.js';
import { loadLocalInput } from './platform/local_input.js';
// Arm a process guard before importing the SDK, Cheerio or Playwright.
const budget = new Budget();
try {
    loadLocalEnvFile();
    const { readFile, realpath } = await import('node:fs/promises');
    const { resolve, relative, isAbsolute } = await import('node:path');
    const root = await realpath(process.cwd());
    const isCloud = process.env.APIFY_IS_AT_HOME === '1';
    const args = process.argv.slice(2), options = {};
    if (!isCloud) {
        for (let i = 0; i < args.length; i += 2) {
            if (args[i] !== '--input' || !args[i + 1]) throw new Error('INVALID_CLI');
            const path = await realpath(resolve(root, args[i + 1])), rel = relative(root, path);
            if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('INVALID_LOCAL_PATH');
            const content = await readFile(path, 'utf8');
            options.rawInput = JSON.parse(content.replace(/^\uFEFF/, ''));
        }
        if (options.rawInput !== undefined) options.inputSource = 'cli-file';
        else Object.assign(options, await loadLocalInput({ root, env: process.env, isCloud: false }));
    } else {
        options.inputSource = 'apify';
    }
    const { runActor } = await import('./platform/actor.js');
    const result = await runActor({ ...options, budget });
    process.exitCode = result.exitCode;
} catch {
    const { log } = await import('apify');
    log.error('[STARTUP_ERROR] Unable to initialize the JavaScript Actor. Private details omitted.');
    budget.stop(); process.exitCode = 1;
}
