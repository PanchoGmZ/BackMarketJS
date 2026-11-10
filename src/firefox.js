import { firefox } from 'playwright';
import { acquireOnce } from './browser.js';

// Playwright's Firefox engine uses the shared page acquisition and Nuxt input,
// but does not use Chromium's one-time recovery policy.
export async function acquire(input, options = {}) {
    return acquireOnce(input, { ...options, browserType: options.browserType ?? firefox, transport: 'firefox' });
}
