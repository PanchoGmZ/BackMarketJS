
import { UUID_RE, UUID_SOURCE, record } from '../shared/values.js';

// Data-only port of the Python decoder: no eval, JS execution or custom revivers.
export function decode(payload) {
    if (!Array.isArray(payload) || !payload.length || payload.length > 100_000) throw new Error('INVALID_NUXT_TABLE');
    const cache = new Map();
    function revive(index, depth = 0) {
        if (!Number.isSafeInteger(index) || depth > 80) throw new Error('INVALID_NUXT_REFERENCE');
        if (index < 0) return index === -5 ? 0 : null;
        if (index >= payload.length) throw new Error('NUXT_REFERENCE_OUT_OF_RANGE');
        if (cache.has(index)) return cache.get(index);
        const value = payload[index];
        let output;
        if (record(value)) {
            output = Object.create(null);
            cache.set(index, output);
            for (const [key, ref] of Object.entries(value)) output[key] = revive(ref, depth + 1);
        } else if (Array.isArray(value)) {
            if (typeof value[0] === 'string') {
                const tag = value[0];
                if (['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef', 'EmptyRef', 'EmptyShallowRef'].includes(tag)) {
                    cache.set(index, null);
                    output = value.length > 1 ? revive(value[1], depth + 1) : null;
                } else if (['Date', 'BigInt'].includes(tag)) output = value[1] ?? null;
                else output = null;
            } else {
                output = []; cache.set(index, output);
                for (const ref of value) output.push(revive(ref, depth + 1));
            }
        } else output = value;
        cache.set(index, output); return output;
    }
    return revive(0);
}

function fingerprint(value, ancestors = new Set()) {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (ancestors.has(value)) throw new Error('CYCLIC_COMMERCE_CANDIDATE');
    ancestors.add(value);
    const out = Array.isArray(value)
        ? '[' + value.map(v => fingerprint(v, ancestors)).join(',') + ']'
        : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + fingerprint(value[k], ancestors)).join(',') + '}';
    ancestors.delete(value);
    return out;
}

export function findCommerce(root, productId) {
    const candidates = { product: new Set(), pickers: new Set(), specifications: new Set() };
    const visited = new WeakMap(); let count = 0;
    function walk(value, bound = false, depth = 0) {
        if (!value || typeof value !== 'object' || depth > 80) return;
        const seen = visited.get(value) ?? new Set();
        if (seen.has(bound)) return;
        seen.add(bound); visited.set(value, seen);
        if (++count > 50_000) throw new Error('EXCESSIVE_EMBEDDED_GRAPH');
        if (Array.isArray(value)) {
            for (const child of value) walk(child, bound, depth + 1);
            return;
        }
        if (typeof value.productId === 'string' && UUID_RE.test(value.productId)) bound = value.productId.toLowerCase() === productId;
        const groups = value.pickerGroups;
        if (Array.isArray(groups)) {
            if (!value.productId && typeof value.selectedOffer?.productId === 'string'
                && value.selectedOffer.productId.toLowerCase() === productId)
                bound = true;
            const selectedIds = groups.flatMap(g => Array.isArray(g?.items) ? g.items : [])
                .filter(i => i?.selected === true && typeof i.productId === 'string').map(i => i.productId.toLowerCase());
            bound = bound || selectedIds.includes(productId);
        }
        const kind = record(value.titles) && Array.isArray(value.images) ? 'product'
            : Array.isArray(groups) ? 'pickers' : Array.isArray(value.specifications) ? 'specifications' : null;
        if (bound && kind) candidates[kind].add(value);
        for (const [key, child] of Object.entries(value)) {
            const ids = key.match(new RegExp(UUID_SOURCE, 'gi')) ?? [];
            walk(child, ids.length ? ids.map(id => id.toLowerCase()).includes(productId) : bound, depth + 1);
        }
    }
    walk(root);
    const result = {};
    for (const [kind, values] of Object.entries(candidates)) {
        const unique = new Map([...values].map(value => [fingerprint(value), value]));
        if (unique.size === 1) result[kind] = unique.values().next().value;
    }
    return result;
}
