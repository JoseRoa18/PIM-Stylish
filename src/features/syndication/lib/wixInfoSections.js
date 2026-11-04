// Derive a Wix product's "Additional info sections" from PIM data.
//
// Wix listings carry three PIM-derivable sections (observed structure on the
// live site — keep the exact HTML shapes so a rebuild of an already-correct
// listing is a no-op diff):
//
//   DIMENSIONS            <ul><li>Faucet Height:&nbsp;14 1/8"</li>…</ul>
//   FEATURES              <p><strong>TITLE:</strong></p><p>body</p><p>&nbsp;</p>…
//   DOCUMENTS TO DOWNLOAD <ul><li><a href="…">INSTALLATION GUIDE</a></li>…</ul>
//
// Rules (per the publish flow):
//   - DIMENSIONS and FEATURES are rebuilt wholesale from PIM measurements /
//     bullet_points (and appended if the listing doesn't have them yet).
//   - DOCUMENTS (DOCUMENTS TO DOWNLOAD, the Azuni store's TECHNICAL
//     DOCUMENTS) is rebuilt wholesale from the PIM's documents, like the
//     WHERE TO BUY links (user, 2026-11-04): a document the product does not
//     have does not appear, and a product without any loses the section.
//   - Every other section (RECOMMENDED ACCESSORIES, VIDEOS, WHERE TO BUY, …)
//     passes through untouched.

import { toFractionLength } from '@/features/products/lib/units';
import { isFaucetCategory } from '@/features/products/lib/categories';

