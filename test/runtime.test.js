
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { log } from 'apify';
import { runActor } from '../src/run.js';
import { Budget } from '../src/budget.js';
import { proxySettings, configureProxy } from '../src/proxy.js';
import { parseInput } from '../src/input.js';
import { acquire } from '../src/browser.js';
import { classifyHttp, navigationFailure } from '../src/diagnostics.js';
import { extractHtml } from '../src/extract.js';
log.setLevel(log.LEVELS.OFF);
const id = 'eda80a12-a40b-4faa-b0f6-438bea90f1e5';
const html = readFileSync(new URL('./fixtures/reference/' + id + '/commercial.html',import.meta.url),'utf8');
const expected = JSON.parse(readFileSync(new URL('./fixtures/reference/' + id + '/python-output.json',import.meta.url),'utf8'));
const partialId = '393000c0-1f19-43fc-9f89-e6faf3f3bd46';
const partialHtml = readFileSync(new URL('./fixtures/reference/' + partialId + '/commercial.html',import.meta.url),'utf8');
const partialExpected = JSON.parse(readFileSync(new URL('./fixtures/reference/' + partialId + '/python-output.json',import.meta.url),'utf8'));
class FakeActor {
    constructor(input = {url:expected.url,proxyConfiguration:{useApifyProxy:false}}) { this.input=input; this.values={}; this.records=[]; this.offline=[]; this.listeners={}; this.exits=[]; }
    async init() {}
    async getInput() { return this.input; }
    async setValue(k,v) { this.values[k]=structuredClone(v); if(k==='INPUT')this.input=v; }
    async pushData(v) { this.records.push(structuredClone(v)); }
    async openDataset(name) { assert.equal(name,'offline-validation'); return {pushData:async v=>this.offline.push(structuredClone(v))}; }
    on(event,fn) { this.listeners[event]=fn; }
    async exit(options) { this.exits.push(options); }
}
const clock = () => new Budget({elapsed:()=>0,hardExit:()=>assert.fail('watchdog must not fire')});
const success = () => ({html,responses:{},acquisition:{status:'received',requests:[],navigationCount:1}});
test('valid live acquisition pushes exactly one aggregate via default Dataset', async () => {
    const actor=new FakeActor();
    const result=await runActor({actor,budget:clock(),acquireFn:async()=>success()});
    assert.equal(result.state.status,'success'); assert.equal(result.exitCode,0);
    assert.deepEqual(actor.records,[expected]); assert.equal(actor.values.RUN_STATE.savedResults,1);
    assert.equal(actor.values.PRODUCT_METADATA.currency,'USD');
});
test('valid product with incomplete optional variants stays partial but exits successfully after save',async()=>{
    const actor=new FakeActor({url:partialExpected.url,proxyConfiguration:{useApifyProxy:false}});
    const result=await runActor({actor,budget:clock(),acquireFn:async()=>({html:partialHtml,responses:{},acquisition:{status:'received',requests:[],navigationCount:1}})});
    assert.equal(result.state.status,'partial');assert.equal(result.exitCode,0);
    assert.equal(result.state.savedResults,1);assert.equal(actor.records.length,1);
    assert.ok(result.state.missingFields.some(field=>field.startsWith('variantMetadata[')));
    assert.deepEqual(result.metadata.missingFields,result.state.missingFields);
    assert.deepEqual(result.metadata.sourceDiagnostics.missingFields,result.state.missingFields);
});
test('unverified selected price is an error and never reaches the Dataset',async()=>{
    const actor=new FakeActor();
    const parsed=extractHtml(html,{...parseInput({url:expected.url,proxyConfiguration:{useApifyProxy:false}})});
    const commercial=structuredClone(parsed.commercial);commercial.pickers.selectedOffer.price.amount=null;
    const result=await runActor({actor,budget:clock(),acquireFn:async()=>({html:'',responses:commercial,acquisition:{status:'received',requests:[],navigationCount:1}})});
    assert.equal(result.state.status,'error');assert.equal(result.state.error.code,'SELECTED_PRICE_UNVERIFIED');
    assert.equal(result.exitCode,1);assert.equal(actor.records.length,0);assert.equal(result.state.savedResults,0);
});
test('Dataset persistence failure remains Failed even for a verified product',async()=>{
    const actor=new FakeActor();actor.pushData=async()=>{throw new Error('offline storage failure');};
    const result=await runActor({actor,budget:clock(),acquireFn:async()=>success()});
    assert.equal(result.state.status,'error');assert.equal(result.state.error.code,'PERSISTENCE_ERROR');
    assert.equal(result.exitCode,1);assert.equal(result.state.savedResults,0);
});
test('blocked navigation keeps diagnostics and never pushes invented rows', async () => {
    const actor=new FakeActor();
    const result=await runActor({actor,budget:clock(),acquireFn:async()=>({html:'',responses:{},acquisition:{
        status:'blocked',requests:[],error:{code:'HTTP_403'},failureStage:'navigation'}})});
    assert.equal(result.state.status,'blocked'); assert.equal(result.state.error.code,'HTTP_403'); assert.equal(actor.records.length,0);
});
test('prior validated 200 product can be retained with access failure status', async () => {
    const actor=new FakeActor();
    const result=await runActor({actor,budget:clock(),acquireFn:async()=>({html,responses:{},acquisition:{
        status:'blocked',requests:[],candidateBeforeAccessFailure:true,error:{code:'HTTP_403'},failureStage:'navigation'}})});
    assert.equal(result.state.status,'blocked'); assert.equal(result.exitCode,1); assert.equal(actor.records.length,1);
});
test('offline run uses separate dataset and never claims real extraction',async()=>{
    const actor=new FakeActor();
    const result=await runActor({actor,budget:clock(),offlineHtml:html,acquireFn:()=>assert.fail('offline must not navigate')});
    assert.equal(result.state.status,'partial'); assert.equal(result.state.extractionPerformed,false);
    assert.equal(actor.records.length,0); assert.deepEqual(actor.offline,[expected]);
});
test('selection removed on redirect clears price and is rejected as unverifiable',async()=>{
    const actor=new FakeActor();
    const data=success(); data.acquisition.pageSelection={requested:{l:'12'},final:{},status:'changed_or_removed'};
    const result=await runActor({actor,budget:clock(),acquireFn:async()=>data});
    assert.equal(result.state.status,'error'); assert.equal(result.state.error.code,'SELECTED_PRICE_UNVERIFIED');
    assert.equal(result.exitCode,1);assert.equal(actor.records.length,0);
});
test('parser identity errors remain separate from network errors',async()=>{
    const actor=new FakeActor();
    const data=success();data.html=html.replaceAll(id,'00000000-0000-4000-8000-000000000000');
    const result=await runActor({actor,budget:clock(),acquireFn:async()=>data});
    assert.equal(result.state.error.code,'PRODUCT_IDENTITY_UNVERIFIED');assert.equal(actor.records.length,0);
});
test('direct, Residential and Unblocker SDK configuration has one coherent session policy',async()=>{
    for(const group of [null,'RESIDENTIAL','UNBLOCKER','SHADER']){
        const input={proxyConfiguration:{useApifyProxy:Boolean(group),apifyProxyGroups:group?[group]:[]},proxyAccessAuthorized:Boolean(group)};
        const settings=proxySettings(input);const urls=[];
        const actor={createProxyConfiguration:async options=>{
            assert.deepEqual(options,{useApifyProxy:true,groups:[group]});
            return{newUrl:async(...args)=>{urls.push(args);return 'http://user:PRIVATE_PASSWORD@proxy.invalid:8000';}};
        }};
        const proxy=await configureProxy(actor,settings);
        if(!group){assert.equal(proxy,null);assert.equal(urls.length,0);}
        else{assert.equal(urls.length,1);assert.equal(urls[0].length,group==='UNBLOCKER'?0:1);assert.equal(proxy.server,'http://proxy.invalid:8000');}
        assert.equal(JSON.stringify(settings).includes('PRIVATE_PASSWORD'),false);
    }
    assert.throws(()=>proxySettings({proxyConfiguration:{useApifyProxy:true,apifyProxyGroups:['UNBLOCKER','RESIDENTIAL']},proxyAccessAuthorized:true}));
    assert.throws(()=>proxySettings({proxyConfiguration:{useApifyProxy:true,apifyProxyGroups:['UNBLOCKER']}}));
});
test('missing proxy input defaults to Unblocker; explicit direct and Residential selections win',()=>{
    const defaults=parseInput({url:expected.url,proxyAccessAuthorized:true});
    assert.deepEqual(defaults.proxyConfiguration,{useApifyProxy:true,apifyProxyGroups:['UNBLOCKER']});
    assert.equal(proxySettings(defaults).mode,'unblocker');
    const direct=parseInput({url:expected.url,proxyAccessAuthorized:true,proxyConfiguration:{useApifyProxy:false}});
    assert.equal(proxySettings(direct).mode,'direct');
    const residential=parseInput({url:expected.url,proxyAccessAuthorized:true,
        proxyConfiguration:{useApifyProxy:true,apifyProxyGroups:['RESIDENTIAL']}});
    assert.equal(proxySettings(residential).mode,'residential');
});
test('unavailable proxy group has a specific error and no direct fallback',async()=>{
    const settings=proxySettings({proxyConfiguration:{useApifyProxy:true,apifyProxyGroups:['UNBLOCKER']},proxyAccessAuthorized:true});
    await assert.rejects(()=>configureProxy({createProxyConfiguration:async()=>undefined},settings),
        error=>error.code==='APIFY_PROXY_GROUP_UNAVAILABLE');
    await assert.rejects(()=>configureProxy({createProxyConfiguration:async()=>{throw new Error('Access denied for Apify Proxy group');}},settings),
        error=>error.code==='APIFY_PROXY_GROUP_UNAVAILABLE');
});
test('SDK proxy credentials are decoded once into the separate Playwright fields',async()=>{
    const settings=proxySettings({proxyAccessAuthorized:true});
    const username='groups-UNBLOCKER',password='PRIVATE:@%+ value';
    const proxy=await configureProxy({createProxyConfiguration:async options=>{
        assert.deepEqual(options,{useApifyProxy:true,groups:['UNBLOCKER']});
        return{newUrl:async(...args)=>{assert.equal(args.length,0);
            return 'http://'+encodeURIComponent(username)+':'+encodeURIComponent(password)+'@proxy.invalid:8000';}};
    }},settings);
    assert.deepEqual(proxy,{server:'http://proxy.invalid:8000',username,password});
});
test('transport errors are safely normalized without credentials',()=>{
    const d=navigationFailure('Page.goto: net::ERR_TOO_MANY_RETRIES password=PRIVATE https://user:secret@proxy.invalid');
    assert.equal(d.code,'CHROMIUM_ERR_TOO_MANY_RETRIES');assert.equal(JSON.stringify(d).includes('secret'),false);
    assert.equal(d.category,'retry-exhaustion');assert.equal(d.underlyingCause,'undetermined');
    for(const signal of ['ERR_PROXY_AUTH_REQUESTED','ERR_PROXY_AUTH_UNSUPPORTED','ERR_PROXY_AUTH_REQUESTED_WITH_NO_CONNECTION','ERR_UNEXPECTED_PROXY_AUTH']){
        const diagnosis=navigationFailure('Page.goto: net::'+signal);
        assert.equal(diagnosis.code,'PROXY_AUTH_ERROR');assert.equal(diagnosis.category,'proxy-authentication');
    }
    assert.equal(navigationFailure('net::ERR_INVALID_AUTH_CREDENTIALS').category,'authentication');
    assert.equal(navigationFailure('net::ERR_CERT_AUTHORITY_INVALID').category,'tls');
    assert.equal(navigationFailure('net::ERR_TUNNEL_CONNECTION_FAILED').category,'proxy-tunnel');
    assert.equal(navigationFailure('net::ERR_PROXY_CONNECTION_FAILED').category,'proxy-connection');
    assert.equal(classifyHttp('document',502).code,'HTTP_502');
    assert.equal(classifyHttp('document',403).status,'blocked');
    assert.equal(classifyHttp('optional',403),null);
    assert.equal(classifyHttp('document',200,true).code,'ACCESS_CHALLENGE');
});
test('normal and diagnostic budgets share process age',()=>{
    let age=20000;const b=new Budget({elapsed:()=>age,hardExit:()=>assert.fail()});
    b.configure(parseInput({url:expected.url}));assert.equal(b.remaining(b.acquisition),28000);assert.equal(b.remaining(b.total),35000);
    b.configure(parseInput({url:expected.url,diagnosticMode:true}));assert.equal(b.remaining(b.acquisition),140000);
    age=180001;assert.equal(b.remaining(b.total),0);b.stop();
});
async function browserFixture(status,{optional=false,proxyMode='direct',proxy=null,failureCode=null,documentHtml=html,bodyFailure=false}={}) {
    const page=new EventEmitter();let calls=0,contextOptions,launchOptions;
    page.route=async()=>{};page.mainFrame=()=>page;page.url=()=>expected.url;page.content=async()=>documentHtml;
    const request=()=>({isNavigationRequest:()=>true,frame:()=>page});
    page.goto=async()=>{
        calls++;
        if(failureCode){
            page.emit('requestfailed',{...request(),failure:()=>({errorText:'net::'+failureCode})});
            throw new Error('Page.goto: net::'+failureCode+' at https://user:PRIVATE@destination.invalid/');
        }
        page.emit('response',{url:()=>expected.url,headers:()=>({'content-type':'text/html','cf-ray':'synthetic-ray'}),
            status:()=>status,request,frame:()=>page,body:async()=>{
                if(bodyFailure)throw new Error('synthetic unreadable response');
                return Buffer.from(documentHtml);
            }});
        if(optional)page.emit('response',{url:()=> 'https://www.backmarket.com/reviews/v1/products/'+id+'/reviews',
            headers:()=>({'content-type':'application/json'}),status:()=>403,
            request:()=>({isNavigationRequest:()=>false}),frame:()=>page,body:async()=>Buffer.from('{}')});
        return {};
    };
    const browser={newContext:async options=>{contextOptions=options;return{newPage:async()=>page};},close:async()=>{}};
    const budget=clock();budget.configure(parseInput({url:expected.url}));
    const result=await acquire(parseInput({url:expected.url}),{budget,proxyMode,proxy,
        browserType:{launch:async options=>{launchOptions=options;return browser;}}});
    budget.stop();return{result,calls,contextOptions,launchOptions};
}
test('Unblocker retry exhaustion with no HTTP retains unknown cause and safe transport evidence',async()=>{
    const proxy={server:'http://proxy.invalid:8000',username:'groups-UNBLOCKER',password:'PRIVATE'};
    const {result,calls,launchOptions,contextOptions}=await browserFixture(null,
        {proxyMode:'unblocker',proxy,failureCode:'ERR_TOO_MANY_RETRIES'});
    const report=result.acquisition;
    assert.equal(calls,1);assert.deepEqual(launchOptions.proxy,proxy);assert.equal(contextOptions.ignoreHTTPSErrors,true);
    assert.equal(report.status,'error');assert.equal(report.error.code,'CHROMIUM_ERR_TOO_MANY_RETRIES');
    assert.equal(report.requests.length,0);assert.equal(report.browserClosed,true);
    assert.equal(report.navigationError.httpStatus,null);assert.equal(report.navigationError.documentResponsesObserved,0);
    assert.equal(report.navigationError.underlyingCause,'undetermined');assert.equal(report.navigationError.source,'page.goto');
    assert.deepEqual(report.navigationError.requestFailureSignals,['ERR_TOO_MANY_RETRIES']);
    assert.equal(report.navigationFailures[0].source,'requestfailed');
    assert.deepEqual(report.proxyTransport,{mode:'unblocker',configured:true,usernameProvided:true,passwordProvided:true,
        credentialBinding:'playwright-launch-fields'});
    assert.equal(JSON.stringify(report).includes('PRIVATE'),false);
});
test('document HTTP 407 and proxy 590 are HTTP errors, not retry exhaustion',async()=>{
    for(const [status,code] of [[407,'PROXY_AUTH_ERROR'],[590,'APIFY_PROXY_HTTP_590']]){
        const {result,calls}=await browserFixture(status,{proxyMode:'unblocker'});
        assert.equal(calls,1);assert.equal(result.acquisition.error.code,code);
        assert.equal(result.acquisition.requests[0].httpStatus,status);
        assert.equal(result.acquisition.navigationError,undefined);
    }
});
test('main document 502 is acquisition error; 403 remains blocked; only Unblocker disables TLS verification',async()=>{
    for(const status of [502,403]){
        const {result,calls,contextOptions}=await browserFixture(status);
        assert.equal(result.acquisition.error.code,'HTTP_'+status);
        assert.equal(result.acquisition.resourceErrors.length,0);assert.equal(calls,1);
        assert.equal(contextOptions.ignoreHTTPSErrors,false);
    }
    for(const proxyMode of ['direct','datacenter','residential','unblocker']){
        const {result,contextOptions}=await browserFixture(200,{proxyMode});
        const insecure=proxyMode==='unblocker';
        assert.equal(contextOptions.ignoreHTTPSErrors,insecure);
        assert.equal(result.acquisition.tlsVerified,!insecure);
    }
});
test('review 403 does not discard valid HTML and never causes another navigation',async()=>{
    const {result,calls}=await browserFixture(200,{optional:true});
    assert.equal(result.acquisition.status,'received');assert.equal(result.html,html);
    assert.equal(result.acquisition.resourceErrors[0].category,'optional');assert.equal(calls,1);
});
test('HTTP 200 challenge containing commercial marker strings is rejected in response and DOM paths',async()=>{
    const documentHtml='<html><head><title>Just a moment</title></head><body>'+id+' selectedOffer pickerGroups specifications</body></html>';
    for(const bodyFailure of [false,true]){
        const {result,calls}=await browserFixture(200,{documentHtml,bodyFailure});
        assert.equal(calls,1);assert.equal(result.acquisition.status,'blocked');
        assert.equal(result.acquisition.error.code,'ACCESS_CHALLENGE');assert.equal(result.html,'');
    }
});
test('rendered DOM fallback still validates and accepts a valid product when response body is unreadable',async()=>{
    const {result,calls}=await browserFixture(200,{bodyFailure:true});
    assert.equal(calls,1);assert.equal(result.acquisition.status,'received');
    assert.equal(result.acquisition.htmlSource,'rendered-dom');assert.equal(result.html,html);
});

test('aborting saves state, closes work and exits with 143 without a product',async()=>{
    const actor=new FakeActor();let notify;
    const began=new Promise(resolve=>{notify=resolve;});
    const work=runActor({actor,budget:clock(),acquireFn:async(_,{signal})=>{
        notify();
        await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
        return {html:'',responses:{},acquisition:{status:'aborted',requests:[],error:{code:'ABORTED'},failureStage:'navigation'}};
    }});
    await began; await actor.listeners.aborting();
    const result=await work;
    assert.equal(result.state.status,'aborted');assert.equal(result.exitCode,143);
    assert.equal(actor.records.length,0);assert.equal(actor.values.RUN_STATE.status,'aborted');
    assert.equal(actor.exits.every(e=>e.exitCode===143),true);
});
