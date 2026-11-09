
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { parseInput } from '../src/input.js';
import { extractHtml } from '../src/extract.js';
import { assertProduct } from '../src/contract.js';
const args = process.argv.slice(2);
const get = name => args[args.indexOf(name) + 1];
if (!args.includes('--source') || !args.includes('--expected')) throw new Error('Usage: npm run validate:reference -- --source HTML --expected PYTHON_JSON');
const expectedRaw = JSON.parse(await readFile(resolve(get('--expected')), 'utf8'));
const expected = Array.isArray(expectedRaw) ? expectedRaw[0] : expectedRaw;
const input = parseInput({ url: expected.url });
const result = extractHtml(await readFile(resolve(get('--source')), 'utf8'), input);
assertProduct(result.output);
assert.deepStrictEqual(result.output, expected);
await mkdir('output', { recursive: true });
await writeFile('output/reference-comparison.json', JSON.stringify({ status: 'equivalent', productId: input.productId,
    fields: 11, price: result.output.price, currency: result.metadata.currency, missing: result.missing,
    extractionPerformed: false, source: 'saved-commercial-html' }, null, 2) + '\n');
process.stdout.write('Exact equality for all eleven fields; offline comparison only.\n');