function esc(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function inches(value) {
  const f = toFractionLength(value);
  return f == null ? null : `${f}"`;
}

// {length, width, depth} → `22" L x 17 1/2" W x 8 1/4" D`
function dims3(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const l = inches(obj.length);
  const w = inches(obj.width);
  const d = inches(obj.depth);
  if (!l || !w || !d) return null;
  return `${l} L x ${w} W x ${d} D`;
}

function listHtml(rows) {
  if (!rows.length) return null;
  return `<ul>${rows.map(([label, value]) => `<li>${esc(label)}:&nbsp;${esc(value)}</li>`).join('')}</ul>`;
}

export function buildDimensionsHtml(product) {
  const attrs = product?.attributes ?? {};
  const category = String(product?.category ?? '');
  const rows = [];

  if (isFaucetCategory(category)) {
    const push = (label, key) => {
      const v = inches(attrs[key]);
      if (v) rows.push([label, v]);
    };
    push('Faucet Height', 'faucet_height_in');
    push('Spout Height', 'spout_height_in');
    push('Spout Reach', 'spout_reach_in');
  } else if (/sink/i.test(category)) {
    const ext = dims3(attrs.external_dimensions_in);
    const int = dims3(attrs.internal_dimensions_in);
    const cab = inches(attrs.min_external_cabinet_size_in);
    if (ext) rows.push(['External Size', ext]);
    if (int) rows.push(['Internal Size', int]);
    if (cab) rows.push(['Min. External Cabinet Size', cab]);
  }

  return listHtml(rows);
}

export function buildFeaturesHtml(product) {
  const bullets = product?.attributes?.bullet_points;
  if (!Array.isArray(bullets) || bullets.length === 0) return null;

  const blocks = bullets
    .map((b) => String(b ?? '').trim())
    .filter(Boolean)
    .map((text) => {
      const i = text.indexOf(':');
      if (i > 0) {
        const title = text.slice(0, i).trim();
        const body = text.slice(i + 1).trim();
        return `<p><strong>${esc(title)}:</strong></p><p>${esc(body)}</p><p>&nbsp;</p>`;
      }
      return `<p>${esc(text)}</p><p>&nbsp;</p>`;
    });
  return blocks.length ? blocks.join('') : null;
}

const isDimensions = (t) => /DIMENSION/i.test(t);
const isFeatures = (t) => /FEATURE/i.test(t);
const isDocuments = (t) => /DOCUMENT|DOWNLOAD/i.test(t);

// The faucets' Spare Parts Diagram goes to the Sinks Direct and Stylish
// websites only (user, 2026-10-05).
const SPARE_PARTS_SITES = new Set(['sinksdirect_ca', 'sinksdirect_us', 'stylish_ca', 'stylish_us']);
const US_SITES = new Set(['sinksdirect_us', 'stylish_us']);

// The sink's mounting (attributes.installation_type) picks its own guide and
// DXF first; a product without one takes the general file, then any.
const mountOf = (product) => {
  const t = [product?.attributes?.installation_type ?? []].flat().join(' ');
  if (/dual/i.test(t)) return 'dual';
  if (/under/i.test(t)) return 'under';
  if (/top/i.test(t)) return 'top';
  if (/drop/i.test(t)) return 'drop';
  return null;
};
const INSTALL_KINDS = {
  dual: ['installation_dual_mount', 'installation_undermount', 'installation_drop_in'],
  under: ['installation_undermount'],
  top: ['installation_top_mount', 'installation_drop_in'],
  drop: ['installation_drop_in', 'installation_top_mount'],
};
const DXF_KINDS = {
  dual: ['dxf_undermount', 'dxf_drop_in'],
  under: ['dxf_undermount'],
  top: ['dxf_top_mount', 'dxf_drop_in'],
  drop: ['dxf_drop_in', 'dxf_top_mount'],
};
const ANY_INSTALL = ['installation_manual', 'installation_undermount', 'installation_dual_mount', 'installation_drop_in', 'installation_top_mount'];
const ANY_DXF = ['dxf_file', 'dxf_undermount', 'dxf_drop_in', 'dxf_top_mount'];

/**
 * The DOCUMENTS section from the PIM's documents (user, 2026-11-04: as with
 * the WHERE TO BUY links, a document the product does not have does not
 * appear). One link per kind, in the stores' own order and words:
 * INSTALLATION GUIDE, PDF CUT-OUT TEMPLATE, DXF FILE, SPEC. SHEET (the Azuni
 * store writes SPEC SHEET), then the faucets' SPARE PARTS DIAGRAM on the
 * Sinks Direct and Stylish websites. The brand warranty is not listed (it
 * never was). Language: the Canada stores take the English + French file
 * first, the USA ones the English one, then the other, then a
 * language-neutral file; French-only or Spanish only when nothing else
 * exists. Returns { html, count } — html null when the product has none.
 */
export function buildDocumentsHtml(product, docs, site = null) {
  const langs = US_SITES.has(site) ? ['en', 'en_fr', null, 'en_es', 'fr'] : ['en_fr', 'en', null, 'fr', 'en_es'];
  const pick = (kinds) => {
    for (const kind of kinds) {
      for (const lang of langs) {
        const d = docs.find((x) => x.document_type === kind && (x.language ?? null) === lang && /^https?:\/\//i.test(x.storage_path ?? ''));
        if (d) return d.storage_path;
      }
    }
    return null;
  };
  const mount = mountOf(product);
  const links = [
    ['INSTALLATION GUIDE', pick([...(INSTALL_KINDS[mount] ?? []), ...ANY_INSTALL])],
    ['PDF CUT-OUT TEMPLATE', pick(['cut_out_template'])],
    ['DXF FILE', pick([...(DXF_KINDS[mount] ?? []), ...ANY_DXF])],
    [site === 'azuni_ca' ? 'SPEC SHEET' : 'SPEC. SHEET', pick(['spec_sheet'])],
    ['SPARE PARTS DIAGRAM', SPARE_PARTS_SITES.has(site) ? pick(['spare_parts_diagram']) : null],
  ].filter(([, url]) => url);
  if (!links.length) return { html: null, count: 0 };
  return {
    html: `<ul>${links.map(([label, url]) => `<li><a href="${esc(url).replaceAll('"', '&quot;')}" target="_blank">${esc(label)}</a></li>`).join('')}</ul>`,
    count: links.length,
  };
}

/**
 * Transform a Wix product's current sections into what the PIM says they
 * should be. `sections` is the listing's current array (may be empty);
 * `media` is the product's product_media rows (documents are read from it).
 *
 * `site` is the Wix site the sections are for.
 *
 * Returns { sections, changes } where changes summarizes what happened:
 *   { dimensions: bool, features: bool, docs: n links (null = untouched), docsRemoved: bool }
 */
export function deriveWixSectionsFromPim(product, media, sections, site = null) {
  const docs = (media ?? []).filter(
    (m) => m.media_type === 'document' && m.storage_path,
  );
  const dimensionsHtml = buildDimensionsHtml(product);
  const featuresHtml = buildFeaturesHtml(product);
  const documents = buildDocumentsHtml(product, docs, site);

  const changes = { dimensions: false, features: false, docs: null, docsRemoved: false };
  let sawDimensions = false;
  let sawFeatures = false;
  let sawDocuments = false;

  const out = (Array.isArray(sections) ? sections : []).map((section) => {
    const title = String(section?.title ?? '');
    if (isDimensions(title) && dimensionsHtml) {
      sawDimensions = true;
      changes.dimensions = true;
      return { ...section, description: dimensionsHtml };
    }
    if (isFeatures(title) && featuresHtml) {
      sawFeatures = true;
      changes.features = true;
      return { ...section, description: featuresHtml };
    }
    if (isDocuments(title)) {
      // One documents section, the PIM's; a second one or one with nothing
      // the PIM has goes away.
      if (sawDocuments || !documents.html) {
        changes.docsRemoved = true;
        return null;
      }
      sawDocuments = true;
      changes.docs = documents.count;
      return { ...section, description: documents.html };
    }
    return section;
  }).filter(Boolean);

  // Listings that never had these sections get them appended.
  if (!sawDimensions && dimensionsHtml) {
    out.push({ title: 'DIMENSIONS', description: dimensionsHtml });
    changes.dimensions = true;
  }
  if (!sawFeatures && featuresHtml) {
    out.push({ title: 'FEATURES', description: featuresHtml });
    changes.features = true;
  }
  if (!sawDocuments && documents.html) {
    out.push({ title: site === 'azuni_ca' ? 'TECHNICAL DOCUMENTS' : 'DOCUMENTS TO DOWNLOAD', description: documents.html });
    changes.docs = documents.count;
  }

  return { sections: out, changes };
}
