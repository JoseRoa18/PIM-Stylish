import { supabase } from '@/lib/supabase';

// Categories a template can be scoped to. An empty scope = general (all products).
export const TEMPLATE_CATEGORIES = [
  { value: 'kitchen_sink', label: 'Kitchen Sink' },
  { value: 'bathroom_sink', label: 'Bathroom Sink' },
  { value: 'kitchen_faucet', label: 'Kitchen Faucet' },
  { value: 'bathroom_faucet', label: 'Bathroom Faucet' },
  { value: 'pot_filler', label: 'Pot Filler' },
  { value: 'bar_prep_sink', label: 'Bar/Prep Sink' },
  { value: 'outdoor_sink', label: 'Outdoor Sink & Ice Chest' },
  { value: 'accessory', label: 'Accessory' },
];

const CATEGORY_LABEL = Object.fromEntries(TEMPLATE_CATEGORIES.map((c) => [c.value, c.label]));
export const templateCategoryLabel = (value) => CATEGORY_LABEL[value] ?? value;

// A template is available for a product when it's general (no categories) or
// explicitly lists that product's category.
export function templateAppliesTo(template, category) {
  const cats = template?.categories;
  return !cats || cats.length === 0 || cats.includes(category);
}

// Accessories span several marketplace classes (cutting boards, strainers,
// soap dispensers…), each with its own template file. Derive the product's
// accessory kind so the right template can be picked by file name.
export function accessoryKind(product) {
  const t = `${product.product_type ?? ''} ${product.attributes?.general_title_en ?? ''} ${product.model_name ?? ''}`;
  if (/cutting board|serving board|over the sink|workstation/i.test(t)) return 'cutting board';
  if (/strainer/i.test(t)) return 'strainer';
  if (/colander/i.test(t)) return 'strainer'; // colanders share the strainers class
  if (/soap|lotion/i.test(t)) return 'soap dispenser';
  if (/drain/i.test(t)) return 'drain';
  if (/faucet plate|deck plate/i.test(t)) return 'faucet plate';
  if (/grid/i.test(t)) return 'grid';
  return null;
}

// File-name patterns per accessory kind — tolerant to common typos
// ("Cuting boards", missing spaces, plurals).
const KIND_FILE_RE = {
  'cutting board': /cutt?ing.?boards?/i,
  strainer: /strainers?|colanders?/i,
  'soap dispenser': /soap|dispensers?/i,
  drain: /drains?/i,
  'faucet plate': /faucet.?plates?|deck.?plates?/i,
  grid: /grids?/i,
};

// Category must apply, and for accessories the file name must mention the
// product's kind (a cutting board never lands in the strainers template).
// Templates whose file name mentions NO kind are spec-wide (e.g. Walmart's
// "Home Decor, Kitchen & Other" file) and accept every accessory.
export function templateMatchesProduct(template, product) {
  if (!templateAppliesTo(template, product.category)) return false;
  if (product.category !== 'accessory') return true;
  const name = template.file_name ?? '';
  const isKindSpecific = Object.values(KIND_FILE_RE).some((re) => re.test(name));
  if (!isKindSpecific) return true;
  const kind = accessoryKind(product);
  if (!kind) return false;
  const re = KIND_FILE_RE[kind] ?? new RegExp(kind.replace(' ', '.?'), 'i');
  return re.test(name);
}

// Pick the best template for a product. Returns null when nothing fits.
export function templateForProduct(templates, product) {
  return templates.find((t) => templateMatchesProduct(t, product)) ?? null;
}

export async function listTemplates() {
  const { data, error } = await supabase
    .from('marketplace_templates')
    .select('*')
    .order('marketplace', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function uploadTemplate(marketplace, file, categories = []) {
  const storagePath = `marketplace-templates/${marketplace.toLowerCase().replace(/[^a-z0-9]/g, '_')}/${Date.now()}_${file.name}`;

  const isMacroEnabled = /\.xlsm$/i.test(file.name);
  const { error: uploadErr } = await supabase.storage
    .from('templates')
    .upload(storagePath, file, {
      contentType:
        file.type ||
        (isMacroEnabled
          ? 'application/vnd.ms-excel.sheet.macroEnabled.12'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      upsert: false,
    });

  if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);

  const { data, error: insertErr } = await supabase
    .from('marketplace_templates')
    .insert({
      marketplace,
      file_name: file.name,
      storage_path: storagePath,
      categories: categories.length ? categories : null,
    })
    .select('*')
    .single();

  if (insertErr) throw new Error(`Save failed: ${insertErr.message}`);
  return data;
}

export async function updateTemplateCategories(id, categories) {
  const { data, error } = await supabase
    .from('marketplace_templates')
    .update({ categories: categories.length ? categories : null })
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw new Error(`Update failed: ${error.message}`);
  return data;
}

export async function deleteTemplate(id, storagePath) {
  const { error: storageErr } = await supabase.storage
    .from('templates')
    .remove([storagePath]);

  if (storageErr) console.warn('Storage delete failed:', storageErr.message);

  const { error } = await supabase
    .from('marketplace_templates')
    .delete()
    .eq('id', id);

  if (error) throw new Error(`Delete failed: ${error.message}`);
}

export function getTemplateDownloadUrl(storagePath) {
  const { data } = supabase.storage.from('templates').getPublicUrl(storagePath);
  return data?.publicUrl ?? null;
}
