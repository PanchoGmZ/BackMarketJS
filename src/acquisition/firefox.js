import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { firefox } from 'playwright';
import { acquireOnce } from './firefox_page.js';
import { event } from '../shared/diagnostics.js';
import { ExtractionError } from '../shared/values.js';

function makeAuthenticatedProxyUrl(proxy) {
    if (!proxy || typeof proxy.server !== 'string' || typeof proxy.username !== 'string' || !proxy.username
        || typeof proxy.password !== 'string' || !proxy.password || proxy.username.includes(':'))
        throw new ExtractionError('PROXY_BRIDGE_INIT_ERROR', 'proxy-bridge');
    try {
        const url = new URL(proxy.server);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
            || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
            throw new Error('invalid proxy endpoint');
        // The SDK has already decoded these fields. Encode them once for the
        // authenticated upstream URL consumed by proxy-chain.
        url.username = encodeURIComponent(proxy.username);
        url.password = encodeURIComponent(proxy.password);
        return url.href;
    } catch {
        throw new ExtractionError('PROXY_BRIDGE_INIT_ERROR', 'proxy-bridge');
    }
}

function localProxyServer(localUrl) {
    try {
        const url = new URL(localUrl);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
            || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
            throw new Error('proxy-chain returned a non-loopback proxy');
        return { server: url.origin, port: Number(url.port) };
    } catch {
        throw new ExtractionError('PROXY_BRIDGE_INIT_ERROR', 'proxy-bridge');
    }
}

// Firefox has one navigation and shares the existing parser. proxy-chain keeps
// Apify's upstream credentials out of Firefox by exposing only a loopback URL.
export async function acquire(input, options = {}) {
    const {
        proxy = null,
        proxyMode = 'direct',
        browserType = firefox,
        anonymizeProxyFn = anonymizeProxy,
        closeAnonymizedProxyFn = closeAnonymizedProxy,
        ...acquisitionOptions
    } = options;
    let localProxyUrl = null;
    let browserProxy = proxy;
    let proxyBridge = false;
    let bridgeSetupSeconds = 0;
    let result = null;

    try {
        if (proxy) {
            let upstreamProxyUrl;
            const bridgeStarted = performance.now();
            try {
                upstreamProxyUrl = makeAuthenticatedProxyUrl(proxy);
                localProxyUrl = await anonymizeProxyFn({ url: upstreamProxyUrl });
                const local = localProxyServer(localProxyUrl);
                browserProxy = { server: `http://127.0.0.1:${local.port}` };
                proxyBridge = true;
                bridgeSetupSeconds = (performance.now() - bridgeStarted) / 1000;
                event('PROXY_BRIDGE', { status: 'ready', listenHost: '127.0.0.1', port: local.port, httpsConnect: true });
            } catch (error) {
                event('PROXY_BRIDGE', { status: 'error', category: 'initialization', code: 'PROXY_BRIDGE_INIT_ERROR' }, 'warning');
                if (error instanceof ExtractionError && error.code === 'PROXY_BRIDGE_INIT_ERROR') throw error;
                throw new ExtractionError('PROXY_BRIDGE_INIT_ERROR', 'proxy-bridge');
            } finally {
                upstreamProxyUrl = undefined;
            }
        } else if (proxyMode !== 'direct') {
            event('PROXY_BRIDGE', { status: 'error', category: 'initialization', code: 'PROXY_BRIDGE_INIT_ERROR' }, 'warning');
            throw new ExtractionError('PROXY_BRIDGE_INIT_ERROR', 'proxy-bridge');
        }

        result = await acquireOnce(input, {
            ...acquisitionOptions,
            proxy: browserProxy,
            proxyMode,
            browserType,
            proxyBridge,
        });
        result.acquisition.proxyBridge = proxyBridge
            ? { status: 'ready', listenHost: '127.0.0.1', setupSeconds: bridgeSetupSeconds }
            : { status: 'not-used' };
        return result;
    } finally {
        if (localProxyUrl) {
            const bridgeCloseStarted = performance.now();
            let bridgeCloseStatus = 'closed';
            try {
                await closeAnonymizedProxyFn(localProxyUrl, true);
                event('PROXY_BRIDGE', { status: 'closed', forced: true,
                    seconds: (performance.now() - bridgeCloseStarted) / 1000 });
            } catch {
                bridgeCloseStatus = 'close-error';
                // Cleanup diagnostics must not mask the acquisition result or
                // expose an error message that could contain the upstream URL.
                event('PROXY_BRIDGE', { status: 'close-error', code: 'PROXY_BRIDGE_CLOSE_ERROR' }, 'warning');
            }
            if (result?.acquisition) {
                const closeSeconds = (performance.now() - bridgeCloseStarted) / 1000;
                result.acquisition.proxyBridge.closeStatus = bridgeCloseStatus;
                result.acquisition.proxyBridge.closeSeconds = closeSeconds;
                if (result.acquisition.timings) {
                    result.acquisition.timings.proxyBridgeSetupSeconds = bridgeSetupSeconds;
                    result.acquisition.timings.proxyBridgeCloseSeconds = closeSeconds;
                }
            }
        }
    }
}
