
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { extractHtml, transform } from '../src/extract.js';
import { parseInput, selectionState } from '../src/input.js';
import { decode, findCommerce } from '../src/nuxt.js';
import { normalizeWeight, productWeight } from '../src/weight.js';
import { assertProduct } from '../src/contract.js';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const ids = ['eda80a12-a40b-4faa-b0f6-438bea90f1e5', '393000c0-1f19-43fc-9f89-e6faf3f3bd46'];
const schema = JSON.parse(read('../.actor/dataset_schema.json')).fields;
const ajv = new Ajv({ allErrors: true }); addFormats(ajv); const validate = ajv.compile(schema);
function fixture(id = ids[0]) {
    const html = read('./fixtures/reference/' + id + '/commercial.html');
    const expected = JSON.parse(read('./fixtures/reference/' + id + '/python-output.json'));
    const data = JSON.parse(load(html)('#captured-commercial-data').html()).data;
    return { html, expected, data, input: parseInput({ url: expected.url }) };
}
function nuxtTable(value) {
    // SYNTHETIC serialization of the captured commerce, not a raw page payload.
    const table = [];
    function encode(v) {
        const i = table.length; table.push(null);
        table[i] = Array.isArray(v) ? v.map(encode) : v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).map(([k,child]) => [k,encode(child)])) : v;
        return i;
    }
    encode(value); return table;
}
for (const id of ids) {
    test('exact eleven-field equality against authentic Python output: ' + id, () => {
        const { html, expected, input } = fixture(id);
        const result = extractHtml(html, input);
        assert.deepStrictEqual(result.output, expected);
        assertProduct(result.output); assert.equal(validate(result.output), true, JSON.stringify(validate.errors));
        assert.equal(result.metadata.currency, 'USD');
        assert.equal(result.missing.every(k => k.startsWith('variations[') || k.startsWith('variantMetadata[')), true);
        if (id === ids[1]) assert.equal(result.output.variations[3].variants[3].price, null);
    });
    test('Nuxt decoder preserves same saved commerce: ' + id, () => {
        const { data, expected, input } = fixture(id);
        const table = nuxtTable({ data: { ['products/' + id]: data } });
        const html = '<script id="__NUXT_DATA__" type="application/json">' + JSON.stringify(table) + '</script>';
        const result = extractHtml(html, input);
        assert.deepStrictEqual(result.output, expected);
        assert.equal(result.metadata.sourceDiagnostics.nuxtScripts, 1);
    });
}
test('user iPhone 14 Plus reference: contract, counts and explicit 7 oz conversion', () => {
    const expected = JSON.parse(read('./fixtures/iphone14plus.python-output.json'));
    assertProduct(expected); assert.equal(validate(expected), true);
    assert.equal(expected.price, '299.00'); assert.equal(expected.images.length, 6);
    assert.equal(expected.characteristics.length, 27); assert.equal(expected.variations.length, 4);
    assert.equal(expected.variations.reduce((n,g) => n + g.variants.length,0), 15);
    assert.equal(normalizeWeight('7 oz','smartphone').candidateKg, expected.weight.value);
    // No source HTML or fabricated picker IDs are derived from this output.
});
test('selected price cannot use original or JSON-LD reference prices', () => {
    const { input, data } = fixture();
    data.product.priceWhenNew = { amount: '9999.00' };
    data.pickers.selectedOffer = {};
    const result = transform(input, data);
    assert.equal(result.output.price, null);
    const html = '<script type="application/ld+json">' + JSON.stringify({ '@type':'Product', name:'Partial',
        offers:{'@type':'Offer',price:'1.00',priceCurrency:'USD'} }) + '</script>';
    const partial = extractHtml(html,input);
    assert.equal(partial.output.price,null); assert.equal(partial.metadata.sourceDiagnostics.jsonLdOfferPriceFound,true);
});
test('selected UUID, currency, price and ambiguous selection are verified', () => {
    for (const kind of ['product','currency','price','multiple']) {
        const { input, data } = fixture();
        const group = data.pickers.pickerGroups.find(g => g.items.some(i => i.selected));
        const item = group.items.find(i => i.selected);
        if (kind === 'product') item.productId = '00000000-0000-4000-8000-000000000000';
        if (kind === 'currency') item.price.currency = 'EUR';
        if (kind === 'price') item.price.amount = '0.01';
        if (kind === 'multiple') group.items.push({ ...item });
        assert.equal(transform(input,data).output.price,null,kind);
    }
});
test('variant prices require associated ID/currency; no cartesian combinations', () => {
    const { input, data } = fixture();
    const total = data.pickers.pickerGroups.reduce((n,g) => n + g.items.length,0);
    data.pickers.pickerGroups[0].items[0].productId = null;
    const result = transform(input,data);
    assert.equal(result.output.variations[0].variants[0].price,null);
    assert.equal(result.output.variations.reduce((n,g) => n + g.variants.length,0),total);
    assert.equal(result.metadata.variantGroups[0].options[0].productId,null);
});
test('foreign/ambiguous Nuxt caches are not selected and unknown revivers never execute', () => {
    const { data,input } = fixture();
    assert.deepEqual(findCommerce({ productId:'00000000-0000-4000-8000-000000000000', data },'00000000-0000-4000-8000-000000000001'),{});
    const duplicate = structuredClone(data.product); duplicate.titles.raw = 'Different stale cache';
    const found = findCommerce({ productId:input.productId, entries:[data.product,duplicate] },input.productId);
    assert.equal(found.product,undefined);
    assert.equal(decode([['UnknownReviver',1],{ private:2 },'NEVER_EXECUTED']),null);
    assert.throws(() => decode([{ x: 999 }]));
    const polluted = decode([JSON.parse('{"__proto__":1}'),{polluted:2},true]);
    assert.equal(Object.getPrototypeOf(polluted),null); assert.equal({}.polluted,undefined);
});
test('weight unit conversion, shipping exclusion and exact manufacturer model rules', () => {
    for (const [raw,kg] of [['201 g',.201],['1 kg',1],['7 oz',.198446661875],['1 lb',.45359237]]) {
        assert.equal(normalizeWeight(raw,'smartphone').candidateKg,kg);
    }
    assert.equal(normalizeWeight('201 oz','smartphone').status,'suspicious');
    assert.equal(normalizeWeight('1,234 g','smartphone').candidateKg,null);
    const specs = [{display:'Weight',field:'weight',values:[{label:'201 oz'}]}];
    assert.deepEqual(productWeight({brand:'Apple',model:'iPhone 15 Plus'},specs).weight,{value:.201,unit:'kg'});
    assert.equal(productWeight({brand:'Apple',model:'iPhone 14 Plus'},specs).weight,null);
    assert.equal(productWeight({brand:'Apple',model:'iPhone 14 Plus'},[{display:'Shipping weight',values:[{label:'7 oz'}]}]).weight,null);
});
test('URL selections remain dynamic, strict and preserved', () => {
    const { expected } = fixture();
    const input = parseInput({ url: expected.url.split('?')[0] + '?l=12&offerType=0' });
    assert.equal(input.productId,ids[0]); assert.equal(selectionState(input.url,input.url).status,'preserved');
    assert.equal(selectionState(input.url,expected.url.split('?')[0]).status,'changed_or_removed');
    for (const url of [input.url.replace('https:','http:'),input.url+'&l=13',input.url+'&token=private',
        input.url.replace('www.backmarket.com','evil.invalid'),input.url.replace('/en-us/p/','/short/'),
        input.url+'#fragment',input.url.replace('https://','https://user:password@')]) assert.throws(() => parseInput({url}));
});
