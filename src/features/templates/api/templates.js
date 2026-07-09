import { supabase } from '@/lib/supabase';

// Categories a template can be scoped to. An empty scope = general (all products).
export const TEMPLATE_CATEGORIES = [
  { value: 'kitchen_sink', label: 'Kitchen Sink' },
  { value: 'bathroom_sink', label: 'Bathroom Sink' },
  { value: 'kitchen_faucet', label: 'Kitchen Faucet' },
  { value: 'bathroom_faucet', label: 'Bathroom Faucet' },
  { value: 'pot_filler', label: 'Pot Filler' },
  { value: 'bar_prep_sink', label: 'Bar/Prep Sink' },
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

  const { error: uploadErr } = await supabase.storage
    .from('templates')
    .upload(storagePath, file, {
      contentType: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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
