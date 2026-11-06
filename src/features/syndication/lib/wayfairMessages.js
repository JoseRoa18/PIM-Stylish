// Plain wording for what Wayfair answers on the New listing card (user,
// 2026-11-06: "más sencillos y entendibles"). Wayfair's own codes and repeated
// lines stay out of sight; a text it writes that has no rule here is shown as it is.

const ATTRIBUTE_NAMES = {
  'media::documentValue': 'Documents',
  'media::documentType': 'Documents',
  'media::regionType': 'Documents',
  'media::imageValue': 'Images',
  'price::wholesalePrice': 'Base cost',
  'price::manufacturerSuggestedRetailPrice': 'MSRP',
  'price::minimumAdvertizedPrice': 'MAP',
  'core::productName': 'Product name',
  'featureDescription::romanceCopy': 'Description',
  'featureDescription::genericFeatures': 'Bullets',
};

function attributeName(id) {
  if (!id || id === 'request') return '';
  if (ATTRIBUTE_NAMES[id]) return ATTRIBUTE_NAMES[id];
  const last = String(id).split('::').pop();
  if (/^\d+$/.test(last)) return ''; // a question's number says nothing to a person
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function plainFlaw(attributeId, flaw) {
  const text = String(flaw ?? '').trim();
  const tooMany = text.match(/more (\w+) than allowed.*?(\d+) or fewer/i);
  if (tooMany) return `Too many ${tooMany[1]}: Wayfair takes ${tooMany[2]} at most.`;
  const suggested = text.match(/legal document types are RECOMMENDED:\s*(.+?)\s+\d+:\s*RECOMMENDED/i);
  if (suggested) return `Upload the ${suggested[1].replace(/\s+Compliant$/i, '')} certificate, because this product says it complies.`;
  const name = attributeName(attributeId);
  return name ? `${name}: ${text}` : text;
}

/** Wayfair's errors or warnings as plain sentences, each one once (13 equal lines read as one). */
export function describeFlaws(flaws) {
  return [...new Set((flaws ?? []).map((f) => plainFlaw(f.attributeId, f.flaw)))];
}

export function describeNotes(notes) {
  return (notes ?? []).map((note) => {
    const bullets = String(note).match(/^(\d+) bullets in the PIM .*first (\d+) are sent$/);
    return bullets ? `This product has ${bullets[1]} bullets. Wayfair takes ${bullets[2]}, so the first ${bullets[2]} go.` : note;
  });
}

// `result` is the answer to Validate, Create or Mapped attributes.
export function resultHeadline(row, result) {
  const created = result.validateOnly === false;
  const problems = row.missingRequired?.length || row.unmapped?.length || row.errors?.length;
  if (result.preview) return { tone: 'info', title: 'This is what the PIM would send. Nothing went to Wayfair.' };
  if (problems) {
    return {
      tone: 'error',
      title: created ? 'Wayfair did not create the listing.' : 'Not ready to create yet.',
      detail: 'Fix the problems below and validate again.',
    };
  }
  const later = result.requestId ? 'Click Check status in a minute to see the result.' : '';
  if (created) return { tone: 'ok', title: 'Sent to Wayfair to create the listing.', detail: later };
  return {
    tone: 'ok',
    title: row.status === 'PROCESSING' ? 'Sent to Wayfair to check. Nothing was created.' : 'No problems found. Nothing was created.',
    detail: later,
  };
}

export function resultSummary(row, result) {
  return [
    result.env === 'sandbox' ? 'Test (sandbox)' : null,
    row.className,
    `${row.images} image${row.images === 1 ? '' : 's'}`,
    `${row.documents} document${row.documents === 1 ? '' : 's'}`,
    row.listed ? 'already on Wayfair' : null,
    row.variant && row.variant !== 'not a variant' ? row.variant : null,
  ].filter(Boolean).join(' · ');
}

// `p` is one product of Check status; `created`: the request was a Create.
export function statusHeadline(p, created) {
  const failed = p.errors?.length > 0 || /FAIL|REJECT|ERROR/i.test(`${p.validationStatus ?? ''} ${p.submissionStatus ?? ''}`);
  if (failed) {
    return {
      tone: 'error',
      title: `Wayfair did not accept ${p.sku}.`,
      detail: created ? 'The listing was not created. Fix the problems below and try again.' : 'Fix the problems below and validate again.',
    };
  }
  const checked = /VALIDATED|PASS|SUCCESS/i.test(p.validationStatus ?? '');
  if (!checked) return { tone: 'waiting', title: `Wayfair is still checking ${p.sku}.`, detail: 'Check again in a minute.' };
  if (!created) return { tone: 'ok', title: `Wayfair checked ${p.sku}: no problems.`, detail: 'Nothing was created yet. You can create the listing now.' };
  if (/COMPLETE/i.test(p.submissionStatus ?? '')) return { tone: 'ok', title: `Wayfair accepted ${p.sku}.`, detail: 'It can take a while to show on their site.' };
  return { tone: 'waiting', title: `Wayfair is creating ${p.sku}.`, detail: 'Check again in a few minutes.' };
}
