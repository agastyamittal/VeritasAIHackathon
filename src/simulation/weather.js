// Design-day weather from the user's conditions: hourly outdoor temperature and clear-sky sunshine on each
// facade. Sun position from latitude and day of year; clear-sky beam and diffuse sunlight from the ASHRAE
// clear-sky model (Handbook of Fundamentals, monthly A/B/C coefficients). Clouds are not modelled.

const DAYS = { winter: 15, mild: 105, summer: 196 }; // mid-January, mid-April, mid-July
const SWING = { winter: 3, mild: 4, summer: 5 }; // half the day-night temperature range, K
// ASHRAE clear-sky coefficients for Jan, Apr, Jul: apparent extraterrestrial irradiance A (W/m2),
// optical depth B, diffuse factor C.
const SKY = { winter: [1230, 0.142, 0.058], mild: [1166, 0.177, 0.097], summer: [1085, 0.207, 0.136] };
// Facade azimuths, degrees from south, west positive. North of the house is -z.
export const FACADE_AZIMUTH = Object.freeze({ south: 0, west: 90, north: 180, east: -90 });
const rad = d => d * Math.PI / 180;

export function sunPosition(latitude, dayOfYear, hour) {
  const declination = rad(23.45 * Math.sin(2 * Math.PI * (284 + dayOfYear) / 365));
  const hourAngle = rad(15 * (hour - 12));
  const lat = rad(latitude);
  const sinAlt = Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const azimuth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat));
  return { altitude, azimuth };
}

// Sunlight (W/m2) on a vertical facade or the horizontal roof at one moment.
export function irradiance(sky, sun, surface) {
  if (sun.altitude <= 0) return 0;
  const [A, B, C] = sky;
  const beam = A * Math.exp(-B / Math.sin(sun.altitude));
  const diffuseHorizontal = C * beam;
  const globalHorizontal = beam * Math.sin(sun.altitude) + diffuseHorizontal;
  if (surface === 'roof') return globalHorizontal;
  const cosIncidence = Math.cos(sun.altitude) * Math.cos(sun.azimuth - rad(FACADE_AZIMUTH[surface]));
  return beam * Math.max(0, cosIncidence) + diffuseHorizontal * 0.5 + 0.2 * globalHorizontal * 0.5;
}

// conditions: from src/conditions.js (season, temperature = daily mean, wind, windSpeed).
export function designDay(conditions, { latitude = 45 } = {}) {
  const season = Object.hasOwn(DAYS, conditions.season) ? conditions.season : conditions.temperature >= 24 ? 'summer' : conditions.temperature <= 8 ? 'winter' : 'mild';
  const dayOfYear = latitude >= 0 ? DAYS[season] : (DAYS[season] + 182) % 365; // southern hemisphere: opposite season
  const sky = SKY[season];
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const sun = sunPosition(latitude, dayOfYear, hour + 0.5);
    const solar = Object.fromEntries(['north', 'east', 'south', 'west', 'roof'].map(s => [s, irradiance(sky, sun, s)]));
    // Coldest near 05:00, warmest near 15:00.
    const outdoor = conditions.temperature + SWING[season] * Math.cos(2 * Math.PI * (hour + 0.5 - 15) / 24);
    return { hour, outdoor, solar, sunAltitude: sun.altitude * 180 / Math.PI };
  });
  return {
    season, dayOfYear, latitude, wind: conditions.wind, windSpeed: conditions.windSpeed, meanOutdoor: conditions.temperature, hours,
    assumptions: [
      `Clear-sky design day (day ${dayOfYear}) at latitude ${latitude}°, ASHRAE clear-sky sunlight`,
      `Outdoor temperature ${conditions.temperature} °C daily mean, ±${SWING[season]} K day-night swing`,
      `Wind ${conditions.windSpeed} m/s from ${conditions.wind}, used for air leakage only`
    ]
  };
}

// Linear interpolation inside the day (t in hours, wraps at 24).
export function weatherAt(day, t) {
  const h = ((t % 24) + 24) % 24, i = Math.floor(h - 0.5 + 24) % 24, j = (i + 1) % 24;
  const f = ((h - 0.5) - Math.floor(h - 0.5) + 1) % 1;
  const a = day.hours[i], b = day.hours[j];
  const solar = {};
  for (const k of Object.keys(a.solar)) solar[k] = a.solar[k] + (b.solar[k] - a.solar[k]) * f;
  return { outdoor: a.outdoor + (b.outdoor - a.outdoor) * f, solar };
}
