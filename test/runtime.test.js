
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
log.setLevel(log.LEVELS.OFF);
const id = 'eda80a12-a40b-4faa-b0f6-438bea90f1e5';
const html = readFileSync(new URL('./fixtures/reference/' + id + '/commercial.html',import.meta.url),'utf8');
const expected = JSON.parse(readFileSync(new URL('./fixtures/reference/' + id + '/python-output.json',import.meta.url),'utf8'));
class FakeActor {
    constructor(input = {url:expected.url}) { this.input=input; this.values={}; this.records=[]; this.offline=[]; this.listeners={}; this.exits=[]; }
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
test('selection removed on redirect clears price and returns partial',async()=>{
    const actor=new FakeActor();
    const data=success(); data.acquisition.pageSelection={requested:{l:'12'},final:{},status:'changed_or_removed'};
    const result=await runActor({actor,budget:clock(),acquireFn:async()=>data});
    assert.equal(result.state.status,'partial'); assert.equal(actor.records[0].price,null);
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
test('transport errors are safely normalized without credentials',()=>{
    const d=navigationFailure('Page.goto: net::ERR_TOO_MANY_RETRIES password=PRIVATE https://user:secret@proxy.invalid');
    assert.equal(d.code,'CHROMIUM_ERR_TOO_MANY_RETRIES');assert.equal(JSON.stringify(d).includes('secret'),false);
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
async function browserFixture(status,{optional=false}={}) {
    const page=new EventEmitter();let calls=0,contextOptions;
    page.route=async()=>{};page.mainFrame=()=>page;page.url=()=>expected.url;page.content=async()=>html;
    const request=()=>({isNavigationRequest:()=>true,frame:()=>page});
    page.goto=async()=>{
        calls++;
        page.emit('response',{url:()=>expected.url,headers:()=>({'content-type':'text/html','cf-ray':'synthetic-ray'}),
            status:()=>status,request,frame:()=>page,body:async()=>Buffer.from(html)});
        if(optional)page.emit('response',{url:()=> 'https://www.backmarket.com/reviews/v1/products/'+id+'/reviews',
            headers:()=>({'content-type':'application/json'}),status:()=>403,
            request:()=>({isNavigationRequest:()=>false}),frame:()=>page,body:async()=>Buffer.from('{}')});
        return {};
    };
    const browser={newContext:async options=>{contextOptions=options;return{newPage:async()=>page};},close:async()=>{}};
    const budget=clock();budget.configure(parseInput({url:expected.url}));
    const result=await acquire(parseInput({url:expected.url}),{budget,browserType:{launch:async()=>browser}});
    budget.stop();return{result,calls,contextOptions};
}
test('main document 502 is acquisition error; 403 remains blocked; TLS always verified',async()=>{
    for(const status of [502,403]){
        const {result,calls,contextOptions}=await browserFixture(status);
        assert.equal(result.acquisition.error.code,'HTTP_'+status);
        assert.equal(result.acquisition.resourceErrors.length,0);assert.equal(calls,1);
        assert.equal(contextOptions.ignoreHTTPSErrors,false);
    }
});
test('review 403 does not discard valid HTML and never causes another navigation',async()=>{
    const {result,calls}=await browserFixture(200,{optional:true});
    assert.equal(result.acquisition.status,'received');assert.equal(result.html,html);
    assert.equal(result.acquisition.resourceErrors[0].category,'optional');assert.equal(calls,1);
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
