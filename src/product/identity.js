import { load } from 'cheerio';
import { productUrlIdentity } from '../platform/input.js';
import { UUID_RE, ExtractionError, decimalEqual, record } from '../shared/values.js';

function identityError(code, diagnostics) {
    throw new ExtractionError(code, 'transformation', 'error', { identityResolution: diagnostics });
}

function emptyDiagnostics(input, reason) {
    let requestedSlug = null;
    try { requestedSlug = productUrlIdentity(input.url).slug; } catch {}
    return {
        pageKind: requestedSlug?.toLowerCase().endsWith('-series') ? 'series' : 'short-product',
        seriesDetected: Boolean(requestedSlug?.toLowerCase().endsWith('-series')),
        selectedProductFound: false,
        selectedProductUuidFound: false,
        selectedOfferFound: false,
        selectedOfferUuidFound: false,
        priceVerified: false,
        evidenceSources: [],
        pageProductUuidFound: false,
        finalUrlProductUuidFound: false,
        finalUrlSlugMatchesRequested: false,
        redirectFromRequestedVerified: false,
        canonicalLinkFound: false,
        canonicalPageLinkCount: 0,
        nuxtPageStateFound: false,
        pagePickerGroupCount: 0,
        candidateProductIds: [],
        reason,
    };
}

