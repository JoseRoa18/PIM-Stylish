import { supabase } from '@/lib/supabase';

export async function listTemplates() {
  const { data, error } = await supabase
    .from('marketplace_templates')
    .select('*')
    .order('marketplace', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function uploadTemplate(marketplace, file) {
  const ext = file.name.split('.').pop();
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
    })
    .select('*')
    .single();

  if (insertErr) throw new Error(`Save failed: ${insertErr.message}`);
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
