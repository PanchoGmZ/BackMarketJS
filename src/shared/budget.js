
import { readFile } from 'node:fs/promises';
import { ExtractionError } from './values.js';
export class Budget {
    constructor({ elapsed, hardExit = code => process.exit(code) } = {}) {
        const now = performance.now();
        const platformStart = process.env.APIFY_IS_AT_HOME === '1' ? Date.parse(process.env.ACTOR_STARTED_AT ?? '') : NaN;
        const initialAge = Math.max(process.uptime() * 1000, Number.isFinite(platformStart) ? Date.now() - platformStart : 0);
        this.elapsed = elapsed ?? (() => initialAge + performance.now() - now);
        this.hardExit = hardExit; this.setLimits(180, 160, 178);
    }
    setLimits(total, acquisition, work) {
        this.total = total * 1000; this.acquisition = acquisition * 1000; this.work = work * 1000;
        clearTimeout(this.watchdog);
        this.watchdog = setTimeout(() => this.hardExit(1), this.remaining(this.total));
        this.watchdog.unref?.();
    }
    configure(input) {
        if (input.diagnosticMode) this.setLimits(input.diagnosticTimeoutSeconds, input.diagnosticTimeoutSeconds - 20, input.diagnosticTimeoutSeconds - 2);
        else this.setLimits(55, 48, 52);
    }
    remaining(cutoff = this.work) { return Math.max(0, cutoff - this.elapsed()); }
    stop() { clearTimeout(this.watchdog); }
}
export async function bounded(promise, ms, signal, stage = 'work') {
    let timer, abort;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new ExtractionError('TIMEOUT', stage, 'partial')), Math.max(1, ms));
            abort = () => reject(new ExtractionError('ABORTED', stage, 'aborted'));
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
        })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export async function memoryObservation() {
    for (const file of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
        try { const bytes = Number((await readFile(file, 'utf8')).trim()); if (Number.isFinite(bytes)) return { mb: bytes / 1048576, scope: 'container-cgroup' }; } catch {}
    }
    return { mb: process.memoryUsage().rss / 1048576, scope: 'node-process-only' };
}
