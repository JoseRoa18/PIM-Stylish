// Amazon.ca / Amazon.com product pages (/dp/<ASIN>) for the Where to Buy audit. The MAIN product's data:
//   - "Product details" rows (<th class="… prodDetSectionEntry">Model Number</th><td>S-611W</td>, or detail bullets);
//     "Included Components" names other SKUs (A-02 Colander…) and is never read.
//   - The price block under the title (price to pay, struck-through List Price / Was), the buy box (shown ASIN,
//     currencyCode, seller, coupon) and the twister (options: ASIN + size / color label). Carousels are never read.
import { decode, money, uniq, currencyOfMarket } from './common.js';

// Text of an HTML fragment, without tags, Amazon's &lrm; / &rlm; marks or extra spaces.
const clean = (s) => decode(String(s ?? '').replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>|&(?:lrm|rlm);/g, ' '))
  .replace(/[\u200e\u200f\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();

// One block of the page: from <div id="…"> to the next "…_feature_div" block (at most `max` characters).
function block(html, id, max = 15000) {
  const i = html.indexOf(`<div id="${id}"`);
  const end = i < 0 ? -1 : html.slice(i + 12 + id.length, i + max).search(/<div id="[^"]*_feature_div"/);
  return i < 0 ? '' : html.slice(i, end < 0 ? i + max : i + 12 + id.length + end);
}

// The first amount of a text ("$749.00 with 5 percent savings" → 749, "749,00 $" → 749).
const firstAmount = (t) => money(String(t ?? '').match(/\d[\d.,\s]*\d|\d/)?.[0]);

// An Amazon price span: its screen-reader text, else the visible whole + fraction, else its aria-hidden text.
function priceSpan(fragment) {
  const off = clean(fragment.match(/<span class="a-offscreen">([^<]*)</)?.[1]);
  if (/\d/.test(off)) return { amount: firstAmount(off), text: off };
  const whole = fragment.match(/<span class="a-price-whole">([^<]*)/)?.[1]?.replace(/\D/g, '');
  if (whole) {
    const symbol = clean(fragment.match(/<span class="a-price-symbol">([^<]*)/)?.[1]);
    return { amount: money(`${whole}.${fragment.match(/<span class="a-price-fraction">(\d+)/)?.[1] ?? '00'}`), text: `${symbol}${whole}` };
  }
  const hidden = clean(fragment.match(/<span aria-hidden="true">([^<]*\d[^<]*)</)?.[1]);
  return hidden ? { amount: firstAmount(hidden), text: hidden } : null;
}

// The price block: what the shopper pays now and the struck-through price next to it. A range
// ("$120.00 - $150.00", no option chosen) is no price.
function corePrice(html) {
  for (const id of ['corePriceDisplay_desktop_feature_div', 'corePrice_desktop', 'corePrice_feature_div']) {
    const b = block(html, id);
    if (/a-price-range/.test(b)) return null;
    const at = b.search(/class="a-price[^"]*\b(?:priceToPay|apex-pricetopay-value|apexPriceToPay)\b/);
    const label = clean(b.match(/id="apex-pricetopay-accessibility-label"[^>]*>([^<]*)/)?.[1]);
    const pay = (at >= 0 ? priceSpan(b.slice(at, at + 800)) : null) ?? (/\d/.test(label) ? { amount: firstAmount(label), text: label } : null);
    if (!pay?.amount) continue;
    const strike = b.search(/<span class="a-price a-text-price[^"]*"[^>]*data-a-strike="true"/);
    const was = strike >= 0 ? priceSpan(b.slice(strike, strike + 600)) : null;
    return { ...pay, was: was?.amount > pay.amount ? was.amount : null, block: id };
  }
  return null;
}

// "$" is the market's dollar (CAD on amazon.ca, USD on amazon.com); another currency shown is returned as is.
const CODE = /\b(CAD|USD|EUR|GBP|MXN|AUD|JPY|CNY|INR|BRL|SEK|PLN|TRY|AED|SAR|SGD|EGP)\b/;
const currencyOf = (text, cartCode, market) => {
  const s = String(text ?? '').toUpperCase();
  return /CDN\$|CA\$|C\$/.test(s) ? 'CAD' : /US\$/.test(s) ? 'USD'
    : s.match(CODE)?.[1] ?? (/€/.test(s) ? 'EUR' : /£/.test(s) ? 'GBP' : null) ?? cartCode ?? currencyOfMarket(market);
};

// Label / value rows of the "Product details" tables and of the detail bullets ("Label \u200f:\u200e" in bold).
function detailRows(html) {
  const rows = [...html.matchAll(/<th[^>]*\bprodDetSectionEntry\b[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => [clean(m[1]), clean(m[2])]);
  for (const m of html.matchAll(/<span class="a-text-bold">([^<]{1,80})<\/span>\s*<span[^>]*>([^<]{1,120})<\/span>/g)) {
    if (/:$/.test(clean(m[1]))) rows.push([clean(m[1]).replace(/\s*:$/, ''), clean(m[2])]);
  }
  return rows;
}
// Model / part number labels in English, French (amazon.ca in French) and Spanish (amazon.com en español).
const ID_LABEL = /^(?:item model number|model number|manufacturer part number|item part number|part number|num[ée]ro (?:du |de )?mod[èe]le(?: de l['’]article)?|r[ée]f[ée]rence (?:du )?fabricant|num[ée]ro de (?:pi[èe]ce|r[ée]f[ée]rence)(?: du fabricant)?|n[úu]mero de (?:modelo|pieza)(?: del (?:producto|fabricante))?)$/i;
// Not a model number: "N/A"…, or a UUID (Amazon.ca's A-801B listing has "Model Number 054a7ded-a4bd-…").
const NO_VALUE = /^(?:n\/?a|none|no|does not apply|not applicable|-|0)$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i;
// A twister label that is itself a model number (most labels are sizes or colors: "30\"x19\" Single Bowl").
const MODEL_LIKE = /^[A-Z]{1,3}-?\d{2,4}[A-Z]{0,5}(?:-\d)?$/;

function readAmazon(html, url) {
  html = String(html ?? '');
  if (/validateCaptcha|Enter the characters you see below/i.test(html)) return null; // bot page ("Amazon.ca", "Continue shopping")
  if (!/id="productTitle"/.test(html)) return null; // "Page Not Found" (404 dog page), search, home page
  const host = String(url ?? '').match(/^https?:\/\/([^/?#]+)/i)?.[1] ?? html.match(/<link rel="canonical" href="https?:\/\/([^/"]+)/i)?.[1] ?? '';
  const market = /(?:^|\.)amazon\.ca$/i.test(host) ? 'ca' : /(?:^|\.)amazon\.com$/i.test(host) ? 'us' : null;

  const rows = detailRows(html);
  const ids = uniq(rows.filter(([k, v]) => ID_LABEL.test(k) && !NO_VALUE.test(v) && v.length <= 40).map(([, v]) => v));
  // The ASIN on show: an old ASIN can open another one (twister "landingAsin" ≠ "currentAsin").
  const itemId = html.match(/<input type="hidden" id="ASIN" name="ASIN" value="([A-Z0-9]{10})"/)?.[1]
    ?? rows.find(([k]) => k === 'ASIN')?.[1] ?? html.match(/"currentAsin"\s*:\s*"([A-Z0-9]{10})"/)?.[1]
    ?? html.match(/<link rel="canonical" href="[^"]*\/dp\/([A-Z0-9]{10})/)?.[1] ?? String(url ?? '').match(/\/dp\/([A-Z0-9]{10})/i)?.[1] ?? null;

  // Options: the twister's other ASINs; a label is kept in `options` only when it is a model number.
  let twister = {};
  try { twister = JSON.parse(html.match(/"dimensionValuesDisplayData"\s*:\s*(\{[^{}]*\})/)?.[1] ?? '{}'); } catch { /* none */ }
  const others = Object.entries(twister).filter(([asin]) => asin !== itemId);
  const options = uniq(others.flatMap(([, labels]) => [].concat(labels)).filter((l) => MODEL_LIKE.test(String(l).trim())));

  // Price: the block under the title; the add-to-cart form names its currency.
  const core = corePrice(html);
  const cartCode = html.match(/name="items\[0\.base\]\[customerVisiblePrice\]\[currencyCode\]" value="([A-Z]{3})"/)?.[1] ?? null;
  // Availability: the line under the price, or the "Currently unavailable" buy box. No featured offer → null.
  const avail = clean(block(html, 'availability', 5000)) + ' ' + clean(block(html, 'outOfStockBuyBox_feature_div', 4000));
  const inStock = /currently unavailable|temporarily out of stock|out of stock|in stock soon|actuellement indisponible|rupture de stock|no disponible|agotado/i.test(avail) ? false
    : /in stock|en stock|ships within|usually ships|available to ship|disponible|en existencia/i.test(avail) ? true
    : core && /id="add-to-cart-button"/.test(html) ? true : null;

  // A coupon to clip under the price ("Apply 5% coupon", "Apply $10 coupon"): the shopper pays less at checkout.
  const couponText = clean(block(html, 'promoPriceBlockMessage_feature_div', 30000).match(/couponLabelText"[^>]*>([^<]*)/)?.[1]);
  const coupon = couponText.match(/(\d+(?:[.,]\d+)?)\s*%/)?.[1]?.replace(',', '.').concat('%') ?? (firstAmount(couponText) ? `$${firstAmount(couponText)}` : null);
  const seller = clean(html.match(/offer-display-feature-name="desktop-merchant-info"[\s\S]{0,2500}?offer-display-feature-text-message">([\s\S]*?)<\/span>/)?.[1])
    || clean(html.match(/id=['"]sellerProfileTriggerId['"][^>]*>([^<]*)/)?.[1]) || null;
  // The header's delivery place ("Delivering to Toronto M5A" / "Deliver to | Canada"). A place without the market's
  // ZIP / postal code is an exit in another country: amazon.com then hides the buy box ("See All Buying Options").
  const line1 = clean(html.match(/id="glow-ingress-line1"[^>]*>([^<]*)/)?.[1]);
  const DELIVER = /^(?:delivering to|livraison à|enviar a|entregar en)\s+/i;
  const deliverTo = (DELIVER.test(line1) ? line1.replace(DELIVER, '') : clean(html.match(/id="glow-ingress-line2"[^>]*>([^<]*)/)?.[1])) || null;
  const foreignExit = !deliverTo || !market ? null
    : market === 'us' ? !/\b\d{5}\b|United States|USA/i.test(deliverTo) : !/\b[A-Z]\d[A-Z]\b|Canada/i.test(deliverTo);

  return {
    ids, options, price: core?.amount ?? null, wasPrice: core?.was ?? null, currency: core ? currencyOf(core.text, cartCode, market) : null,
    inStock, itemId, source: ['details', core && `price:${core.block}`].filter(Boolean).join('+'),
    // Extra fields (not in the PageRead contract): the other options' ASINs, coupon, buy box seller, delivery place.
    optionItemIds: others.map(([asin]) => asin), coupon, seller, deliverTo, foreignExit,
  };
}

export const readers = { amazon_ca: readAmazon, amazon_us: readAmazon };
