
import { Budget } from './budget.js';
// Arm a process guard before importing the SDK, Cheerio or Playwright.
const budget = new Budget();
try {
    const { readFile, realpath } = await import('node:fs/promises');
    const { resolve, relative, isAbsolute } = await import('node:path');
    const root = await realpath(process.cwd());
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
        if (!['--input','--offline'].includes(args[i]) || !args[i + 1]) throw new Error('INVALID_CLI');
        const path = await realpath(resolve(root, args[i + 1])), rel = relative(root, path);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('INVALID_LOCAL_PATH');
        const content = await readFile(path, 'utf8');
        options[args[i] === '--input' ? 'rawInput' : 'offlineHtml'] = args[i] === '--input' ? JSON.parse(content.replace(/^\uFEFF/, '')) : content;
    }
    const { runActor } = await import('./run.js');
    const result = await runActor({ ...options, budget });
    process.exitCode = result.exitCode;
} catch {
    const { log } = await import('apify');
    log.error('[STARTUP_ERROR] Unable to initialize the JavaScript Actor. Private details omitted.');
    budget.stop(); process.exitCode = 1;
}
