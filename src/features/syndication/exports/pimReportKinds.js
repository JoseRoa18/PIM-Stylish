// The reports the Catalog's Report button offers (user, 2026-11-11: "que
// permita elegir si full report de precios, de imágenes, de atributos y así
// pues, y lógicamente el full completo"). Plain data, so the Catalog shows
// its menu without loading the report builder (pimReport.js, loaded on click).
//
// Every report starts each product row with SKU, Model Name, Brand and
// Category, so it can be uploaded back in Import Products: only the cells
// that differ from the PIM are updated. `sections` are the bands of the PIM's
// Excel it carries (importSchema's SECTIONS, plus the report's own `x_…`);
// `extra` the report's other sheets.
export const REPORT_KINDS = [
  {
    key: 'complete',
    label: 'Complete',
    hint: 'Everything the PIM holds: every field, completeness, stock, images, documents and marketplace IDs.',
    file: 'Full_Report',
    sheet: 'All Products',
    sections: null, // all of them
    extra: ['summary', 'media', 'ids'],
  },
  {
    key: 'prices',
    label: 'Prices',
    hint: 'MSRP, MAP and wholesale costs at Blue, Orange and Purple: Canada, USA and Wayfair Canada.',
    file: 'Prices_Report',
    sheet: 'Prices',
    sections: ['pricing_ca', 'pricing_us', 'pricing_wfca'],
    extra: [],
  },
  {
    key: 'attributes',
    label: 'Attributes',
    hint: 'Identity, specifications, dimensions, shipping, warranty and certifications.',
    file: 'Attributes_Report',
    sheet: 'Attributes',
    sections: ['identity', 'status', 'physical', 'sink', 'faucet', 'accessory', 'dimensions', 'shipping', 'carton', 'trade', 'certifications', 'other'],
    extra: [],
  },
  {
    key: 'content',
    label: 'Content',
    hint: 'Titles, descriptions, bullets and keywords, in English and French.',
    file: 'Content_Report',
    sheet: 'Content',
    sections: ['content_en', 'content_fr'],
    extra: [],
  },
  {
    key: 'images',
    label: 'Images & documents',
    hint: 'Every image link per product and every file. To read only: images are changed on the product page.',
    file: 'Images_Report',
    sheet: 'Images by product',
    sections: ['x_media', 'x_images'],
    extra: ['media'],
  },
  {
    key: 'ids',
    label: 'Marketplace IDs',
    hint: 'Retailer item numbers, Amazon, Wayfair and Wix IDs.',
    file: 'Marketplace_IDs_Report',
    sheet: 'IDs by product',
    sections: ['retailer', 'x_channels'],
    extra: ['ids'],
  },
];

export const reportKind = (key) => REPORT_KINDS.find((k) => k.key === key) ?? REPORT_KINDS[0];
