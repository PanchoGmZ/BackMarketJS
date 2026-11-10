
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { log } from 'apify';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { runActor } from '../src/run.js';
import { Budget } from '../src/budget.js';
import { proxySettings, configureProxy } from '../src/proxy.js';
import { parseInput } from '../src/input.js';
import { acquire } from '../src/browser.js';
import { acquire as acquireFirefox } from '../src/firefox.js';
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
    constructor(input = {url:expected.url,proxyConfiguration:{useApifyProxy:false}}) { this.input={transport:'chromium',...input}; this.values={}; this.records=[]; this.offline=[]; this.listeners={}; this.exits=[]; }
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
test('short alias resolves before the unchanged Actor identity guard and saves one aggregate',async()=>{
    const url=expected.url.replace('/'+id,''),actor=new FakeActor({url,proxyConfiguration:{useApifyProxy:false}});
    const result=await runActor({actor,budget:clock(),acquireFn:async()=>({html,responses:{},
        acquisition:{status:'received',requests:[],navigationCount:1,finalUrl:expected.url}})});
    assert.equal(result.exitCode,0);assert.equal(result.state.status,'success');
    assert.deepEqual(actor.records,[{...expected,url}]);assert.equal(result.state.productDocument.uuidMatches,true);
});
test('unresolved short URL is a structured error with no Dataset product',async()=>{
    const url=expected.url.replace('/'+id,''),actor=new FakeActor({url,proxyConfiguration:{useApifyProxy:false}});
    const result=await runActor({actor,budget:clock(),acquireFn:async()=>success()});
    assert.equal(result.exitCode,1);assert.equal(result.state.status,'error');
    assert.equal(result.state.error.code,'SHORT_URL_IDENTITY_UNVERIFIED');assert.equal(actor.records.length,0);
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
async function browserFixture(status,{optional=false,proxyMode='direct',proxy=null,failureCode=null,documentHtml=html,bodyFailure=false,disableHttp2,productUrl=expected.url}={}) {
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
    const input=parseInput({url:productUrl,...(disableHttp2 === undefined ? {} : {disableHttp2})});
    const budget=clock();budget.configure(input);
    const result=await acquire(input,{budget,proxyMode,proxy,sleepImpl:async()=>{},
        browserType:{launch:async options=>{launchOptions=options;return browser;}}});
    budget.stop();return{result,calls,contextOptions,launchOptions};
}
function browserSequence(outcomes,{productUrl=expected.url,documentHtml=html}={}) {
    const stats={launches:0,navigations:0,closes:0,active:false,urls:[],gotoOptions:[],launchOptions:[],contextOptions:[],trace:[],routeHandler:null,contentCalls:0};
    const browserType={launch:async options=>{
        assert.equal(stats.active,false,'a new browser must not launch before the previous one closes');
        const attempt=stats.launches++;
        assert.ok(attempt<outcomes.length,'unexpected browser launch');
        stats.active=true;stats.launchOptions.push(structuredClone(options));stats.trace.push('launch:'+attempt);
        const page=new EventEmitter();
        page.route=async(_pattern,handler)=>{stats.routeHandler=handler;};page.mainFrame=()=>page;page.url=()=>productUrl;page.content=async()=>{stats.contentCalls++;return documentHtml;};
        const request=()=>({isNavigationRequest:()=>true,frame:()=>page});
        page.goto=async (url,options)=>{
            stats.navigations++;stats.urls.push(url);stats.trace.push('goto:'+attempt);
            stats.gotoOptions.push(structuredClone(options));
            assert.equal(url,productUrl);
            const outcome=outcomes[attempt];
            if(typeof outcome==='string'){
                page.emit('requestfailed',{...request(),failure:()=>({errorText:'net::'+outcome})});
                throw new Error('Page.goto: net::'+outcome);
            }
            if(typeof outcome==='object'&&outcome.pending)return new Promise(()=>{});
            const status=typeof outcome==='number'?outcome:outcome.status;
            const statusText=typeof outcome==='object'&&outcome.statusText ? outcome.statusText
                : {504:'ETIMEDOUT',590:'UPSTREAM502',592:'UPSTREAM1000',593:'ENOTFOUND',
                    594:'ECONNREFUSED',595:'ECONNRESET',596:'EPIPE',597:'UPSTREAM407',599:'Upstream Closed Early'}[status] ?? 'OK';
            page.emit('response',{url:()=>productUrl,headers:()=>({'content-type':'text/html','cf-ray':'synthetic-ray'}),
                status:()=>status,statusText:()=>statusText,request,frame:()=>page,body:async()=>Buffer.from(documentHtml)});
            if(typeof outcome==='object'&&outcome.failureCode){
                page.emit('requestfailed',{...request(),failure:()=>({errorText:'net::'+outcome.failureCode})});
                throw new Error('Page.goto: net::'+outcome.failureCode);
            }
            return {};
        };
        const browser={newContext:async options=>{
            stats.contextOptions.push(structuredClone(options));
            return {newPage:async()=>page};
        },close:async()=>{assert.equal(stats.active,true);stats.active=false;stats.closes++;stats.trace.push('close:'+attempt);}};
        return browser;
    }};
    return {browserType,stats};
}
async function acquireSequence(outcomes,{productUrl=expected.url,remainingMs=48000,remainingState=null,proxy=null,proxyMode='direct',sleepImpl=async()=>{},documentHtml=html}={}) {
    const input=parseInput({url:productUrl});
    const remaining=remainingState ?? {ms:remainingMs};
    const budget={acquisition:remainingMs,remaining:()=>remaining.ms,stop(){}};
    const {browserType,stats}=browserSequence(outcomes,{productUrl,documentHtml});
    const result=await acquire(input,{budget,proxy,proxyMode,browserType,sleepImpl});
    return {result,stats,input,remaining};
}
test('proxy-chain anonymizeProxy returns an unauthenticated loopback proxy and closes it',async()=>{
    const upstream='http://groups-UNBLOCKER:offline%40credential@proxy.invalid:8000';
    const localUrl=await anonymizeProxy({url:upstream});
    const local=new URL(localUrl);
    assert.equal(local.protocol,'http:');assert.equal(local.hostname,'127.0.0.1');
    assert.ok(Number(local.port)>0);assert.equal(local.username,'');assert.equal(local.password,'');
    assert.equal(await closeAnonymizedProxy(localUrl,true),true);
    assert.equal(await closeAnonymizedProxy(localUrl,true),false);
});
test('Firefox proxy-chain transport shares Nuxt parser and preserves the 1688 output without exposing upstream credentials to Firefox',async()=>{
    const proxy={server:'http://proxy.invalid:8000',username:'groups-UNBLOCKER',password:'PRIVATE:@%+ value'};
    const actor=new FakeActor({url:expected.url,transport:'firefox',
        proxyConfiguration:{useApifyProxy:true,apifyProxyGroups:['UNBLOCKER']},proxyAccessAuthorized:true});
    const {browserType,stats}=browserSequence([200],{productUrl:expected.url});
    let upstreamUrlSeen, closedUrl, closeForced;
    const result=await runActor({actor,budget:clock(),proxyFn:async()=>proxy,
        firefoxAcquireFn:(input,context)=>acquireFirefox(input,{...context,browserType,
            anonymizeProxyFn:async ({url})=>{upstreamUrlSeen=new URL(url);return 'http://127.0.0.1:43127';},
            closeAnonymizedProxyFn:async (url,force)=>{closedUrl=url;closeForced=force;return true;}})});
    const report=result.state.acquisition;
    assert.equal(result.state.transport,'firefox');assert.equal(result.state.status,'success');assert.equal(result.exitCode,0);
    assert.equal(report.transport,'firefox');assert.equal(report.status,'received');assert.equal(report.attemptCount,1);
    assert.equal(result.state.proxy.connected,true);
    assert.equal(report.navigationCount,1);assert.equal(report.requests[0].httpStatus,200);
    assert.equal(report.tlsVerified,false);assert.equal(report.http2Disabled,false);
    assert.equal(report.timings.navigationWaitUntil,'domcontentloaded');
    assert.deepEqual(stats.urls,[expected.url]);assert.equal(stats.navigations,1);
    assert.equal(stats.closes,1);assert.equal(stats.active,false);
    assert.deepEqual(stats.launchOptions[0].proxy,{server:'http://127.0.0.1:43127'});
    assert.equal(upstreamUrlSeen.protocol,'http:');assert.equal(upstreamUrlSeen.hostname,'proxy.invalid');assert.equal(upstreamUrlSeen.port,'8000');
    assert.equal(decodeURIComponent(upstreamUrlSeen.username),proxy.username);
    assert.equal(decodeURIComponent(upstreamUrlSeen.password),proxy.password);
    assert.equal(closedUrl,'http://127.0.0.1:43127');assert.equal(closeForced,true);
    assert.deepEqual(report.proxyTransport,{mode:'unblocker',configured:true,usernameProvided:false,passwordProvided:false,
        credentialBinding:'proxy-chain-loopback'});
    assert.equal(report.proxyBridge.status,'ready');assert.equal(report.proxyBridge.listenHost,'127.0.0.1');
    assert.equal(Object.hasOwn(stats.launchOptions[0],'args'),false);
    assert.equal(Object.hasOwn(stats.launchOptions[0],'channel'),false);
    assert.equal(stats.contextOptions[0].ignoreHTTPSErrors,true);
    assert.ok(stats.launchOptions[0].timeout>0);assert.ok(stats.gotoOptions[0].timeout>0);
    assert.deepEqual(stats.trace,['launch:0','goto:0','close:0']);
    assert.deepEqual(actor.records,[expected]);assert.equal(Object.keys(actor.records[0]).length,11);
    assert.equal(JSON.stringify(result.state).includes('PRIVATE'),false);
});
test('Firefox fast mode commits, reads the complete document, keeps parser output, and skips DOMContentLoaded',async()=>{
    const input=parseInput({url:expected.url,transport:'firefox',firefoxFastMode:true});
    const {browserType,stats}=browserSequence([200]);
    const result=await acquireFirefox(input,{budget:{acquisition:48000,remaining:()=>48000},browserType});
    assert.equal(result.acquisition.status,'received');
    assert.equal(result.acquisition.fastMode,true);
    assert.equal(stats.gotoOptions[0].waitUntil,'commit');
    assert.equal(stats.navigations,1);assert.equal(stats.closes,1);
    assert.equal(result.html,html);assert.equal(result.acquisition.htmlSource,'navigation-response');
    assert.equal(result.acquisition.timings.domContentLoadedSeconds,null);
    assert.ok(result.acquisition.timings.documentHeadersSeconds>=0);
    assert.ok(result.acquisition.timings.documentBodyReadSeconds>=0);
    assert.ok(result.acquisition.timings.navigationWaitSeconds>=0);
    const parsed=extractHtml(result.html,input,result.responses);
    assert.deepEqual(parsed.output,expected);assert.equal(Object.keys(parsed.output).length,11);
});
test('Firefox fast mode blocks only image, font, and media resources; scripts and API requests continue',async()=>{
    const input=parseInput({url:expected.url,transport:'firefox',firefoxFastMode:true});
    const {browserType,stats}=browserSequence([200]);
    const result=await acquireFirefox(input,{budget:{acquisition:48000,remaining:()=>48000},browserType});
    const outcomes=[];
    for (const type of ['image','font','media','script','xhr','fetch']) {
        const outcome={type,action:null};
        await stats.routeHandler({request:()=>({url:()=>`https://www.backmarket.com/resource/${type}`,resourceType:()=>type,isNavigationRequest:()=>false}),
            abort:async()=>{outcome.action='abort';},continue:async()=>{outcome.action='continue';}});
        outcomes.push(outcome);
    }
    assert.deepEqual(outcomes,[
        {type:'image',action:'abort'},{type:'font',action:'abort'},{type:'media',action:'abort'},
        {type:'script',action:'continue'},{type:'xhr',action:'continue'},{type:'fetch',action:'continue'},
    ]);
    assert.deepEqual(result.acquisition.fastModeBlockedResources,{image:1,font:1,media:1});
});
test('Firefox maps proxy-chain upstream 407 to authentication rejection and always closes browser then bridge',async()=>{
    const input=parseInput({url:expected.url,transport:'firefox'});
    const proxy={server:'http://proxy.invalid:8000',username:'groups-UNBLOCKER',password:'PRIVATE'};
    const {browserType,stats}=browserSequence([597]);
    let bridgeClosed=false;
    const result=await acquireFirefox(input,{budget:{acquisition:48000,remaining:()=>48000},proxy,proxyMode:'unblocker',browserType,
        anonymizeProxyFn:async()=> 'http://127.0.0.1:43128',
        closeAnonymizedProxyFn:async (_url,force)=>{assert.equal(force,true);assert.equal(stats.active,false);bridgeClosed=true;}});
    assert.equal(result.acquisition.status,'error');
    assert.equal(result.acquisition.error.code,'PROXY_UPSTREAM_AUTH_REJECTED');
    assert.equal(result.acquisition.failureStage,'proxy-bridge');
    assert.equal(result.acquisition.requests[0].httpStatus,597);
    assert.equal(result.acquisition.requests[0].proxyBridgeFailure,'upstream-auth-rejected');
    assert.equal(stats.launchOptions[0].proxy.server,'http://127.0.0.1:43128');
    assert.equal(stats.closes,1);assert.equal(bridgeClosed,true);
});
test('Firefox only classifies proxy-chain status 597 with an upstream 401 or 407 as authentication rejection',async()=>{
    const input=parseInput({url:expected.url,transport:'firefox'});
    const {browserType}=browserSequence([{status:597,statusText:'Destination Custom Status'}]);
    const result=await acquireFirefox(input,{budget:{acquisition:48000,remaining:()=>48000},
        proxy:{server:'http://proxy.invalid:8000',username:'groups-UNBLOCKER',password:'PRIVATE'},proxyMode:'unblocker',browserType,
        anonymizeProxyFn:async()=> 'http://127.0.0.1:43129',closeAnonymizedProxyFn:async()=>true});
    assert.equal(result.acquisition.error.code,'APIFY_PROXY_HTTP_597');
    assert.equal(result.acquisition.requests[0].proxyBridgeFailure,undefined);
    const {browserType:authBrowser}=browserSequence([{status:597,statusText:'UPSTREAM401'}]);
    const auth=await acquireFirefox(input,{budget:{acquisition:48000,remaining:()=>48000},
        proxy:{server:'http://proxy.invalid:8000',username:'groups-UNBLOCKER',password:'PRIVATE'},proxyMode:'unblocker',browserType:authBrowser,
        anonymizeProxyFn:async()=> 'http://127.0.0.1:43130',closeAnonymizedProxyFn:async()=>true});
    assert.equal(auth.acquisition.error.code,'PROXY_UPSTREAM_AUTH_REJECTED');
});
test('Firefox maps an upstream proxy authentication navigation failure from its browser signal',async()=>{
    const input=parseInput({url:expected.url,transport:'firefox'});
    const {browserType,stats}=browserSequence(['NS_ERROR_PROXY_AUTHENTICATION_FAILED']);
    const result=await acquireFirefox(input,{budget:{acquisition:48000,remaining:()=>48000},
        proxy:{server:'http://proxy.invalid:8000',username:'groups-UNBLOCKER',password:'PRIVATE'},proxyMode:'unblocker',browserType,
        anonymizeProxyFn:async()=> 'http://127.0.0.1:43131',closeAnonymizedProxyFn:async()=>true});
    assert.equal(result.acquisition.error.code,'PROXY_UPSTREAM_AUTH_REJECTED');
    assert.equal(result.acquisition.failureStage,'proxy-bridge');
    assert.equal(stats.closes,1);
});
test('Firefox distinguishes proxy-chain upstream HTTP and connection failures from destination responses',async()=>{
    const input=parseInput({url:expected.url,transport:'firefox'});
    const proxy={server:'http://proxy.invalid:8000',username:'groups-UNBLOCKER',password:'PRIVATE'};
    for (const [outcome,code,category] of [
        [{status:590,statusText:'UPSTREAM403'},'PROXY_UPSTREAM_HTTP_ERROR','upstream-response'],
        [{status:594,statusText:'ECONNREFUSED'},'PROXY_UPSTREAM_CONNECTION_ERROR','upstream-connection'],
    ]) {
        const {browserType}=browserSequence([outcome]);
        const result=await acquireFirefox(input,{budget:{acquisition:48000,remaining:()=>48000},proxy,proxyMode:'unblocker',browserType,
            anonymizeProxyFn:async()=> 'http://127.0.0.1:43132',closeAnonymizedProxyFn:async()=>true});
        assert.equal(result.acquisition.error.code,code);
        assert.equal(result.acquisition.requests[0].proxyBridgeFailure,category);
        assert.equal(result.acquisition.failureStage,'proxy-bridge');
    }
});
test('Firefox bridge initialization errors are classified and do not launch a browser',async()=>{
    const input=parseInput({url:expected.url,transport:'firefox'});
    const {browserType,stats}=browserSequence([200]);
    await assert.rejects(()=>acquireFirefox(input,{budget:{acquisition:48000,remaining:()=>48000},
        proxy:{server:'http://proxy.invalid:8000',username:'groups-UNBLOCKER',password:'PRIVATE'},proxyMode:'unblocker',browserType,
        anonymizeProxyFn:async()=>{throw new Error('must not leak this upstream secret');}}),
    error=>error.code==='PROXY_BRIDGE_INIT_ERROR');
    assert.equal(stats.launches,0);assert.equal(stats.navigations,0);
});
test('Firefox applies the shared maximum HTML body size before returning a document',async()=>{
    const input=parseInput({url:expected.url,transport:'firefox'},
        {BACKMARKET_MAX_HTML_BYTES:'1024',BACKMARKET_MAX_MEMORY_MB:'1024'});
    const {browserType,stats}=browserSequence([200],{productUrl:expected.url,documentHtml:html+' '.repeat(2048)});
    const result=await acquireFirefox(input,{budget:{acquisition:48000,remaining:()=>48000},browserType});
    assert.equal(result.acquisition.status,'partial');assert.equal(result.acquisition.error.code,'RESPONSE_TOO_LARGE');
    assert.equal(result.acquisition.navigationCount,1);assert.equal(stats.navigations,1);assert.equal(stats.closes,1);
});
test('Firefox navigation timeout remains bounded by the shared acquisition budget and closes the browser',async()=>{
    const input=parseInput({url:expected.url,transport:'firefox'});
    const {browserType,stats}=browserSequence([{pending:true}]);
    const result=await acquireFirefox(input,{budget:{acquisition:3000,remaining:()=>3000},browserType});
    assert.equal(result.acquisition.status,'partial');assert.equal(result.acquisition.error.code,'TIMEOUT');
    assert.equal(result.acquisition.navigationCount,1);assert.equal(stats.navigations,1);assert.equal(stats.closes,1);
    assert.equal(stats.gotoOptions[0].timeout,1000);assert.equal(stats.active,false);
});
test('Firefox has no retry or engine fallback when its single navigation fails',async()=>{
    const {browserType,stats}=browserSequence(['NS_ERROR_NET_RESET','NS_ERROR_NET_RESET']);
    const input=parseInput({url:expected.url,transport:'firefox'});
    const budget={acquisition:48000,remaining:()=>48000};
    const result=await acquireFirefox(input,{budget,browserType});
    assert.equal(result.acquisition.status,'error');assert.equal(result.acquisition.attemptCount,1);
    assert.equal(result.acquisition.navigationCount,1);assert.equal(result.acquisition.error.code,'NETWORK_ERROR');
    assert.equal(stats.launches,1);assert.equal(stats.navigations,1);assert.equal(stats.closes,1);
    for(const status of [403,429]){
        const denied=browserSequence([status,200]);
        const responseResult=await acquireFirefox(input,{budget,browserType:denied.browserType});
        assert.equal(responseResult.acquisition.navigationCount,1);assert.equal(responseResult.acquisition.error.code,'HTTP_'+status);
        assert.equal(denied.stats.launches,1);assert.equal(denied.stats.navigations,1);assert.equal(denied.stats.closes,1);
    }
});
test('Firefox classifies proxy authentication, TLS, DNS, network and timeout signals safely',()=>{
    const cases=[
        ['NS_ERROR_PROXY_AUTHENTICATION_FAILED','PROXY_AUTH_ERROR','proxy-authentication'],
        ['SEC_ERROR_UNKNOWN_ISSUER','TLS_ERROR','tls'],
        ['NS_ERROR_UNKNOWN_HOST','DNS_ERROR','dns'],
        ['NS_ERROR_NET_RESET','NETWORK_ERROR','network'],
        ['NS_ERROR_NET_TIMEOUT','TIMEOUT','timeout'],
    ];
    for(const [signal,code,category] of cases){
        const result=navigationFailure('page.goto: '+signal);
        assert.equal(result.code,code);assert.equal(result.category,category);assert.deepEqual(result.signals,[signal]);
    }
});
test('short URL receives the current document without inventing endpoint IDs or another navigation',async()=>{
    const {result,calls}=await browserFixture(200,{productUrl:expected.url.replace('/'+id,'')});
    assert.equal(calls,1);assert.equal(result.acquisition.status,'received');
    assert.equal(result.acquisition.htmlSource,'navigation-response');assert.deepEqual(result.responses,{});
});
test('HTTP/2 experiment changes only the requested launch argument across connection modes',async()=>{
    assert.equal(parseInput({url:expected.url}).disableHttp2,false);
    for(const value of ['true','false',1,null])
        assert.throws(()=>parseInput({url:expected.url,disableHttp2:value}),error=>error.code==='INVALID_INPUT');
    for(const proxyMode of ['direct','residential','unblocker']){
        const proxy=proxyMode==='direct'?null:{server:'http://proxy.invalid:8000',username:'synthetic-user',password:'PRIVATE'};
        const control=await browserFixture(200,{proxyMode,proxy});
        const experiment=await browserFixture(200,{proxyMode,proxy,disableHttp2:true});
        const {args,...otherOptions}=experiment.launchOptions;
        assert.deepEqual(args,['--disable-http2']);assert.deepEqual(otherOptions,control.launchOptions);
        assert.equal(control.result.acquisition.http2Disabled,false);assert.equal(experiment.result.acquisition.http2Disabled,true);
        assert.deepEqual(experiment.contextOptions,control.contextOptions);
        assert.equal(experiment.calls,1);assert.equal(control.calls,1);
        assert.equal(experiment.result.acquisition.status,'received');assert.equal(experiment.result.html,control.result.html);
    }
    const explicitFalse=await browserFixture(200,{disableHttp2:false});
    assert.equal(Object.hasOwn(explicitFalse.launchOptions,'args'),false);
    assert.equal(explicitFalse.result.acquisition.http2Disabled,false);
});
test('Unblocker retry exhaustion with no HTTP retains unknown cause and safe transport evidence',async()=>{
    const proxy={server:'http://proxy.invalid:8000',username:'groups-UNBLOCKER',password:'PRIVATE'};
    const {result,stats}=await acquireSequence(['ERR_TOO_MANY_RETRIES','ERR_TOO_MANY_RETRIES'],{proxyMode:'unblocker',proxy});
    const report=result.acquisition;
    assert.equal(stats.navigations,2);assert.equal(stats.launches,2);assert.equal(stats.closes,2);assert.equal(stats.active,false);
    assert.deepEqual(stats.launchOptions[0].proxy,proxy);assert.deepEqual(stats.launchOptions[1],stats.launchOptions[0]);
    assert.equal(stats.contextOptions[0].ignoreHTTPSErrors,true);assert.equal(stats.contextOptions[1].ignoreHTTPSErrors,true);
    assert.equal(report.status,'error');assert.equal(report.error.code,'CHROMIUM_ERR_TOO_MANY_RETRIES');
    assert.equal(report.requests.length,0);assert.equal(report.browserClosed,true);assert.equal(report.navigationCount,2);
    assert.equal(report.attemptCount,2);assert.equal(report.attempts[0].code,'CHROMIUM_ERR_TOO_MANY_RETRIES');
    assert.equal(report.recovery.attempted,true);assert.equal(report.recovery.acquisitionReceived,false);
    assert.equal(report.navigationError.httpStatus,null);assert.equal(report.navigationError.documentResponsesObserved,0);
    assert.equal(report.navigationError.underlyingCause,'undetermined');assert.equal(report.navigationError.source,'page.goto');
    assert.deepEqual(report.navigationError.requestFailureSignals,['ERR_TOO_MANY_RETRIES']);
    assert.equal(report.navigationFailures.length,2);assert.equal(report.navigationFailures[0].source,'requestfailed');
    assert.deepEqual(report.proxyTransport,{mode:'unblocker',configured:true,usernameProvided:true,passwordProvided:true,
        credentialBinding:'playwright-launch-fields'});
    assert.equal(JSON.stringify(report).includes('PRIVATE'),false);
});
test('transient retry exhaustion recovers with a new browser and preserves URL, proxy and commercial output',async()=>{
    const productUrl=expected.url+'?l=12&offerType=selected-offer';
    const proxy={server:'http://proxy.invalid:8000',username:'groups-UNBLOCKER',password:'PRIVATE'};
    const sleeps=[];
    const {result,stats}=await acquireSequence(['ERR_TOO_MANY_RETRIES',200],{productUrl,proxy,proxyMode:'unblocker',
        sleepImpl:async ms=>sleeps.push(ms)});
    const report=result.acquisition;
    assert.equal(result.html,html);assert.deepEqual(stats.urls,[productUrl,productUrl]);
    assert.deepEqual(sleeps,[2500]);assert.deepEqual(stats.trace,['launch:0','goto:0','close:0','launch:1','goto:1','close:1']);
    assert.equal(stats.launches,2);assert.equal(stats.navigations,2);assert.equal(stats.closes,2);assert.equal(stats.active,false);
    assert.deepEqual(stats.launchOptions[1],stats.launchOptions[0]);assert.equal(stats.launchOptions[1].proxy.username,proxy.username);
    assert.equal(report.status,'received');assert.equal(report.navigationCount,2);assert.equal(report.attemptCount,2);
    assert.equal(report.attempts[0].code,'CHROMIUM_ERR_TOO_MANY_RETRIES');assert.equal(report.attempts[1].status,'received');
    assert.equal(report.recovery.attempted,true);assert.equal(report.recovery.acquisitionReceived,true);
});
test('successful first Chromium acquisition performs one navigation and no recovery wait',async()=>{
    const sleeps=[];const {result,stats}=await acquireSequence([200],{sleepImpl:async ms=>sleeps.push(ms)});
    assert.equal(result.acquisition.status,'received');assert.equal(result.acquisition.navigationCount,1);
    assert.equal(result.acquisition.attemptCount,1);assert.equal(result.acquisition.recovery.attempted,false);
    assert.equal(stats.launches,1);assert.equal(stats.navigations,1);assert.equal(stats.closes,1);assert.deepEqual(sleeps,[]);
});
test('HTTP 403 and 429 never trigger Chromium recovery',async()=>{
    for(const status of [403,429]){
        const {result,stats}=await acquireSequence([status,200]);
        assert.equal(result.acquisition.error.code,'HTTP_'+status);
        assert.equal(result.acquisition.status,status===403?'blocked':'error');
        assert.equal(result.acquisition.navigationCount,1);assert.equal(result.acquisition.recovery.attempted,false);
        assert.equal(stats.launches,1);assert.equal(stats.navigations,1);assert.equal(stats.closes,1);
    }
});
test('a document response observed before retry exhaustion prevents recovery',async()=>{
    const {result,stats}=await acquireSequence([{status:204,failureCode:'ERR_TOO_MANY_RETRIES'},200]);
    assert.equal(result.acquisition.error.code,'CHROMIUM_ERR_TOO_MANY_RETRIES');
    assert.equal(result.acquisition.navigationError.documentResponsesObserved,1);
    assert.equal(result.acquisition.navigationError.httpStatus,204);
    assert.equal(result.acquisition.recovery.attempted,false);assert.equal(result.acquisition.navigationCount,1);
    assert.equal(stats.launches,1);assert.equal(stats.navigations,1);assert.equal(stats.closes,1);
});
test('if the second attempt gets HTTP 403, its real blocked result remains final',async()=>{
    const {result,stats}=await acquireSequence(['ERR_TOO_MANY_RETRIES',403]);
    assert.equal(result.acquisition.status,'blocked');assert.equal(result.acquisition.error.code,'HTTP_403');
    assert.deepEqual(result.acquisition.attempts.map(attempt=>attempt.code),['CHROMIUM_ERR_TOO_MANY_RETRIES','HTTP_403']);
    assert.equal(result.acquisition.recovery.finalCode,'HTTP_403');
    assert.equal(result.acquisition.navigationCount,2);assert.equal(stats.launches,2);assert.equal(stats.closes,2);
});
test('explicit proxy-auth, TLS and challenge failures never trigger recovery',async()=>{
    for(const code of ['ERR_PROXY_AUTH_REQUESTED','ERR_CERT_AUTHORITY_INVALID','ERR_TUNNEL_CONNECTION_FAILED']){
        const {result,stats}=await acquireSequence([code,'ERR_TOO_MANY_RETRIES'],{proxyMode:'unblocker',
            proxy:{server:'http://proxy.invalid:8000',username:'groups-UNBLOCKER',password:'PRIVATE'}});
        assert.equal(stats.launches,1);assert.equal(stats.navigations,1);assert.equal(stats.closes,1);
        assert.equal(result.acquisition.recovery.attempted,false);assert.equal(result.acquisition.navigationCount,1);
    }
    const challenged='<html><head><title>Just a moment</title></head><body>blocked</body></html>';
    const {result,stats}=await acquireSequence([200,200],{documentHtml:challenged});
    assert.equal(result.acquisition.status,'blocked');assert.equal(result.acquisition.error.code,'ACCESS_CHALLENGE');
    assert.equal(stats.launches,1);assert.equal(stats.navigations,1);assert.equal(result.acquisition.recovery.attempted,false);
});
test('recovery is omitted when the remaining acquisition window is insufficient',async()=>{
    const sleeps=[];const {result,stats}=await acquireSequence(['ERR_TOO_MANY_RETRIES','ERR_TOO_MANY_RETRIES'],
        {remainingMs:14000,sleepImpl:async ms=>sleeps.push(ms)});
    assert.equal(result.acquisition.error.code,'CHROMIUM_ERR_TOO_MANY_RETRIES');
    assert.equal(result.acquisition.recovery.attempted,false);assert.equal(result.acquisition.recovery.skippedReason,'insufficient-time');
    assert.equal(result.acquisition.navigationCount,1);assert.equal(stats.launches,1);assert.equal(stats.navigations,1);
    assert.equal(stats.closes,1);assert.deepEqual(sleeps,[]);
});
test('recovery rechecks the shared budget after waiting instead of resetting it',async()=>{
    const remaining={ms:15000};
    const run=await acquireSequence(['ERR_TOO_MANY_RETRIES','ERR_TOO_MANY_RETRIES'],{remainingMs:15000,remainingState:remaining,
        sleepImpl:async()=>{remaining.ms=11999;}});
    assert.equal(run.result.acquisition.recovery.attempted,false);
    assert.equal(run.result.acquisition.recovery.skippedReason,'insufficient-time-after-wait');
    assert.equal(run.stats.launches,1);assert.equal(run.stats.navigations,1);assert.equal(run.stats.closes,1);
});
test('recovered live acquisition preserves the eleven-field 1688 Dataset contract',async()=>{
    const actor=new FakeActor({url:expected.url,proxyConfiguration:{useApifyProxy:false}});
    const {browserType,stats}=browserSequence(['ERR_TOO_MANY_RETRIES',200],{productUrl:expected.url});
    const result=await runActor({actor,budget:clock(),acquireFn:(input,context)=>acquire(input,{...context,browserType,sleepImpl:async()=>{}})});
    assert.equal(result.state.status,'success');assert.equal(result.exitCode,0);
    assert.equal(result.state.acquisition.recovery.attempted,true);
    assert.equal(result.state.acquisition.recovery.acquisitionReceived,true);
    assert.equal(result.state.acquisition.navigationCount,2);
    assert.equal(stats.launches,2);assert.equal(stats.navigations,2);assert.equal(stats.closes,2);assert.equal(stats.active,false);
    assert.deepEqual(actor.records,[expected]);assert.equal(Object.keys(actor.records[0]).length,11);
    assert.deepEqual(actor.records[0],expected);assert.equal(result.state.savedResults,1);
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
