
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { decode, findCommerce } from './nuxt.js';
import { productWeight } from './weight.js';
import { array, object, record, text, decimal, decimalEqual, imageUrl, UUID_RE, UUID_SOURCE } from './values.js';

const parameters = new Set(['grade', 'battery', 'premium_grade', 'battery_confidence_experiment',
    'cheapest_for_first_picker', 'storage', 'color']);
export function commercialSubset(data) {
    const out = {};
    if (record(data.product)) {
        const p = data.product, titles = object(p.titles);
        out.product = { productId: text(p.productId), brand: text(p.brand), model: text(p.model),
            titles: Object.fromEntries(['raw', 'default', 'subtitle'].map(k => [k, text(titles[k])])),
            images: array(p.images).filter(record).map(i => ({ url: imageUrl(i.url) })) };
    }
    if (record(data.pickers)) {
        const p = data.pickers, offer = object(p.selectedOffer), price = object(offer.price);
        out.pickers = { pickerGroups: array(p.pickerGroups).filter(g => record(g) && Array.isArray(g.items)).map(g => ({
            id: text(g.id), items: g.items.filter(record).map(i => ({
                label: text(i.label), productId: text(i.productId), slug: text(i.slug),
                price: { amount: decimal(object(i.price).amount), currency: text(object(i.price).currency) },
                available: typeof i.available === 'boolean' ? i.available : null,
                selected: typeof i.selected === 'boolean' ? i.selected : null,
                parameters: Object.fromEntries(Object.entries(object(i.parameters)).filter(([k, v]) => parameters.has(k)
                    && (v === null || ['string', 'boolean'].includes(typeof v) || (typeof v === 'number' && Number.isFinite(v))))),
            })),
        })), selectedOffer: { price: { amount: decimal(price.amount), currency: text(price.currency) },
            offerId: text(offer.offerId), sku: text(offer.sku), productId: text(offer.productId) },
        isOutOfStock: typeof p.isOutOfStock === 'boolean' ? p.isOutOfStock : null };
    }
    if (record(data.specifications)) {
        const p = data.specifications;
        out.specifications = { title: text(p.title), specifications: array(p.specifications).filter(record).map(s => ({
            display: text(s.display), field: text(s.field),
            values: array(s.values).filter(record).map(v => ({ label: text(v.label) })),
        })) };
    }
    return out;
}
export function selectedPrice(input, pickers) {
    const offer = object(pickers.selectedOffer), price = object(offer.price);
    const amount = decimal(price.amount), currency = text(price.currency);
    const verification = { status: 'unverified', reason: null, selectedOptionChecks: 0,
        requestedProductId: input.productId, selectedOfferProductId: offer.productId ?? null,
        reportedAmount: amount, reportedCurrency: currency };
    if (amount === null) verification.reason = 'SELECTED_OFFER_AMOUNT_MISSING_OR_INVALID';
    else if (!currency || !/^[A-Z]{3}$/.test(currency)) verification.reason = 'SELECTED_OFFER_CURRENCY_MISSING_OR_INVALID';
    else if (offer.productId && offer.productId.toLowerCase() !== input.productId) verification.reason = 'SELECTED_OFFER_PRODUCT_MISMATCH';
    else {
        for (const group of array(pickers.pickerGroups)) {
            const selected = group.items.filter(i => i.selected === true);
            if (selected.length > 1) { verification.reason = 'AMBIGUOUS_PICKER_SELECTION'; break; }
            for (const item of selected) {
                verification.selectedOptionChecks++;
                if (item.productId && item.productId.toLowerCase() !== input.productId) verification.reason = 'SELECTED_OPTION_PRODUCT_MISMATCH';
                else if (item.price.amount !== null && !decimalEqual(item.price.amount, amount)) verification.reason = 'SELECTED_OPTION_PRICE_MISMATCH';
                else if (item.price.currency && item.price.currency !== currency) verification.reason = 'SELECTED_OPTION_CURRENCY_MISMATCH';
            }
            if (verification.reason) break;
        }
        if (!verification.reason) Object.assign(verification, { status: 'verified', reason: 'SELECTED_OFFER_FOR_REQUESTED_PRODUCT' });
    }
    return { price: verification.status === 'verified' ? amount : null, currency, verification };
}
export function transform(input, raw, fallback = {}) {
    const data = commercialSubset(raw), product = object(data.product), pickers = object(data.pickers);
    const specs = object(data.specifications), offer = object(pickers.selectedOffer), price = object(offer.price);
    if (product.productId && product.productId.toLowerCase() !== input.productId) throw new Error('PRODUCT_ID_MISMATCH');
    const selected = selectedPrice(input, pickers);
    const mass = productWeight(product, array(specs.specifications));
    const images = [...new Set(array(product.images).map(i => i.url).filter(Boolean))];
    const attrs = [];
    for (const spec of array(specs.specifications)) {
        const name = spec.display || spec.field, labels = spec.values.map(v => v.label).filter(Boolean);
        if (name && labels.length) attrs.push({ attrName: name, attrValue: labels.join(', ') });
    }
    const groups = [], variantGroups = [];
    for (const group of array(pickers.pickerGroups)) {
        if (!group.id) continue;
        const variants = [], options = [];
        for (const [index, item] of group.items.entries()) {
            const associated = item.label !== null && item.productId !== null && UUID_RE.test(item.productId)
                && item.price.currency !== null && /^[A-Z]{3}$/.test(item.price.currency);
            variants.push({ name: item.label, price: associated ? item.price.amount : null, image: null });
            options.push({ variantIndex: index, productId: item.productId, available: item.available,
                selected: item.selected, slug: item.slug, parameters: item.parameters, currency: item.price.currency });
        }
        variantGroups.push({ groupIndex: groups.length, id: group.id, options });
        groups.push({ name: group.id, variants });
    }
    const titles = object(product.titles);
    const output = { url: input.url, title: titles.raw || titles.default || fallback.title || null,
        price: selected.price, productLadderPrices: [], moq: null, weight: mass.weight, dimensions: null,
        images: images.length ? images : fallback.images?.length ? fallback.images : null,
        characteristics: attrs.length ? attrs : null,
        variations: 'pickers' in data ? groups : null, productId: input.productId };
    const missing = ['title', 'price', 'images', 'characteristics', 'variations'].filter(k => !output[k] || (Array.isArray(output[k]) && !output[k].length));
    if (!price.currency) missing.push('selectedOffer.price.currency');
    if (!price.amount) missing.push('selectedOffer.price.amount');
    for (const [g, group] of groups.entries()) for (const [v, variant] of group.variants.entries()) {
        for (const k of ['name', 'price']) if (variant[k] === null) missing.push('variations[' + g + '].variants[' + v + '].' + k);
        for (const k of ['productId', 'available', 'currency']) if (variantGroups[g].options[v][k] === null)
            missing.push('variantMetadata[' + g + '].options[' + v + '].' + k);
    }
    const metadata = { productId: input.productId, url: input.url, currency: selected.currency,
        priceSource: price.amount !== null && price.amount !== undefined ? 'selectedOffer.price' : null,
        offerId: offer.offerId ?? null, sku: offer.sku ?? null, isOutOfStock: pickers.isOutOfStock ?? null,
        variantGroups, priceVerification: selected.verification,
        weightVerification: mass.metadata.status + '; physical product only; shipping weight unavailable',
        weightNormalization: mass.metadata };
    return { output, metadata, missing, commercial: data };
}
export function extractHtml(html, input, responses = {}) {
    if (typeof html !== 'string' || Buffer.byteLength(html) > input.maxHtmlBytes) throw new Error('HTML_TOO_LARGE_OR_INVALID');
    const $ = load(html), data = {}, fallback = {}, inventory = [], sources = {};
    let originalPricePresent = false, jsonLdProductFound = false;
    function remember(kind, value, source, replace = false) {
        if (kind === 'product' && value.priceWhenNew !== undefined && value.priceWhenNew !== null) originalPricePresent = true;
        if (replace || !(kind in data)) { data[kind] = value; sources[kind] = source; }
    }
    $('script').each((_, node) => {
        const script = $(node), raw = script.html() ?? '', id = script.attr('id') ?? '', type = script.attr('type') ?? '';
        if (!['application/json', 'application/ld+json'].includes(type) && id !== '__NUXT_DATA__') return;
        const source = id === '__NUXT_DATA__' ? 'nuxt' : type === 'application/ld+json' ? 'json-ld' : 'embedded-json';
        const entry = { id, type, format: source, length: [...raw].length }; inventory.push(entry);
        try {
            let parsed = JSON.parse(raw);
            if (id === '__NUXT_DATA__') parsed = decode(parsed);
            if (id === 'captured-commercial-data') {
                if (parsed?.productId === input.productId && record(parsed.data))
                    for (const kind of ['product', 'pickers', 'specifications'])
                        if (record(parsed.data[kind])) remember(kind, parsed.data[kind], 'local-commercial-capture', true);
            } else if (type === 'application/ld+json') {
                const nodes = Array.isArray(parsed) ? [...parsed] : [parsed];
                for (const n of [...nodes]) if (record(n)) nodes.push(...array(n['@graph']));
                for (const item of nodes.filter(record)) {
                    const types = typeof item['@type'] === 'string' ? [item['@type']] : array(item['@type']);
                    if (!types.includes('Product')) continue;
                    const declared = ['url', '@id', 'productID'].map(k => String(item[k] ?? '')).join(' ');
                    const ids = declared.match(new RegExp(UUID_SOURCE, 'gi')) ?? [];
                    if (ids.length && !ids.map(i => i.toLowerCase()).includes(input.productId)) continue;
                    jsonLdProductFound = true; fallback.title = text(item.name);
                    const imgs = typeof item.image === 'string' ? [item.image] : array(item.image);
                    fallback.images = [...new Set(imgs.map(imageUrl).filter(Boolean))];
                    let offers = item.offers;
                    if (Array.isArray(offers)) offers = offers.length === 1 ? offers[0] : {};
                    if (record(offers) && offers['@type'] === 'Offer') {
                        fallback.price = decimal(String(offers.price ?? ''));
                        fallback.currency = text(offers.priceCurrency);
                    }
                }
            } else for (const [kind, value] of Object.entries(findCommerce(parsed, input.productId))) remember(kind, value, source);
        } catch { entry.parseError = true; }
    });
    for (const kind of ['product', 'pickers', 'specifications'])
        if (record(responses[kind])) remember(kind, responses[kind], 'page-generated-json', true);
    const result = transform(input, data, fallback);
    result.metadata.htmlInventory = inventory;
    result.metadata.htmlSha256 = createHash('sha256').update(html).digest('hex');
    result.metadata.extractionMethod = 'nuxt';
    result.metadata.sourceDiagnostics = {
        nuxtScripts: inventory.filter(i => i.format === 'nuxt').length,
        jsonLdScripts: inventory.filter(i => i.format === 'json-ld').length,
        embeddedJsonScripts: inventory.filter(i => i.format === 'embedded-json').length,
        scriptErrors: inventory.filter(i => i.parseError).length,
        jsonLdProductFound, jsonLdOfferPriceFound: fallback.price != null, commercialSources: sources,
        selectedOfferPriceFound: result.commercial.pickers?.selectedOffer.price.amount != null,
        selectedOfferCurrencyFound: Boolean(result.commercial.pickers?.selectedOffer.price.currency),
        originalPricePresent, originalPriceUsed: false,
        foundFields: ['title', 'price', 'images', 'characteristics', 'variations'].filter(k => result.output[k] && (!Array.isArray(result.output[k]) || result.output[k].length)),
        missingFields: result.missing,
    };
    return result;
}
