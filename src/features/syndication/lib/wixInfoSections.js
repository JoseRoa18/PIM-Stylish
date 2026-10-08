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
//   - DOCUMENTS keeps its structure; only the hrefs are repointed to the PIM's
//     files. A link whose label matches no PIM document keeps its old URL.
//   - Every other section (RECOMMENDED ACCESSORIES, VIDEOS, WARRANTY, …)
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

// Anchor label → PIM document_type. DXF is checked before CUT-OUT because a
// "DXF CUT-OUT TEMPLATE" is the DXF file, not the PDF template.
export function docTypeForLabel(label) {
  const t = String(label ?? '').toUpperCase();
  if (/SPARE|PARTS? DIAGRAM|EXPLODED/.test(t)) return 'spare_parts_diagram';
  if (/DXF/.test(t)) {
    if (/UNDERMOUNT/.test(t)) return 'dxf_undermount';
    if (/DROP.?IN/.test(t)) return 'dxf_drop_in';
    return 'dxf_file';
  }
  if (/CUT.?OUT|TEMPLATE/.test(t)) return 'cut_out_template';
  if (/INSTALL/.test(t)) {
    if (/UNDERMOUNT/.test(t)) return 'installation_undermount';
    if (/DROP.?IN/.test(t)) return 'installation_drop_in';
    if (/DUAL/.test(t)) return 'installation_dual_mount';
    return 'installation_manual';
  }
  if (/SPEC/.test(t)) return 'spec_sheet';
  if (/WARRANTY/.test(t)) return 'warranty_file';
  return null;
}

// Some SKUs hold EN + FR copies of the same document type. Prefer the copy
// whose filename matches the label's language (default: not French).
function pickDoc(docs, type, label) {
  const candidates = docs.filter((d) => d.document_type === type);
  if (!candidates.length) return null;
  const wantsFrench = /FRENCH|FRANC|_FR\b/i.test(String(label ?? ''));
  const isFrench = (d) => /(_fr|french|francais)[^/]*$/i.test(d.storage_path ?? '');
  return (
    candidates.find((d) => (wantsFrench ? isFrench(d) : !isFrench(d))) ?? candidates[0]
  );
}

// The file name a link points at ('…/C233_drop_in_installation.dxf?rlkey=…'
// → 'c233_drop_in_installation.dxf').
function linkFileName(href) {
  try {
    const path = new URL(href, 'https://x.invalid').pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)).toLowerCase();
  } catch {
    return '';
  }
}

// The PIM document behind one link. A generic label ("INSTALLATION GUIDE",
// "DXF FILE") says nothing about the mount, and most sinks only carry the
// per-mount types — so the linked file tells: first a PIM file with the very
// same name, then the mount its name mentions ("Azuni-dualmount-installation-
// guide.pdf" → installation_dual_mount), then the family's only type.
// Found 2026-09-29 on C233: both links still went to Dropbox after pushes.
function docForLink(docs, label, href) {
  const file = linkFileName(href);
  if (file) {
    const same = docs.find((d) => String(d.file_name ?? '').toLowerCase() === file);
    if (same) return same;
  }
  const type = docTypeForLabel(label);
  if (!type) return null;
  const direct = pickDoc(docs, type, label);
  if (direct || (type !== 'installation_manual' && type !== 'dxf_file')) return direct;
  const family = type === 'dxf_file' ? 'dxf_' : 'installation_';
  const mount = /under.?mount/.test(file) ? 'undermount' : /drop.?in/.test(file) ? 'drop_in' : /dual.?mount/.test(file) ? 'dual_mount' : null;
  if (mount) {
    const hinted = pickDoc(docs, `${family}${mount}`, label);
    if (hinted) return hinted;
  }
  const types = [...new Set(docs.map((d) => d.document_type).filter((t) => t?.startsWith(family)))];
  return types.length === 1 ? pickDoc(docs, types[0], label) : null;
}

// Repoint <a href> values inside the documents section at PIM files where a
// matching document exists; leave everything else (labels, order, unmatched
// links) exactly as it was. Returns { html, replaced, kept }.
export function rewriteDocumentLinks(html, docs) {
  if (typeof html !== 'string' || !html.trim()) return { html, replaced: 0, kept: 0 };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors = [...doc.body.querySelectorAll('a[href]')];
  let replaced = 0;
  let kept = 0;
  for (const a of anchors) {
    const match = docForLink(docs, a.textContent, a.getAttribute('href'));
    if (match?.storage_path && /^https?:\/\//i.test(match.storage_path)) {
      if (a.getAttribute('href') !== match.storage_path) replaced += 1;
      a.setAttribute('href', match.storage_path);
    } else {
      kept += 1;
    }
  }
  return { html: doc.body.innerHTML, replaced, kept };
}

