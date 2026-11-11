import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { parseInput, selectionState } from '../src/platform/input.js';
import { proxySettings } from '../src/acquisition/proxy.js';
import { acquire } from '../src/acquisition/firefox.js';
import { localChallengeSeconds } from '../src/acquisition/firefox_page.js';
import { acquireOnce } from '../src/acquisition/firefox_page.js';
import { runActor } from '../src/platform/actor.js';
import { extractHtml, transform } from '../src/product/extraction.js';
import { fields, assertProduct } from '../src/product/contract.js';
import { roundWeightKg } from '../src/product/weight.js';

const uuid = '55767eb7-da9b-45ad-978f-596c1d4ed74b';
const url = `https://www.backmarket.com/en-us/p/ipad-blue/${uuid}?l=12&offerType=standard&closestPickerConfig=false&pickerClicked=true#scroll=false`;
test('espera local predeterminada y ajuste anterior configurable', () => {
    assert.equal(localChallengeSeconds({}),10);
    assert.equal(localChallengeSeconds({BACKMARKET_LOCAL_CHALLENGE_SECONDS:'30'}),30);
    assert.equal(localChallengeSeconds({BACKMARKET_LOCAL_CHALLENGE_SECONDS:'999'}),10);
});
test('URLs con UUID, picker y serie conservan su selección', () => {
    const input = parseInput({ url });
    assert.equal(input.url, url); assert.equal(input.productId, uuid);
    assert.equal(selectionState(url, url).status, 'preserved');
    assert.equal(parseInput({url:'https://www.backmarket.com/en-us/p/ipad-air-2020-a14-series'}).productId, null);
});
test('UNBLOCKER requiere autorización y selecciona su grupo', () => {
    assert.throws(() => proxySettings(parseInput({url})), /PROXY_AUTHORIZATION_REQUIRED/);
    assert.equal(proxySettings(parseInput({url,proxyAccessAuthorized:true})).mode, 'unblocker');
});
test('precio y condiciones de la misma selección y once campos', () => {
    const input = parseInput({url});
    const item = (label, amount, selected=false) => ({label,productId:uuid,slug:'ipad-blue',price:{amount,currency:'USD'},available:true,selected,parameters:{offerType:'standard'}});
    const raw={product:{productId:uuid,titles:{raw:'iPad'},images:[]},pickers:{selectedOffer:{productId:uuid,price:{amount:'249.99',currency:'USD'}},pickerGroups:[{id:'grades',items:[item('Fair','249.99',true),item('Good','291.00'),item('Excellent','268.00')]}]},specifications:{specifications:[]}};
    const {output,metadata}=transform(input,raw);
    assert.equal(output.price,'249.99'); assert.equal(metadata.priceVerification.status,'verified');
    assert.deepEqual(output.variations[0].variants.map(v=>v.price),['249.99','291.00','268.00']);
    assert.deepEqual(Object.keys(output),fields); assertProduct(output);
    raw.pickers.selectedOffer.productId='ec6b3e5e-676e-40f9-91a6-1c9d8537209b';
    assert.equal(transform(input,raw).output.price,null);
    assert.equal(roundWeightKg(0.17009713875).value,0.17);
});
test('sin proxy local, una navegación y cierre en error', async () => {
    let closed=0, navigations=0, bridge=0, launch;
    const page={on(){},route:async()=>{},mainFrame(){return {};},goto:async()=>{navigations++;throw Error('offline');}};
    const browserType={launch:async opts=>{launch=opts;return {newContext:async()=>({newPage:async()=>page}),close:async()=>{closed++}};}};
    const result=await acquire(parseInput({url}),{localDirect:true,browserType,budget:{acquisition:30000,remaining:()=>30000},anonymizeProxyFn:async()=>{bridge++;}});
    assert.equal(launch.headless,false); assert.equal(launch.proxy,undefined);
    assert.equal(bridge,0); assert.equal(navigations,1); assert.equal(closed,1); assert.equal(result.acquisition.status,'error');
});
test('desafío local 403 espera el límite y cierra sin HTML', async () => {
    const previous=process.env.BACKMARKET_LOCAL_CHALLENGE_SECONDS;
    process.env.BACKMARKET_LOCAL_CHALLENGE_SECONDS='1';
    let current=url, closed=0, handler;
    const challenge='https://www.backmarket.com/testchallengepage', page=new EventEmitter();
    page.url=()=>current;page.mainFrame=()=>page;page.isClosed=()=>false;page.route=async(_,fn)=>{handler=fn};
    const req=u=>({url:()=>u,isNavigationRequest:()=>true,frame:()=>page,resourceType:()=> 'document'});
    const res=(u,status,headers)=>({url:()=>u,headers:()=>headers,request:()=>req(u),frame:()=>page,status:()=>status,statusText:()=>''});
    page.goto=async()=>{page.emit('response',res(url,301,{location:challenge}));await handler({request:()=>req(challenge),continue:async()=>{},abort:async()=>{throw Error('unexpected abort')}});current=challenge;page.emit('response',res(challenge,403,{'content-type':'text/html'}));page.emit('domcontentloaded');};
    const browserType={launch:async()=>({newContext:async()=>({newPage:async()=>page}),close:async()=>{closed++;}})};
    try {
        const before=performance.now();
        const result=await acquireOnce(parseInput({url}),{localDirect:true,browserType,budget:{acquisition:30000,remaining:()=>30000}});
        assert.equal(result.acquisition.error.code,'ACCESS_CHALLENGE');assert.equal(result.html,'');
        assert.equal(closed,1);assert.ok(performance.now()-before>=900);
    } finally { if(previous===undefined) delete process.env.BACKMARKET_LOCAL_CHALLENGE_SECONDS; else process.env.BACKMARKET_LOCAL_CHALLENGE_SECONDS=previous; }
});
test('Actor Cloud y local seleccionan rutas distintas sin escribir Dataset en error', async () => {
    for (const home of [true,false]) {
        let proxyCalls=0, options, writes=0;
        const actor={isAtHome:()=>home,init:async()=>{},on:()=>{},setValue:async()=>{},getInput:async()=>({url,proxyAccessAuthorized:true}),exit:async()=>{},pushData:async()=>{writes++;}};
        const result=await runActor({actor,proxyFn:async()=>{proxyCalls++;return {};},acquireFn:async(_input,o)=>{options=o;return {acquisition:{status:'error',error:{code:'OFFLINE_TEST'},requests:[]}};}});
        assert.equal(proxyCalls,home?1:0); assert.equal(options.proxyMode,home?'unblocker':'direct');
        assert.equal(writes,0); assert.equal(result.state.status,'error');
    }
});
test('HTML real guardado conserva contrato cuando se proporciona', {skip:!process.env.AUDIT_HTML}, async () => {
    const html=await readFile(process.env.AUDIT_HTML,'utf8');
    const result=extractHtml(html,parseInput({url:'https://www.backmarket.com/en-us/p/ipad-air-2020-a14-series'}));
    assertProduct(result.output); assert.equal(Object.keys(result.output).length,11);
});
test('Actor procesa HTML real y guarda un registro verificado', {skip:!process.env.AUDIT_HTML}, async () => {
    const html=await readFile(process.env.AUDIT_HTML,'utf8');
    const productUrl='https://www.backmarket.com/en-us/p/ipad-air-2020-a14-series';
    let output, writes=0;
    const actor={isAtHome:()=>false,init:async()=>{},on:()=>{},setValue:async()=>{},getInput:async()=>({url:productUrl}),exit:async()=>{},pushData:async value=>{output=value;writes++;}};
    const result=await runActor({actor,acquireFn:async()=>({html,acquisition:{status:'received',finalUrl:productUrl,redirects:[],requests:[{category:'document',httpStatus:200}]}})});
    assert.equal(result.exitCode,0); assert.ok(['success','partial'].includes(result.state.status));
    assert.equal(writes,1); assertProduct(output); assert.equal(Object.keys(output).length,11);
});
