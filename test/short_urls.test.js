import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { parseInput, safeUrl, selectionState } from '../src/input.js';
import { extractHtml } from '../src/extract.js';
import { assertProduct } from '../src/contract.js';

const samples = ['ipad-air-2022-m1-series','macbook-pro-m3-series','apple-watch-series-11','xbox-series-s'];
const base = 'https://www.backmarket.com/en-us/p/';
const ids = ['eda80a12-a40b-4faa-b0f6-438bea90f1e5','393000c0-1f19-43fc-9f89-e6faf3f3bd46'];
function fixture(id = ids[0]) {
    const path = './fixtures/reference/'+id+'/';
    const html = readFileSync(new URL(path+'commercial.html',import.meta.url),'utf8');
    const expected = JSON.parse(readFileSync(new URL(path+'python-output.json',import.meta.url),'utf8'));
    const data = JSON.parse(load(html)('#captured-commercial-data').html()).data;
    return {html,expected,data,url:expected.url.replace('/'+id,'')};
}
const canonical = url => '<link rel="canonical" href="'+url+'">';
function embedded(id,data) {
    // Negative/alias tests use existing authentic commerce, never invented category data.
    return '<script id="captured-commercial-data" type="application/json">'+JSON.stringify({productId:id,data})+'</script>';
}
test('four supplied short URLs validate without manufacturing a UUID or dropping commercial selections',()=>{
    for(const slug of samples) for(const suffix of ['', '/', '?l=12&offerType=0']) {
        const url=base+slug+suffix,input=parseInput({url});
        assert.equal(input.productId,null);assert.equal(input.url,url);assert.equal(safeUrl(url),url);
        assert.equal(selectionState(url,url).status,suffix.includes('?')?'preserved':'not_requested');
    }
    const url=base+'iphone-16-128-gb-black-unlocked/1cc63d15-bcc7-4068-b203-2ddcf6c74167?l=12';
    assert.equal(parseInput({url}).productId,'1cc63d15-bcc7-4068-b203-2ddcf6c74167');
    assert.equal(parseInput({url}).url,url);
    for(const url of [base+'x?token=private',base+'x?l=12&l=13',base+'x/not-a-uuid',base+'x%2Fy',
        'https://www.backmarket.com/en-us/l/tablets','https://www.backmarket.com/en-us/search?q=ipad',
        'https://evil.invalid/en-us/p/x','http://www.backmarket.com/en-us/p/x',base+'x#fragment'])
        assert.throws(()=>parseInput({url}));
});
for(const id of ids) test('short alias mechanics retain original eleven commercial values: '+id,()=>{
    const {html,expected,url}=fixture(id),input=parseInput({url});
    // SYNTHETIC canonical wrapper on an authentic phone capture, not a family page capture.
    const result=extractHtml(canonical(expected.url)+html,input);
    assert.deepEqual(result.output,{...expected,url});assertProduct(result.output);
    assert.equal(input.productId,id);assert.deepEqual(result.metadata.productIdentity.sources,['canonical']);
});
test('short URL can bind to a UUID returned by the existing single navigation',()=>{
    const {html,expected,url}=fixture(),input=parseInput({url});input._documentUrl=expected.url;
    const result=extractHtml(html,input);
    assert.deepEqual(result.output,{...expected,url});assert.deepEqual(result.metadata.productIdentity.sources,['final-url']);
});
test('JSON-LD page identity binds only a Product associated with the requested page',()=>{
    const {html,expected,url}=fixture(),input=parseInput({url});
    const identity={'@type':'Product','@id':url.split('?')[0]+'#product',productID:ids[0]};
    const source='<script type="application/ld+json">'+JSON.stringify(identity)+'</script>'+html;
    assert.deepEqual(extractHtml(source,input).output,{...expected,url});
    identity['@id']=base+'unrelated-recommendation';
    assert.throws(()=>extractHtml('<script type="application/ld+json">'+JSON.stringify(identity)+'</script>'+html,parseInput({url})),
        error=>error.code==='SHORT_URL_IDENTITY_UNVERIFIED');
});
test('short URL does not guess identity from a unique cached product, related products or foreign canonical',()=>{
    const {html,expected,url}=fixture();
    for(const source of [html,canonical('https://evil.invalid/en-us/p/x/'+ids[0])+html,
        canonical(expected.url.replace(/\/p\/[^/]+\//,'/p/unrelated/'))+html]) {
        const input=parseInput({url});
        assert.throws(()=>extractHtml(source,input),error=>error.code==='SHORT_URL_IDENTITY_UNVERIFIED');
        assert.equal(input.productId,null);
    }
    assert.throws(()=>extractHtml(canonical(expected.url)+canonical(expected.url.replace(ids[0],ids[1]))+html,parseInput({url})),
        error=>error.code==='SHORT_URL_IDENTITY_AMBIGUOUS');
});
test('short URL requires a verified price and an explicit association to the selected offer',()=>{
    for(const corruption of ['price','selection','conflict']) {
        const {data,expected,url}=fixture(),input=parseInput({url});
        if(corruption==='price')data.pickers.selectedOffer.price.amount=null;
        if(corruption==='selection'){
            delete data.pickers.selectedOffer.productId;
            for(const group of data.pickers.pickerGroups)for(const item of group.items)item.selected=false;
        }
        if(corruption==='conflict')data.pickers.selectedOffer.productId=ids[1];
        assert.throws(()=>extractHtml(canonical(expected.url)+embedded(ids[0],data),input),
            error=>error.code==='SHORT_URL_SELECTED_OFFER_UNVERIFIED');
        assert.equal(input.productId,null);
    }
});
test('short Nuxt identity reuses the existing decoder and commerce verifier',()=>{
    const {data,expected,url}=fixture(),table=[];
    function encode(v){const i=table.length;table.push(null);table[i]=Array.isArray(v)?v.map(encode)
        :v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,value])=>[k,encode(value)])):v;return i;}
    // SYNTHETIC Nuxt serialization of existing commerce; no invented tablets/laptops/consoles.
    encode({data:{['products/'+ids[0]]:data}});
    const source=canonical(expected.url)+'<script id="__NUXT_DATA__" type="application/json">'+JSON.stringify(table)+'</script>';
    assert.deepEqual(extractHtml(source,parseInput({url})).output,{...expected,url});
});
test('family pages without a selected commercial offer fail instead of exporting a listing price',()=>{
    for(const slug of samples){
        const input=parseInput({url:base+slug});
        assert.throws(()=>extractHtml('<html><title>Family page without a verified selection</title></html>',input),
            error=>error.code==='SHORT_URL_IDENTITY_UNVERIFIED'&&error.stage==='transformation');
        assert.equal(input.productId,null);
    }
});
test('oversized identity graph is rejected rather than truncating conflicting page evidence',()=>{
    const {html,expected,url}=fixture();
    const graph=Array.from({length:1001},()=>({'@type':'Product',url,productID:ids[0]}));
    const source=canonical(expected.url)+'<script type="application/ld+json">'+JSON.stringify({'@graph':graph})+'</script>'+html;
    assert.throws(()=>extractHtml(source,parseInput({url})),error=>error.code==='SHORT_URL_IDENTITY_UNVERIFIED');
});
