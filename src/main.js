
import { Budget } from './shared/budget.js';
import { loadLocalEnvFile } from './platform/local_env.js';
import { loadLocalInput } from './platform/local_input.js';
// Arm a process guard before importing the SDK, Cheerio or Playwright.
const budget = new Budget();
try {
    loadLocalEnvFile();
    const { realpath } = await import('node:fs/promises');
    const root = await realpath(process.cwd());
    const isCloud = process.env.APIFY_IS_AT_HOME === '1';
    const selectedInput = isCloud
        ? { origin: 'apify', rawInput: undefined }
        : await loadLocalInput({ root, isCloud: false });
    const options = { rawInput: selectedInput.rawInput, inputSource: selectedInput.origin };
    const { runActor } = await import('./platform/actor.js');
    const result = await runActor({ ...options, budget });
    process.exitCode = result.exitCode;
} catch {
    const { log } = await import('apify');
    log.error('[STARTUP_ERROR] Unable to initialize the JavaScript Actor. Private details omitted.');
    budget.stop(); process.exitCode = 1;
}
