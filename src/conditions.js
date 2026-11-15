// Weather / simulation conditions chosen by the user: the design-day inputs for the simplified heat balance
// (src/simulation), the EnergyPlus adapter and the EnergyPlus-trained surrogate (see src/contracts/README.md).
export const SEASONS = Object.freeze({
  summer: { label: 'Summer heat', temperature: 32, wind: 'S', windSpeed: 3 },
  mild: { label: 'Mild', temperature: 18, wind: 'W', windSpeed: 4 },
  winter: { label: 'Winter cold', temperature: -5, wind: 'N', windSpeed: 6 }
});
export const WIND_DIRECTIONS = Object.freeze(['N', 'E', 'S', 'W']);
const LIMITS = { temperature: [-20, 45], windSpeed: [0, 15] };
export const DEFAULT_CONDITIONS = Object.freeze({ season: 'mild', ...pick(SEASONS.mild) });

function pick({ temperature, wind, windSpeed }) { return { temperature, wind, windSpeed }; }
const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value));

export function normalizeConditions(value = {}) {
  const empty = !value || typeof value !== 'object' || Object.keys(value).length === 0;
  const season = empty ? DEFAULT_CONDITIONS.season : Object.hasOwn(SEASONS, value.season) ? value.season : 'custom';
  const base = season === 'custom' ? DEFAULT_CONDITIONS : SEASONS[season];
  return {
    season,
    temperature: Number.isFinite(value?.temperature) ? Math.round(clamp(value.temperature, LIMITS.temperature)) : base.temperature,
    wind: WIND_DIRECTIONS.includes(value?.wind) ? value.wind : base.wind,
    windSpeed: Number.isFinite(value?.windSpeed) ? Math.round(clamp(value.windSpeed, LIMITS.windSpeed)) : base.windSpeed
  };
}

// Choosing a season fills its typical values; editing a value afterwards makes the set "custom".
export function applySeason(season) {
  return Object.hasOwn(SEASONS, season) ? { season, ...pick(SEASONS[season]) } : normalizeConditions(DEFAULT_CONDITIONS);
}
export function editCondition(conditions, key, value) {
  const next = normalizeConditions({ ...conditions, [key]: value });
  const preset = SEASONS[conditions.season];
  const matches = preset && next.temperature === preset.temperature && next.wind === preset.wind && next.windSpeed === preset.windSpeed;
  return { ...next, season: matches ? conditions.season : 'custom' };
}

export function describeConditions(conditions) {
  const c = normalizeConditions(conditions);
  const name = c.season === 'custom' ? 'Custom' : SEASONS[c.season].label;
  return `${name} · ${c.temperature} °C · wind ${c.wind} ${c.windSpeed} m/s`;
}
