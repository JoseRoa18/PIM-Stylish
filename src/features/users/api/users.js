import { supabase } from '@/lib/supabase';

// All user management goes through the admin-users Edge Function, which checks
// that the caller is an admin and uses the service_role key server-side.
async function invokeAdminUsers(body) {
  const { data, error } = await supabase.functions.invoke('admin-users', { body });

  if (error) {
    // The Functions client hides the response body inside error.context;
    // dig out the real message the function returned.
    let detail = error.message;
    try {
      if (error.context && typeof error.context.text === 'function') {
        const text = await error.context.text();
        try {
          const parsed = JSON.parse(text);
          detail = parsed.error || parsed.message || text;
        } catch {
          detail = text || detail;
        }
      }
    } catch {
      // fall back to error.message
    }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function listUsers() {
  const data = await invokeAdminUsers({ action: 'list' });
  return data.users ?? [];
}

export async function createUser({ email, password, full_name, role }) {
  const data = await invokeAdminUsers({ action: 'create', email, password, full_name, role });
  return data.user;
}

export async function updateUserRole(id, role) {
  return invokeAdminUsers({ action: 'updateRole', id, role });
}

export async function resetUserPassword(id, password) {
  return invokeAdminUsers({ action: 'resetPassword', id, password });
}

export async function deleteUser(id) {
  return invokeAdminUsers({ action: 'delete', id });
}
