
import { Actor } from 'apify';
import { randomUUID } from 'node:crypto';
import { parseInput } from './input.js';
import { proxySettings, configureProxy } from './proxy.js';
import { extractHtml } from './extract.js';
import { assertProduct } from './contract.js';
import { acquire } from './browser.js';
import { Budget, bounded } from './budget.js';
import { event, navigationFailure } from './diagnostics.js';
import { ExtractionError } from './values.js';

export async function runActor({ actor = Actor, budget = new Budget(), rawInput, offlineHtml,
    acquireFn = acquire, proxyFn = configureProxy } = {}) {
    const state = { source: 'backmarket', runtime: 'javascript', extractionMethod: 'nuxt',
        runId: randomUUID(), startedAt: new Date().toISOString(), status: 'running',
        stage: 'actor-init', savedResults: 0, extractionPerformed: false, timings: {}, error: null };
    let metadata = {}, exitCode = 0, initialized = false, input, retainedFailure;
    const controller = new AbortController();
    let workTimer, completed, abortCode = 'RUN_TIME_LIMIT';
    const done = new Promise(resolve => { completed = resolve; });
    const start = performance.now();
    const timed = async (key, fn) => {
        const before = performance.now();
        try { return await fn(); } finally { state.timings[key] = (performance.now() - before) / 1000; event('TIEMPO', { stage: key, seconds: state.timings[key] }); }
    };
    try {
        await bounded(actor.init(), budget.remaining(budget.total), null, 'actor-init'); initialized = true;
        state.timings.initialization = budget.elapsed() / 1000;
        event('INICIO', { runtime: 'Node.js', method: 'nuxt', navigationLimit: 1 });
        actor.on('aborting', async () => {
            abortCode = 'ABORTED'; controller.abort(); state.status = 'aborted'; state.error = { code: 'ABORTED', stage: state.stage };
            try {
                await bounded(actor.setValue('RUN_STATE', state), 1000, null, 'abort-persist');
                await bounded(done, 3000, null, 'abort-close');
            } catch {}
            await actor.exit({ exitCode: 143, timeoutSecs: 1 });
        });
        state.stage = 'input';
        if (rawInput !== undefined) await actor.setValue(process.env.ACTOR_INPUT_KEY || 'INPUT', rawInput);
        input = parseInput(await bounded(actor.getInput(), budget.remaining(), null, 'input'));
        budget.configure(input);
        state.diagnosticMode = input.diagnosticMode;
        state.executionMode = offlineHtml === undefined ? 'live' : 'offline';
        state.timeBudget = { processSeconds: budget.total / 1000, acquisitionSeconds: budget.acquisition / 1000, workSeconds: budget.work / 1000 };
        workTimer = setTimeout(() => controller.abort(), budget.remaining());
        const settings = proxySettings(input);
        state.proxy = { ...settings, status: settings.enabled ? 'pending' : 'disabled', connected: null, documentRequestSucceeded: null };
        await actor.setValue('RUN_STATE', state);
        event('LIMITES', { ...state.timeBudget, diagnosticMode: input.diagnosticMode });
        let html, responses = {};
        if (offlineHtml === undefined) {
            state.stage = 'proxy-setup';
            const proxy = await timed('proxySetup', () => bounded(proxyFn(actor, settings), Math.min(10000, budget.remaining()), controller.signal, 'proxy-setup'));
            if (settings.enabled) state.proxy.status = 'configured';
            event('PROXY', { enabled: settings.enabled, mode: settings.mode, groups: settings.groups,
                country: settings.country, status: state.proxy.status, connected: null });
            state.stage = 'acquisition';
            const result = await timed('acquisition', () => acquireFn(input, { proxy, proxyMode: settings.mode, budget, signal: controller.signal }));
            html = result.html; responses = result.responses; state.acquisition = result.acquisition;
            const document = state.acquisition.requests?.filter(r => r.category === 'document').at(-1);
            state.proxy.connected = document ? document.httpStatus !== 407 : null;
            state.proxy.documentRequestSucceeded = Boolean(document?.httpStatus === 200 && state.acquisition.status === 'received');
            if (state.acquisition.status !== 'received') {
                const error = state.acquisition.error ?? { code: 'ACQUISITION_ERROR' };
                if (!html || !state.acquisition.candidateBeforeAccessFailure)
                    throw new ExtractionError(error.code, state.acquisition.failureStage ?? 'acquisition', state.acquisition.status);
                retainedFailure = { status: state.acquisition.status, error };
            }
            state.extractionPerformed = true;
            input._documentUrl = state.acquisition.finalUrl;
        } else {
            html = offlineHtml;
            state.acquisition = { status: 'offline', source: 'saved-commercial-html', navigationCount: 0, directApiRequests: 0 };
            state.proxy.status = 'not-used-offline';
        }
        state.stage = 'transformation';
        const result = await timed('extraction', async () => extractHtml(html, input, responses));
        const { output, missing, commercial } = result; metadata = result.metadata;
        const identity = commercial.product?.productId?.toLowerCase() === input.productId;
        state.productDocument = { verified: Boolean(identity && output.title), uuidMatches: identity, titleFound: Boolean(output.title) };
        event('DOCUMENTO_PRODUCTO', state.productDocument);
        if (!identity || !output.title) throw new ExtractionError('PRODUCT_IDENTITY_UNVERIFIED', 'transformation', 'partial');
        const pageSelection = state.acquisition.pageSelection;
        if (pageSelection) {
            metadata.pageSelection = pageSelection;
            if (pageSelection.status === 'changed_or_removed') {
                output.price = null;
                Object.assign(metadata.priceVerification, { status: 'unverified', reason: 'PAGE_SELECTION_CHANGED_BY_REDIRECT' });
                if (!missing.includes('price')) missing.push('price');
                missing.push('pageSelection');
                metadata.sourceDiagnostics.foundFields = metadata.sourceDiagnostics.foundFields.filter(k => k !== 'price');
            }
        }
        assertProduct(output);
        if (controller.signal.aborted) throw new ExtractionError('RUN_TIME_LIMIT', state.stage, 'error');
        if (retainedFailure && !(output.price !== null && output.images?.length && metadata.priceVerification.status === 'verified'))
            throw new ExtractionError(retainedFailure.error.code, state.acquisition.failureStage ?? 'acquisition', retainedFailure.status);
        state.status = retainedFailure?.status ?? (offlineHtml === undefined && !missing.length ? 'success' : 'partial');
        state.error = retainedFailure?.error ?? null; state.missingFields = missing;
        exitCode = state.status === 'success' ? 0 : 1;
        metadata.executionMode = state.executionMode; metadata.extractionPerformed = state.extractionPerformed; metadata.status = state.status;
        event('PRECIO_VERIFICADO', metadata.priceVerification);
        event('PESO', { valueKg: metadata.weightNormalization.valueKg, source: metadata.weightNormalization.source,
            reason: metadata.weightNormalization.reason, kind: 'physical_product', shippingWeightKg: null });
        event('CAMPOS_ENCONTRADOS', { fields: metadata.sourceDiagnostics.foundFields });
        event('DATOS_FALTANTES', { fields: missing });
        state.stage = 'storage';
        await timed('datasetSave', async () => {
            if (offlineHtml === undefined) await bounded(actor.pushData(output), budget.remaining(), controller.signal, 'dataset-save');
            else {
                const dataset = await actor.openDataset('offline-validation');
                await bounded(dataset.pushData(output), budget.remaining(), controller.signal, 'dataset-save');
            }
        });
        state.savedResults = 1;
        state.counts = { images: output.images?.length ?? 0, characteristics: output.characteristics?.length ?? 0,
            groups: output.variations?.length ?? 0, options: output.variations?.reduce((n,g) => n + g.variants.length,0) ?? 0 };
        event('GUARDADO', { dataset: offlineHtml === undefined ? 'default' : 'offline-validation', records: 1, fields: 11 });
        state.stage = 'finished';
    } catch (error) {
        const diagnosis = error instanceof ExtractionError ? { code: error.code, stage: error.stage }
            : state.stage === 'transformation' ? { code: ['PRODUCT_ID_MISMATCH', 'INVALID_REFERENCE1688_CONTRACT'].includes(error?.message)
                ? error.message : 'NUXT_EXTRACTION_ERROR', stage: state.stage }
            : state.stage === 'storage' ? { code: 'PERSISTENCE_ERROR', stage: state.stage } : navigationFailure(error, state.stage);
        state.status = controller.signal.aborted ? abortCode === 'ABORTED' ? 'aborted' : 'error'
            : error instanceof ExtractionError ? error.status : 'error';
        state.error = { code: controller.signal.aborted ? abortCode : diagnosis.code, stage: diagnosis.stage };
        exitCode = state.status === 'aborted' ? 143 : 1;
        event('FALLO', state.error, 'error');
    } finally {
        clearTimeout(workTimer);
        state.finishedAt = new Date().toISOString(); state.elapsedSeconds = budget.elapsed() / 1000;
        state.timings.totalWork = (performance.now() - start) / 1000; state.logicalExitCode = exitCode;
        metadata.status = state.status; metadata.executionMode = state.executionMode ?? null;
        metadata.extractionPerformed = state.extractionPerformed;
        if (initialized) {
            try {
                await bounded(actor.setValue('PRODUCT_METADATA', metadata), Math.max(1, budget.remaining(budget.total) - 1000), null, 'metadata-save');
                await bounded(actor.setValue('RUN_STATE', state), Math.max(1, budget.remaining(budget.total) - 1000), null, 'state-save');
            } catch { event('DIAGNOSTICO', { code: 'PERSISTENCE_FAILED' }, 'warning'); exitCode = 1; }
        }
        event('FIN', { status: state.status, savedResults: state.savedResults, seconds: state.elapsedSeconds, code: state.error?.code ?? null });
        completed();
        try {
            if (initialized) await bounded(actor.exit({ exit: false, exitCode, timeoutSecs: 1 }), Math.max(1, budget.remaining(budget.total)), null, 'sdk-close');
            budget.stop();
        } catch { exitCode = 1; /* Keep the hard watchdog active if SDK shutdown stalls. */ }
    }
    return { state, metadata, exitCode };
}
