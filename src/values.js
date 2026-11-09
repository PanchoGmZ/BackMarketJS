
export const UUID_SOURCE = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
export const UUID_RE = new RegExp('^' + UUID_SOURCE + '$', 'i');
export const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const object = v => record(v) ? v : {};
export const array = v => Array.isArray(v) ? v : [];
export const text = v => typeof v === 'string' && v.trim() ? v.trim() : null;
export const decimal = v => typeof v === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v) ? v : null;
export function decimalEqual(a, b) {
    const canon = v => v.replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, '$1');
    return decimal(a) !== null && decimal(b) !== null && canon(a) === canon(b);
}
export function imageUrl(v) {
    if (typeof v !== 'string') return null;
    try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? v : null; }
    catch { return null; }
}
export class ExtractionError extends Error {
    constructor(code, stage, status = 'error') {
        super(code); this.code = code; this.stage = stage; this.status = status;
    }
}
