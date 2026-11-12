
import { randomUUID } from 'node:crypto';
import { ExtractionError, record } from '../shared/values.js';
export function proxySettings(input) {
    const config = input.proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['UNBLOCKER'] };
    if (!record(config)
        || Object.keys(config).some(k => !['useApifyProxy', 'apifyProxyGroups', 'apifyProxyCountry', 'proxyUrls'].includes(k)))
        throw new ExtractionError('INVALID_PROXY_CONFIGURATION', 'proxy-setup');
    if (config.proxyUrls !== undefined && (!Array.isArray(config.proxyUrls) || config.proxyUrls.length))
        throw new ExtractionError('CUSTOM_PROXIES_NOT_SUPPORTED', 'proxy-setup');
    const enabled = config.useApifyProxy ?? false, groups = config.apifyProxyGroups ?? [], country = config.apifyProxyCountry ?? null;
    if (typeof enabled !== 'boolean' || !Array.isArray(groups) || groups.length > 10 || new Set(groups).size !== groups.length
        || groups.some(g => typeof g !== 'string' || !/^[A-Za-z0-9._~]{1,64}$/.test(g))
        || (country !== null && (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country))))
        throw new ExtractionError('INVALID_PROXY_CONFIGURATION', 'proxy-setup');
    if (enabled && (!groups.length || groups.some(g => g.toUpperCase() === 'GOOGLE_SERP')))
        throw new ExtractionError('INVALID_PROXY_GROUP', 'proxy-setup');
    for (const special of ['RESIDENTIAL', 'UNBLOCKER'])
        if (enabled && groups.some(g => g.toUpperCase() === special) && (groups.length !== 1 || groups[0] !== special))
            throw new ExtractionError('MIXED_OR_INVALID_PROXY_GROUPS', 'proxy-setup');
    return { enabled, groups: enabled ? groups : [], country: enabled ? country : null,
        mode: !enabled ? 'direct' : groups.includes('UNBLOCKER') ? 'unblocker' : groups.includes('RESIDENTIAL') ? 'residential' : 'datacenter',
        sessionMode: !enabled ? null : groups.includes('UNBLOCKER') ? 'not-supported' : 'single-run' };
}
export async function configureProxy(actor, settings) {
    if (!settings.enabled) return null;
    try {
        const config = await actor.createProxyConfiguration({ useApifyProxy: true, groups: settings.groups,
            ...(settings.country ? { countryCode: settings.country } : {}) });
        if (!config) throw new ExtractionError('APIFY_PROXY_GROUP_UNAVAILABLE', 'proxy-setup');
        // One generated proxy URL per job. UNBLOCKER never receives a session.
        const value = settings.mode === 'unblocker' ? await config.newUrl() : await config.newUrl(randomUUID().replaceAll('-', ''));
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
        return { server: url.origin, username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    } catch (error) {
        if (error instanceof ExtractionError) throw error;
        const message = typeof error?.message === 'string' ? error.message : '';
        if (/(?:you\s+(?:do\s+not|don't|dont)\s+have\s+access|access\s+denied|not\s+authorized|not\s+permitted|forbidden).{0,100}(?:apify\s+)?proxy|(?:apify\s+)?proxy.{0,100}(?:not\s+available|unavailable|not\s+enabled|access\s+denied|forbidden)/i.test(message))
            throw new ExtractionError('APIFY_PROXY_GROUP_UNAVAILABLE', 'proxy-setup');
        throw new ExtractionError('PROXY_CONFIGURATION_ERROR', 'proxy-setup');
    }
}
