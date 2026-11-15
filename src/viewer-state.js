// Matches the Supabase free-plan upload limit and the bucket limit in supabase/setup.sql.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Any file type may be shared through the cloud; only STL and OBJ get a 3D preview (src/mesh.js).
export function validateDesign(file) {
  if (!file) return { error: 'Choose a file.' };
  if (file.size === 0) return { error: 'This file is empty. Choose another file.' };
  if (file.size > MAX_UPLOAD_BYTES) return { error: 'Choose a file smaller than 50 MB.' };
  return { file, name: file.name };
}

export function eyeLayout(width, height) {
  const w = Math.max(2, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const half = Math.floor(w / 2);
  return { width: w, height: h, left: [0, 0, half, h], right: [half, 0, w - half, h], aspect: w / h, stereoAspect: 0.5 };
}

export function createViewerState(onChange = () => {}) {
  let state = { view: 'interior', floor: 'all', layer: 'architecture', vr: false };
  return {
    get: () => ({ ...state }),
    set(key, value) {
      const choices = { view: ['interior', 'exterior'], floor: ['all', '1', '2'], layer: ['architecture', 'airflow', 'thermal', 'heatloss'], vr: [true, false] };
      if (!choices[key]?.includes(value)) throw new Error(`Invalid ${key}: ${value}`);
      state = { ...state, [key]: value };
      onChange({ ...state }, key);
    }
  };
}
