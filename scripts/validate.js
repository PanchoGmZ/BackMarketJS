
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import assert from 'node:assert/strict';
const json = path => JSON.parse(readFileSync(path,'utf8'));
for (const file of readdirSync('src').filter(f => f.endsWith('.js'))) {
    const result=spawnSync(process.execPath,['--check','src/'+file],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
}
const actor=json('.actor/actor.json');
assert.equal(actor.name,'backmarket-url-extractor-js');
assert.equal(actor.meta.generatedBy,'Codex with GPT-6.1 Sol');
const input=json('.actor/input_schema.json');
assert.equal(input.properties.proxyConfiguration.default.useApifyProxy,true);
assert.deepEqual(input.properties.proxyConfiguration.default.apifyProxyGroups,['UNBLOCKER']);
assert.equal(input.properties.diagnosticMode.default,false);
assert.equal(input.properties.disableHttp2.default,false);
const ajv=new Ajv({strict:false,allErrors:true});addFormats(ajv);
ajv.compile(input); const dataset=json('.actor/dataset_schema.json');ajv.compile(dataset.fields);
assert.equal(Object.keys(dataset.fields.properties).length,11);
for(const collection of Object.values(json('.actor/key_value_store_schema.json').collections))ajv.compile(collection.jsonSchema);
assert.equal(json('.actor/output_schema.json').properties.products.template,'{{links.apiDefaultDatasetUrl}}/items');
const pkg=json('package.json'),lock=json('package-lock.json');
for(const [name,version] of Object.entries(pkg.dependencies))assert.equal(lock.packages['node_modules/'+name].version,version);
process.stdout.write('Syntax, four JSON schemas, eleven-field contract, defaults and dependency lock: passed.\n');