// Short URLs are resolved only from page-linked identity evidence. For a series
// page, a UUID is accepted only when the page's own Nuxt state marks it as the
// selected product/offer. A UUID elsewhere in the cache is never sufficient.
export function resolveShortIdentity(html, input, document = null, roots = []) {
    let requested;
    try { requested = productUrlIdentity(input.url); }
    catch { identityError('SHORT_URL_IDENTITY_UNVERIFIED', emptyDiagnostics(input, 'REQUESTED_URL_IDENTITY_UNAVAILABLE')); }
    let final = requested;
    try { final = productUrlIdentity(input._documentUrl ?? input.url); } catch {}
    const finalUrlSlugMatchesRequested = final.slug.toLowerCase() === requested.slug.toLowerCase();
    const redirectEntries = Array.isArray(input._redirects) ? input._redirects : [];
    const redirectFromRequested = redirectEntries.some(entry => {
        if (!entry || !Number.isInteger(entry.httpStatus) || entry.httpStatus < 300 || entry.httpStatus >= 400) return false;
        try { return productUrlIdentity(entry.sourceUrl).slug.toLowerCase() === requested.slug.toLowerCase(); } catch { return false; }
    });
    const redirectReachesFinal = redirectEntries.some(entry => {
        if (!entry || !Number.isInteger(entry.httpStatus) || entry.httpStatus < 300 || entry.httpStatus >= 400) return false;
        try {
            const target = productUrlIdentity(entry.targetUrl);
            return target.slug.toLowerCase() === final.slug.toLowerCase()
                && (!final.productId || target.productId === final.productId);
        } catch { return false; }
    });
    const redirectFromRequestedVerified = !finalUrlSlugMatchesRequested && redirectFromRequested && redirectReachesFinal;
    const slugs = new Set([requested.slug.toLowerCase(),
        ...(finalUrlSlugMatchesRequested || redirectFromRequestedVerified ? [final.slug.toLowerCase()] : [])]);
    const candidates = new Map();
    let selectedProductFound = false, selectedOfferFound = false, pagePickerGroups = 0;
    let nuxtPageStateFound = false, pageProductUuidFound = false, pagePickerStateLinked = false;
    const sources = new Set();
    function add(id, source, kind = null) {
        if (typeof id !== 'string' || !UUID_RE.test(id)) return;
        const normalized = id.toLowerCase(), entry = candidates.get(normalized) ?? new Set();
        entry.add(source); candidates.set(normalized, entry); sources.add(source);
        if (kind === 'product') selectedProductFound = true;
        if (kind === 'offer') selectedOfferFound = true;
    }
    function pageLink(value) {
        if (typeof value !== 'string' || !value.trim()) return null;
        try {
            const url = new URL(value, input._documentUrl ?? input.url);
            url.hash = ''; // JSON-LD @id may identify a node on the same page.
            const link = productUrlIdentity(url.href);
            return slugs.has(link.slug.toLowerCase()) ? link : null;
        } catch { return null; }
    }
    const $ = document ?? load(html);
    const canonicalLinks = [];
    let canonicalLinkFound = false;
    $('link[rel]').each((_, element) => {
        const node = $(element);
        if (!(node.attr('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical')) return;
        canonicalLinkFound = true;
        let link = null;
        try { link = productUrlIdentity(new URL(node.attr('href'), input._documentUrl ?? input.url).href); } catch {}
        const pageLinked = link && slugs.has(link.slug.toLowerCase());
        canonicalLinks.push({ validProductUrl: Boolean(link), linkedToRequestedPage: Boolean(pageLinked),
            containsProductUuid: Boolean(link?.productId) });
        if (pageLinked && link.productId) add(link.productId, 'canonical-page-url');
    });
    if (final.productId && (finalUrlSlugMatchesRequested || redirectFromRequestedVerified))
        add(final.productId, redirectFromRequestedVerified ? 'verified-final-redirect-url' : 'final-page-url');

    // Preserve explicit JSON-LD identity only when its product URL belongs to
    // this page; unrelated structured products are not candidates.
    $('script[type="application/ld+json"]').each((_, element) => {
        let root;
        try { root = JSON.parse($(element).html() ?? ''); } catch { return; }
        const queue = Array.isArray(root) ? [...root] : [root];
        if (queue.length > 1000) identityError('SHORT_URL_IDENTITY_GRAPH_LIMIT', emptyDiagnostics(input, 'JSONLD_NODE_LIMIT'));
        for (let i = 0; i < queue.length; i++) {
            const node = queue[i];
            if (!record(node)) continue;
            if (Array.isArray(node['@graph'])) {
                if (queue.length + node['@graph'].length > 1000)
                    identityError('SHORT_URL_IDENTITY_GRAPH_LIMIT', emptyDiagnostics(input, 'JSONLD_NODE_LIMIT'));
                queue.push(...node['@graph']);
            }
            const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
            if (!types.includes('Product')) continue;
            const links = [node.url, node['@id']].map(pageLink).filter(Boolean);
            if (!links.length) continue;
            for (const link of links) if (link.productId) add(link.productId, 'json-ld-page-product');
            if (links.some(link => !link.productId)) add(node.productID, 'json-ld-page-product');
        }
    });

    const visited = new WeakMap(); let count = 0;
    function walk(node, pageBound = false, depth = 0) {
        if (!node || typeof node !== 'object' || depth > 80) return;
        const states = visited.get(node) ?? new Set();
        if (states.has(pageBound)) return;
        states.add(pageBound); visited.set(node, states);
        if (++count > 50_000)
            identityError('SHORT_URL_IDENTITY_GRAPH_LIMIT', emptyDiagnostics(input, 'NUXT_NODE_LIMIT'));
        if (Array.isArray(node)) {
            for (const child of node) walk(child, pageBound, depth + 1);
            return;
        }
        const linkedHere = (typeof node.slug === 'string' && slugs.has(node.slug.toLowerCase()))
            || [node.url, node.canonicalUrl, node.productUrl, node.path, node.route?.path,
                node.route?.fullPath, node.canonical?.href].some(value => pageLink(value));
        const bound = pageBound || linkedHere;
        if (linkedHere) nuxtPageStateFound = true;
        if (bound && Array.isArray(node.pickerGroups)) pagePickerGroups = Math.max(pagePickerGroups, node.pickerGroups.length);

        // Back Market's series payload keeps MasterPP, pp-product and
        // pp-pickers in sibling entries under Nuxt data. Link only the pickers
        // store when the same data object contains an entry for this page slug.
        const pageDataContainer = Object.values(node).some(child => record(child)
            && typeof child.slug === 'string' && slugs.has(child.slug.toLowerCase()));

        const productRecord = record(node.titles) && Array.isArray(node.images);
        if (linkedHere && typeof node.productId === 'string') {
            pageProductUuidFound ||= UUID_RE.test(node.productId);
            add(node.productId, 'nuxt-page-linked-product');
        }
        if (linkedHere && productRecord) add(node.productId, 'nuxt-page-product');
        if (bound && node.selected === true && (node.productId || node.parameters || node.label || node.slug)) {
            selectedProductFound = true; sources.add('nuxt-selected-picker-option');
            add(node.productId, 'nuxt-selected-picker-option', 'product');
        }
        if (bound && productRecord && (node.selected === true || node.active === true))
            add(node.productId, 'nuxt-selected-page-product', 'product');
        for (const key of ['selectedProduct', 'activeProduct', 'selectedConfiguration']) {
            const selected = node[key];
            if (bound && record(selected)) {
                selectedProductFound = true; sources.add('nuxt-' + key.toLowerCase());
                add(selected.productId, 'nuxt-' + key.toLowerCase(), 'product');
            }
        }
        for (const key of ['selectedProductId', 'activeProductId']) {
            if (bound && typeof node[key] === 'string') {
                selectedProductFound = true; sources.add('nuxt-' + key.toLowerCase());
                add(node[key], 'nuxt-' + key.toLowerCase(), 'product');
            }
        }
        if (bound && record(node.selectedOffer)) {
            const selectedOffer = node.selectedOffer;
            selectedOfferFound = true; sources.add('nuxt-selected-offer');
            if (selectedOffer.productId) add(selectedOffer.productId, 'nuxt-selected-offer', 'offer');
        }
        for (const [key, child] of Object.entries(node)) {
            const siblingPickers = pageDataContainer && /^pp-pickers(?::|-|$)/i.test(key);
            if (siblingPickers) pagePickerStateLinked = true;
            walk(child, bound || siblingPickers, depth + 1);
        }
    }
    for (const root of roots) walk(root);

    const candidateProductIds = [...candidates.entries()].slice(0, 10).map(([productId, evidence]) => ({
        productId, evidence: [...evidence].slice(0, 6),
    }));
    const seriesDetected = requested.slug.toLowerCase().endsWith('-series') || pagePickerGroups > 1;
    const diagnostics = {
        pageKind: seriesDetected ? 'series' : 'short-product',
        seriesDetected,
        selectedProductFound,
        selectedProductUuidFound: [...candidates.values()].some(value => [...value].some(source => source.startsWith('nuxt-selected') || source.startsWith('nuxt-active'))),
        selectedOfferFound,
        selectedOfferUuidFound: [...candidates.values()].some(value => value.has('nuxt-selected-offer')),
        priceVerified: false,
        evidenceSources: [...sources].slice(0, 12),
        pageProductUuidFound,
        pagePickerStateLinked,
        canonicalPageLinks: canonicalLinks.slice(0, 5),
        canonicalLinkFound,
        canonicalPageLinkCount: canonicalLinks.filter(link => link.linkedToRequestedPage).length,
        finalUrlProductUuidFound: Boolean(final.productId),
        finalUrlSlugMatchesRequested,
        redirectFromRequestedVerified,
        nuxtPageStateFound,
        pagePickerGroupCount: pagePickerGroups,
        candidateCount: candidates.size,
        candidateProductIds,
        reason: candidates.size > 1 ? 'MULTIPLE_PAGE_LINKED_PRODUCT_UUIDS'
            : candidates.size === 0 ? 'NO_PAGE_LINKED_PRODUCT_UUID' : 'IDENTITY_CANDIDATE_FOUND',
    };
    if (candidates.size !== 1)
        identityError(candidates.size ? 'SHORT_URL_IDENTITY_AMBIGUOUS' : 'SHORT_URL_IDENTITY_UNVERIFIED', diagnostics);
    const [productId, evidence] = candidates.entries().next().value;
    diagnostics.reason = 'IDENTITY_CANDIDATE_FOUND';
    return { productId, sources: [...evidence], diagnostics };
}

export function verifyShortOffer(result, identity) {
    const { commercial, metadata, output } = result, id = identity.productId;
    const pickers = commercial.pickers, offer = pickers?.selectedOffer;
    const offerProductMatches = offer?.productId?.toLowerCase() === id;
    const selectedOptions = pickers?.pickerGroups?.flatMap(group => group.items).filter(item =>
        item.selected === true && item.productId?.toLowerCase() === id) ?? [];
    const selectedOptionMatches = selectedOptions.length > 0;
    const selectedOptionPriceMatches = selectedOptions.some(item => item.price.currency === metadata.currency
        && decimalEqual(item.price.amount, output.price));
    const boundToSelection = offerProductMatches || selectedOptionPriceMatches;
    const productMatches = commercial.product?.productId?.toLowerCase() === id;
    const priceVerified = output.price !== null && metadata.priceVerification.status === 'verified';
    const selectedOfferFound = record(offer);
    const diagnostics = {
        ...identity.diagnostics,
        selectedProductFound: productMatches,
        selectedProductUuidFound: Boolean(commercial.product?.productId),
        selectedOfferFound,
        selectedOfferUuidFound: typeof offer?.productId === 'string' && UUID_RE.test(offer.productId),
        selectedOfferProductMatchesProduct: Boolean(offerProductMatches),
        selectedOptionMatchesProduct: Boolean(selectedOptionMatches),
        selectedOptionPriceMatchesOffer: Boolean(selectedOptionPriceMatches),
        priceVerified,
        reason: !productMatches ? 'SELECTED_PRODUCT_DATA_MISSING_OR_MISMATCHED'
            : !selectedOfferFound ? 'SELECTED_OFFER_MISSING'
                : !boundToSelection ? 'SELECTED_OFFER_NOT_BOUND_TO_ACTIVE_PRODUCT_OR_PRICE'
                    : !priceVerified ? (metadata.priceVerification?.reason ?? 'SELECTED_PRICE_NOT_VERIFIED') : 'VERIFIED',
    };
    if (!productMatches || !output.title || !selectedOfferFound || !boundToSelection || !priceVerified)
        identityError('SHORT_URL_SELECTED_OFFER_UNVERIFIED', diagnostics);
    identity.diagnostics = diagnostics;
    return diagnostics;
}
