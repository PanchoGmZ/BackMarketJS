
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const env = { ...process.env };
// A local test must not inherit Cloud IDs, tokens, proxy credentials or account services.
for (const key of Object.keys(env)) if (/^(APIFY_|ACTOR_|CRAWLEE_)/.test(key)) delete env[key];
fs.mkdirSync('.tmp', { recursive: true });
const root = fs.mkdtempSync(path.resolve('.tmp/sdk-offline-'));
env.CRAWLEE_STORAGE_DIR = root;
const folder = 'test/fixtures/reference/eda80a12-a40b-4faa-b0f6-438bea90f1e5';
const run = spawnSync(process.execPath, ['src/main.js', '--input', folder + '/python-output-input.json',
    '--offline', folder + '/commercial.html'], { env, encoding: 'utf8', timeout: 20000 });
fs.writeFileSync(path.join(root, 'console.txt'), run.stdout + '\n' + run.stderr);
assert.equal(run.status, 1, 'Offline must be partial; inspect console.txt in the isolated test directory.');
const state = JSON.parse(fs.readFileSync(path.join(root, 'key_value_stores/default/RUN_STATE.json'), 'utf8'));
assert.equal(state.status, 'partial'); assert.equal(state.extractionPerformed, false); assert.equal(state.savedResults, 1);
const dir = path.join(root, 'datasets/offline-validation');
const files = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)); assert.equal(files.length, 1);
const actual = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
assert.deepEqual(actual, JSON.parse(fs.readFileSync(folder + '/python-output.json', 'utf8')));
process.stdout.write(JSON.stringify({ sdkOffline: 'passed', status: state.status, extractionPerformed: false,
    records: 1, fields: Object.keys(actual).length, diagnosticDirectory: path.relative(process.cwd(), root) }) + '\n');
