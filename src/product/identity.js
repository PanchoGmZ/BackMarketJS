import { load } from 'cheerio';
import { productUrlIdentity } from '../platform/input.js';
import { UUID_RE, ExtractionError, record } from '../shared/values.js';

// Only for short URLs. Page identity must be explicit; unique recommendations
// or an arbitrary UUID found in a Nuxt cache are not evidence of page identity.
export function resolveShortIdentity(html, input) {
    const requested = productUrlIdentity(input.url), candidates = new Map();
    let final;
    try { final = productUrlIdentity(input._documentUrl ?? input.url); }
    catch { throw new ExtractionError('SHORT_URL_IDENTITY_UNVERIFIED', 'transformation'); }
    const slugs = new Set([requested.slug, final.slug]);
    function add(id, source) {
        if (typeof id !== 'string' || !UUID_RE.test(id)) return;
        const normalized = id.toLowerCase(), sources = candidates.get(normalized) ?? new Set();
        sources.add(source); candidates.set(normalized, sources);
    }
    function pageLink(value) {
        if (typeof value !== 'string' || !value.trim()) return null;
        try {
            const url = new URL(value, input._documentUrl ?? input.url);
            url.hash = ''; // JSON-LD @id may identify a node on the same page.
            const link = productUrlIdentity(url.href);
            return slugs.has(link.slug) ? link : null;
        } catch { return null; }
    }
    if (final.productId) add(final.productId, 'final-url');
    const $ = load(html);
    $('link[rel]').each((_, element) => {
        const node = $(element);
        if (!(node.attr('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical')) return;
        const link = pageLink(node.attr('href'));
        if (link?.productId) add(link.productId, 'canonical');
    });
    $('script[type="application/ld+json"]').each((_, element) => {
        let root;
        try { root = JSON.parse($(element).html() ?? ''); } catch { return; }
        const queue = Array.isArray(root) ? [...root] : [root];
        if (queue.length > 1000) throw new ExtractionError('SHORT_URL_IDENTITY_UNVERIFIED', 'transformation');
        for (let i = 0; i < queue.length; i++) {
            const node = queue[i];
            if (!record(node)) continue;
            if (Array.isArray(node['@graph'])) {
                if (queue.length + node['@graph'].length > 1000)
                    throw new ExtractionError('SHORT_URL_IDENTITY_UNVERIFIED', 'transformation');
                queue.push(...node['@graph']);
            }
            const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
            if (!types.includes('Product')) continue;
            const links = [node.url, node['@id']].map(pageLink).filter(Boolean);
            if (!links.length) continue;
            for (const link of links) if (link.productId) add(link.productId, 'json-ld-product');
            if (links.some(link => !link.productId)) add(node.productID, 'json-ld-product');
        }
    });
    if (candidates.size !== 1) throw new ExtractionError(candidates.size
        ? 'SHORT_URL_IDENTITY_AMBIGUOUS' : 'SHORT_URL_IDENTITY_UNVERIFIED', 'transformation');
    const [productId, sources] = candidates.entries().next().value;
    return { productId, sources: [...sources] };
}

export function verifyShortOffer(result, identity) {
    const { commercial, metadata, output } = result, id = identity.productId;
    const pickers = commercial.pickers, offer = pickers?.selectedOffer;
    const boundToSelection = offer?.productId?.toLowerCase() === id
        || pickers?.pickerGroups?.some(group => group.items.some(item =>
            item.selected === true && item.productId?.toLowerCase() === id));
    if (commercial.product?.productId?.toLowerCase() !== id || !output.title || !boundToSelection
        || output.price === null || metadata.priceVerification.status !== 'verified')
        throw new ExtractionError('SHORT_URL_SELECTED_OFFER_UNVERIFIED', 'transformation');
}
