
import { decimal, record, imageUrl } from './values.js';
export const fields = ['url','title','price','productLadderPrices','moq','weight','dimensions','images','characteristics','variations','productId'];
export function assertProduct(p) {
    const nullableText = v => v === null || typeof v === 'string';
    const exact = (v, keys) => record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
    let valid = exact(p, fields) && typeof p.url === 'string' && typeof p.productId === 'string'
        && nullableText(p.title) && (p.price === null || decimal(p.price) !== null)
        && Array.isArray(p.productLadderPrices) && p.productLadderPrices.length === 0 && p.moq === null && p.dimensions === null;
    valid &&= p.weight === null || (exact(p.weight,['value','unit']) && Number.isFinite(p.weight.value) && p.weight.value > 0 && p.weight.unit === 'kg');
    valid &&= p.images === null || (Array.isArray(p.images) && p.images.every(i => imageUrl(i) !== null) && new Set(p.images).size === p.images.length);
    valid &&= p.characteristics === null || (Array.isArray(p.characteristics) && p.characteristics.every(c =>
        exact(c,['attrName','attrValue']) && nullableText(c.attrName) && nullableText(c.attrValue)));
    valid &&= p.variations === null || (Array.isArray(p.variations) && p.variations.every(g =>
        exact(g,['name','variants']) && typeof g.name === 'string' && Array.isArray(g.variants) && g.variants.every(v =>
            exact(v,['name','price','image']) && nullableText(v.name) && nullableText(v.image) && (v.price === null || decimal(v.price) !== null))));
    if (!valid) throw new Error('INVALID_REFERENCE1688_CONTRACT');
    return p;
}
