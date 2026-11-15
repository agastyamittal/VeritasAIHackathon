// Supabase Storage over plain REST calls, so the app still needs no SDK or CDN.
import { SUPABASE_URL, SUPABASE_KEY, CLOUD_BUCKET } from './cloud-config.js';

export function storageName(name, now = Date.now()) {
  const clean = String(name).normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '').slice(-120) || 'file';
  return `${now}-${clean}`;
}
export const displayName = objectName => String(objectName).replace(/^\d{10,}-/, '');

export function createCloud({ fetch: fetcher, url = SUPABASE_URL, key = SUPABASE_KEY, bucket = CLOUD_BUCKET } = {}) {
  const headers = extra => ({ apikey: key, Authorization: `Bearer ${key}`, ...extra });
  const path = name => String(name).split('/').map(encodeURIComponent).join('/');
  async function check(response, action) {
    if (response.ok) return response;
    let detail = '';
    try { const body = await response.json(); detail = body.message || body.error || ''; } catch {}
    if (/bucket not found/i.test(detail)) throw new Error(`Cloud storage "${bucket}" does not exist yet. Run supabase/setup.sql in the Supabase SQL editor.`);
    if (response.status === 401 || response.status === 403 || /row-level security|unauthorized/i.test(detail)) throw new Error(`Cloud ${action} was refused. Run supabase/setup.sql to add the storage policies.`);
    throw new Error(`Cloud ${action} failed (${response.status}${detail ? `: ${detail}` : ''}).`);
  }
  async function request(target, options, action) {
    let response;
    try { response = await fetcher(target, options); }
    catch { throw new Error(`Cloud ${action} failed. Check the internet connection.`); }
    return check(response, action);
  }
  return {
    available: typeof fetcher === 'function',
    publicUrl: name => `${url}/storage/v1/object/public/${bucket}/${path(name)}`,
    async list() {
      const response = await request(`${url}/storage/v1/object/list/${bucket}`, {
        method: 'POST', headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefix: '', limit: 100, offset: 0, sortBy: { column: 'created_at', order: 'desc' } })
      }, 'listing');
      const rows = await response.json();
      return (Array.isArray(rows) ? rows : [])
        .filter(row => row && row.id && typeof row.name === 'string' && !row.name.startsWith('.'))
        .map(row => ({ name: row.name, label: displayName(row.name), size: row.metadata?.size ?? null, created: row.created_at ?? null }));
    },
    async upload(file, now) {
      const name = storageName(file.name, now);
      await request(`${url}/storage/v1/object/${bucket}/${path(name)}`, {
        method: 'POST', headers: headers({ 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false' }), body: file
      }, 'upload');
      return { name, label: displayName(name) };
    },
    async download(name) {
      const response = await request(`${url}/storage/v1/object/public/${bucket}/${path(name)}`, {}, 'download');
      return response.arrayBuffer();
    }
  };
}
