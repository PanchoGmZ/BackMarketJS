
import { array, record } from '../shared/values.js';

export const officialWeights = Object.freeze({
    'apple|iphone 15 plus': { raw: '201 g', kg: 0.201,
        sourceUrl: 'https://support.apple.com/es-es/111830', verifiedOn: '2026-11-05' },
});
const bounds = { smartphone: [0.02, 2], tablet: [0.05, 5], laptop: [0.1, 20] };
const factors = { g: [1n, 3], kg: [1n, 0], oz: [28349523125n, 12], lb: [45359237n, 8] };
export const key = v => typeof v === 'string' ? v.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss').trim().replace(/\s+/g, ' ') : '';
function multiplyToKg(number, unit) {
    const [whole, fraction = ''] = number.split('.');
    const [factor, power] = factors[unit];
    const digits = (BigInt(whole + fraction) * factor).toString();
    const scale = fraction.length + power;
    if (!scale) return Number(digits);
    const padded = digits.padStart(scale + 1, '0');
    return Number(padded.slice(0, -scale) + '.' + padded.slice(-scale));
}
export function normalizeWeight(raw, productType = null) {
    const result = { raw: typeof raw === 'string' ? raw : null, unit: null, candidateKg: null,
        status: 'unverified', reason: 'EXPLICIT_UNIT_REQUIRED' };
    if (typeof raw !== 'string' || raw.length > 100) return result;
    const match = raw.match(/^\s*(\d+(?:[.,]\d+)?)\s*(kg|g|oz|lbs?)\s*$/i);
    if (!match) return result;
    const number = match[1], unit = match[2].toLowerCase().replace('lbs', 'lb');
    result.unit = unit;
    if (number.includes(',') && number.split(',')[1].length === 3 && !number.startsWith('0,')) {
        result.reason = 'AMBIGUOUS_NUMBER_FORMAT'; return result;
    }
    if (number.length > 30) { result.reason = 'EXCESSIVE_VALUE'; return result; }
    const kg = multiplyToKg(number.replace(',', '.'), unit);
    result.candidateKg = kg;
    if (kg <= 0) result.reason = 'NON_POSITIVE_WEIGHT';
    else if (bounds[productType] && (kg < bounds[productType][0] || kg > bounds[productType][1])) {
        result.status = 'suspicious'; result.reason = 'OUTSIDE_PRODUCT_TYPE_RANGE';
    } else { result.status = 'normalized'; result.reason = 'EXPLICIT_UNIT_CONVERSION'; }
    return result;
}
export function productIdentity(product, specs) {
    const brands = new Set(), models = new Set();
    if (key(product.brand)) brands.add(key(product.brand));
    if (key(product.model)) models.add(key(product.model));
    for (const spec of specs) {
        const names = [key(spec.display), key(spec.field)];
        const target = names.some(n => ['brand', 'marca', 'marque'].includes(n)) ? brands
            : names.some(n => ['model', 'modelo', 'modele'].includes(n)) ? models : null;
        if (target) for (const value of array(spec.values)) if (key(value?.label)) target.add(key(value.label));
    }
    const brand = brands.size === 1 ? [...brands][0] : null, model = models.size === 1 ? [...models][0] : null;
    let productType = null;
    if (model) {
        if (/^(ipad |galaxy tab |surface pro )/.test(model)) productType = 'tablet';
        else if (/^(macbook |thinkpad |latitude |chromebook )/.test(model)) productType = 'laptop';
        else if (/^(iphone\s+\d|galaxy\s+(s\d|a\d|note|z\s)|pixel\s+\d)/.test(model)) productType = 'smartphone';
    }
    return { brand, model, productType };
}
export function roundWeightKg(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return { value: null, warning: null };
    const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
    return rounded === 0 ? { value: null, warning: 'POSITIVE_WEIGHT_BELOW_TWO_DECIMAL_PRECISION' }
        : { value: rounded, warning: null };
}
export function productWeight(product, specifications) {
    const { brand, model, productType } = productIdentity(product, specifications);
    const candidates = [], excludedShippingValues = [];
    for (const spec of specifications) {
        const names = key(spec.display) + ' ' + key(spec.field);
        if (!/weight|peso|poids/.test(names)) continue;
        const shipping = /shipping|shipment|package|packaging|gross|envio|embalaje|bruto|expedition/.test(names);
        for (const value of array(spec.values).filter(record)) {
            if (shipping) { if (typeof value.label === 'string') excludedShippingValues.push(value.label); continue; }
            candidates.push({ ...normalizeWeight(value.label, productType), field: spec.field || spec.display });
        }
    }
    const metadata = { kind: 'physical_product', shippingWeightKg: null, brand, model, productType,
        candidates, excludedShippingValues, status: 'unverified', reason: 'NO_RELIABLE_PHYSICAL_WEIGHT',
        source: null, sourceUrl: null, verifiedOn: null, sourceValue: null, valueKg: null };
    const official = officialWeights[brand + '|' + model];
    if (official) Object.assign(metadata, { status: 'official', reason: 'EXACT_MODEL_MANUFACTURER_SPECIFICATION',
        source: 'manufacturer', sourceUrl: official.sourceUrl, verifiedOn: official.verifiedOn, sourceValue: official.raw, valueKg: official.kg });
    else if (candidates.length) {
        const valid = candidates.filter(c => c.status === 'normalized');
        if (!productType) metadata.reason = 'PRODUCT_TYPE_UNVERIFIED';
        else if (valid.length === candidates.length && new Set(valid.map(c => c.candidateKg)).size === 1) {
            Object.assign(metadata, { status: 'published_normalized', reason: 'EXPLICIT_PRODUCT_SPECIFICATION',
                source: 'backmarket.technical_specifications', sourceValue: valid[0].raw, valueKg: valid[0].candidateKg });
        } else metadata.reason = 'CONFLICTING_OR_SUSPICIOUS_PUBLISHED_WEIGHT';
    }
    const rounded = roundWeightKg(metadata.valueKg);
    metadata.roundedValueKg = rounded.value;
    if (rounded.warning) metadata.roundingWarning = rounded.warning;
    return { weight: rounded.value === null ? null : { value: rounded.value, unit: 'kg' }, metadata };
}