const isDimensions = (t) => /DIMENSION/i.test(t);
const isFeatures = (t) => /FEATURE/i.test(t);
const isDocuments = (t) => /DOCUMENT|DOWNLOAD/i.test(t);

// The faucets' Spare Parts Diagram goes to the Sinks Direct and Stylish
// websites only (user, 2026-10-05) — the one document the PIM ADDS to a
// listing's DOCUMENTS TO DOWNLOAD (the others are only repointed).
const SPARE_PARTS_SITES = new Set(['sinksdirect_ca', 'sinksdirect_us', 'stylish_ca', 'stylish_us']);
const SPARE_PARTS_LABEL = 'SPARE PARTS DIAGRAM';

// Add one <li><a> to the section's list when no link of that type is there
// yet; it copies the attributes the existing links carry (target, rel).
function addDocumentLink(html, type, label, url) {
  const doc = new DOMParser().parseFromString(typeof html === 'string' ? html : '', 'text/html');
  const anchors = [...doc.body.querySelectorAll('a[href]')];
  if (anchors.some((a) => docTypeForLabel(a.textContent) === type)) return { html, added: false };
  const a = doc.createElement('a');
  for (const name of ['target', 'rel']) {
    const v = anchors[0]?.getAttribute(name);
    if (v) a.setAttribute(name, v);
  }
  a.setAttribute('href', url);
  a.textContent = label;
  const li = doc.createElement('li');
  li.appendChild(a);
  let ul = doc.body.querySelector('ul');
  if (!ul) { ul = doc.createElement('ul'); doc.body.appendChild(ul); }
  ul.appendChild(li);
  return { html: doc.body.innerHTML, added: true };
}

/**
 * Transform a Wix product's current sections into what the PIM says they
 * should be. `sections` is the listing's current array (may be empty);
 * `media` is the product's product_media rows (documents are read from it).
 *
 * `site` is the Wix site the sections are for.
 *
 * Returns { sections, changes } where changes summarizes what happened:
 *   { dimensions: bool, features: bool, docsReplaced: n, docsKept: n, docsAdded: n }
 */
export function deriveWixSectionsFromPim(product, media, sections, site = null) {
  const docs = (media ?? []).filter(
    (m) => m.media_type === 'document' && m.storage_path,
  );
  const dimensionsHtml = buildDimensionsHtml(product);
  const featuresHtml = buildFeaturesHtml(product);
  const spareParts = SPARE_PARTS_SITES.has(site)
    ? docs.find((d) => d.document_type === 'spare_parts_diagram' && /^https?:\/\//i.test(d.storage_path))
    : null;

  const changes = { dimensions: false, features: false, docsReplaced: 0, docsKept: 0, docsAdded: 0 };
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
      sawDocuments = true;
      const { html, replaced, kept } = rewriteDocumentLinks(section?.description, docs);
      changes.docsReplaced += replaced;
      changes.docsKept += kept;
      if (!spareParts) return { ...section, description: html };
      const withDiagram = addDocumentLink(html, 'spare_parts_diagram', SPARE_PARTS_LABEL, spareParts.storage_path);
      if (withDiagram.added) changes.docsAdded += 1;
      return { ...section, description: withDiagram.html };
    }
    return section;
  });

  if (!sawDocuments && spareParts) {
    out.push({ title: 'DOCUMENTS TO DOWNLOAD', description: `<ul><li><a href="${esc(spareParts.storage_path)}">${SPARE_PARTS_LABEL}</a></li></ul>` });
    changes.docsAdded += 1;
  }

  // Listings that never had these sections get them appended.
  if (!sawDimensions && dimensionsHtml) {
    out.push({ title: 'DIMENSIONS', description: dimensionsHtml });
    changes.dimensions = true;
  }
  if (!sawFeatures && featuresHtml) {
    out.push({ title: 'FEATURES', description: featuresHtml });
    changes.features = true;
  }

  return { sections: out, changes };
}
