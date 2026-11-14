// Pure core for tide-times-tide-tables-mcp. The only I/O is keyless reads of NOAA CO-OPS (the station list and high/low tide
// predictions) and Open-Meteo geocoding (place name to lat/lon only), done through an injected fetchText.
//
// Sources (public, no key):
//   stations    https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions
//   predictions https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&interval=hilo
//   geocoding   https://geocoding-api.open-meteo.com/v1/search
import type { FetchText } from './types.js';

export const REPO = 'tide-times-tide-tables-mcp';
export const SITE = 'https://www.mcpstamp.com';
export const UTM = `utm_source=mcp&utm_medium=${REPO}`;
export const more = () => `${SITE}/servers/?${UTM}`;

export const NOAA = 'https://api.tidesandcurrents.noaa.gov';
export const GEO = 'https://geocoding-api.open-meteo.com';
export const STATIONS_URL = `${NOAA}/mdapi/prod/webapi/stations.json?type=tidepredictions`;
export const SOURCE = 'NOAA CO-OPS tide predictions (tidesandcurrents.noaa.gov). Predictions, not observed water levels; wind and pressure move the real tide.';

export class InputError extends Error {}
export class UpstreamError extends Error {}

async function getJson<T = unknown>(f: FetchText, url: string, cacheTtl: number, timeoutMs = 20000): Promise<T> {
  const body = await f(url, { cacheTtl, timeoutMs, accept: 'application/json' });
  try { return JSON.parse(body) as T; } catch { throw new UpstreamError(`${new URL(url).host} returned something that is not JSON`); }
}

export interface Station {
  id: string; name: string; state: string; lat: number; lon: number;
  /** Hours from UTC in local standard time, as NOAA publishes it (timezonecorr). */
  tzOffset: number;
  /** R = harmonic reference station, S = subordinate (offsets from a reference). */
  type: string;
}

export interface Tide {
  /** Station-local wall-clock time exactly as NOAA printed it (LST/LDT), "YYYY-MM-DD HH:MM". */
  local: string;
  utc: Date;
  height: number;
  type: 'high' | 'low';
}

/** US states and territories inside the -5..-9 offsets that do not observe daylight saving time. */
const NO_DST = new Set(['HI', 'PR', 'VI', 'AS', 'GU', 'MP', 'UM']);

/**
 * NOAA's station list leaves observedst empty, so it is derived: Alaska observes US daylight time, and so does every station at a
 * US mainland offset (-5 to -9). Hawaii, the Caribbean territories and Pacific islands do not. NOAA prints every tide time in
 * station local time itself; this only decides "today" and "now".
 */
export function observesDst(s: Station): boolean {
  const st = s.state.toUpperCase();
  if (st === 'AK') return true;
  return !NO_DST.has(st) && s.tzOffset >= -9 && s.tzOffset <= -5;
}

function nthSunday(year: number, month: number, n: number): number {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return Date.UTC(year, month, 1 + ((7 - first) % 7) + (n - 1) * 7);
}

/** The station's UTC offset in hours at an instant (US rule: second Sunday of March to first Sunday of November). */
export function offsetAt(s: Station, at: Date): number {
  if (!observesDst(s)) return s.tzOffset;
  const y = at.getUTCFullYear();
  const start = nthSunday(y, 2, 2) + (2 - s.tzOffset) * 3600000;
  const end = nthSunday(y, 10, 1) + (1 - s.tzOffset) * 3600000;
  const t = at.getTime();
  return t >= start && t < end ? s.tzOffset + 1 : s.tzOffset;
}

export function localToUtc(s: Station, local: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(local);
  if (!m) throw new UpstreamError(`unreadable NOAA time "${local}"`);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let utc = wall - s.tzOffset * 3600000;
  utc = wall - offsetAt(s, new Date(utc)) * 3600000;
  return new Date(utc);
}

export function utcToLocal(s: Station, at: Date): string {
  return new Date(at.getTime() + offsetAt(s, at) * 3600000).toISOString().slice(0, 16).replace('T', ' ');
}
export const localDate = (s: Station, at: Date) => utcToLocal(s, at).slice(0, 10);

export function tzLabel(s: Station, at: Date): string {
  const o = offsetAt(s, at);
  return `UTC${o >= 0 ? '+' : ''}${o}${observesDst(s) && o !== s.tzOffset ? ' (daylight time)' : ''}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function parseStations(j: unknown): Station[] {
  const list = (j as { stations?: Record<string, unknown>[] })?.stations;
  if (!Array.isArray(list)) throw new UpstreamError('NOAA station list had no stations array');
  return list
    .map((s) => ({
      id: String(s.id ?? ''), name: String(s.name ?? '').trim(), state: String(s.state ?? ''),
      lat: Number(s.lat), lon: Number(s.lng), tzOffset: Number(s.timezonecorr ?? 0), type: String(s.type ?? ''),
    }))
    .filter((s) => /^[A-Z0-9]{7}$/.test(s.id) && Number.isFinite(s.lat) && Number.isFinite(s.lon));
}

// The station list is about 2 MB of JSON; parse it once a day per process or Worker isolate.
let STATIONS: { at: number; f: FetchText; list: Station[] } | null = null;
export async function stations(f: FetchText): Promise<Station[]> {
  if (STATIONS && STATIONS.f === f && Date.now() - STATIONS.at < 86400000) return STATIONS.list;
  const list = parseStations(await getJson(f, STATIONS_URL, 86400, 30000));
  STATIONS = { at: Date.now(), f, list };
  return list;
}

export function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function nearest(list: Station[], lat: number, lon: number, n: number): (Station & { km: number })[] {
  return list.map((s) => ({ ...s, km: km(lat, lon, s.lat, s.lon) })).sort((a, b) => a.km - b.km).slice(0, n);
}

const STATE_NAMES: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', CA: 'california', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia',
  HI: 'hawaii', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MS: 'mississippi',
  NH: 'new hampshire', NJ: 'new jersey', NY: 'new york', NC: 'north carolina', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode island', SC: 'south carolina', TX: 'texas', VA: 'virginia', WA: 'washington', DC: 'district of columbia',
  PR: 'puerto rico', VI: 'virgin islands', GU: 'guam', AS: 'american samoa', MP: 'northern mariana islands',
};

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Split "Santa Cruz, CA" into the place words and a state hint (two-letter code), if any. */
export function splitPlace(q: string): { words: string; state?: string } {
  const parts = q.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return { words: q.trim() };
  const tail = parts[parts.length - 1];
  const code = tail.toUpperCase();
  if (STATE_NAMES[code]) return { words: parts.slice(0, -1).join(' '), state: code };
  const byName = Object.entries(STATE_NAMES).find(([, n]) => n === norm(tail));
  if (byName) return { words: parts.slice(0, -1).join(' '), state: byName[0] };
  return { words: parts.join(' ') };
}

/** Stations whose NOAA name contains every word of the query, best first. */
export function searchByName(list: Station[], query: string): Station[] {
  const { words, state } = splitPlace(query);
  const q = norm(words);
  if (!q) return [];
  const tokens = q.split(' ');
  const hits = list.filter((s) => {
    if (state && s.state.toUpperCase() !== state) return false;
    const n = norm(s.name);
    return tokens.every((t) => new RegExp(`\\b${t}`).test(n));
  });
  const score = (s: Station) => { const n = norm(s.name); return (n === q ? 0 : n.startsWith(q) ? 1 : 2) * 10 + (s.type === 'R' ? 0 : 1); };
  return hits.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}

interface GeoHit { name: string; latitude: number; longitude: number; country_code?: string; admin1?: string }

export async function geocode(f: FetchText, query: string): Promise<GeoHit | null> {
  const { words, state } = splitPlace(query);
  const url = `${GEO}/v1/search?name=${encodeURIComponent(words)}&count=10&language=en&format=json`;
  const j = await getJson<{ results?: GeoHit[] }>(f, url, 86400, 15000);
  const results = j.results ?? [];
  if (state) {
    const hit = results.find((r) => r.country_code === 'US' && norm(r.admin1 ?? '') === STATE_NAMES[state]);
    if (hit) return hit;
  }
  return results.find((r) => r.country_code === 'US') ?? results[0] ?? null;
}

export interface Resolved { station: Station; how: string; km?: number }

/** Station id, "lat,lon", NOAA station name, or any place name (geocoded, then nearest station). */
export async function resolveStation(f: FetchText, input: string): Promise<Resolved> {
  const q = String(input ?? '').trim();
  if (!q) throw new InputError('give a station id, a place name or lat,lon');
  const list = await stations(f);
  if (/^(\d{7}|TEC\d{4})$/i.test(q)) {
    const s = list.find((x) => x.id === q.toUpperCase());
    if (!s) throw new InputError(`${q} is not a NOAA tide prediction station; search with tide_stations_search`);
    return { station: s, how: 'station id' };
  }
  const ll = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q);
  if (ll) {
    if (Math.abs(+ll[1]) > 90 || Math.abs(+ll[2]) > 180) throw new InputError('lat,lon out of range');
    const [s] = nearest(list, +ll[1], +ll[2], 1);
    return { station: s, how: `nearest station to ${ll[1]},${ll[2]}`, km: s.km };
  }
  const named = searchByName(list, q);
  if (named.length) return { station: named[0], how: `station name match for "${q}"` };
  const g = await geocode(f, q);
  if (!g) throw new InputError(`no place or station called "${q}" was found; try "City, ST" or lat,lon`);
  const [s] = nearest(list, g.latitude, g.longitude, 1);
  const where = [g.name, g.admin1, g.country_code].filter(Boolean).join(', ');
  return { station: s, how: `nearest station to ${where} (${g.latitude.toFixed(3)},${g.longitude.toFixed(3)})`, km: s.km };
}

export function parsePredictions(s: Station, j: unknown): Tide[] {
  const o = j as { predictions?: { t: string; v: string; type: string }[]; error?: { message?: string } };
  if (o?.error) throw new UpstreamError(`NOAA: ${String(o.error.message ?? 'error').trim()}`);
  if (!Array.isArray(o?.predictions)) throw new UpstreamError('NOAA returned no predictions');
  return o.predictions.map((p) => ({ local: p.t, utc: localToUtc(s, p.t), height: Number(p.v), type: p.type === 'H' ? 'high' : 'low' }));
}

export const hiloUrl = (s: Station, from: string, to: string, units: string) =>
  `${NOAA}/api/prod/datagetter?product=predictions&application=${REPO}&station=${s.id}` +
  `&begin_date=${from.replace(/-/g, '')}&end_date=${to.replace(/-/g, '')}&datum=MLLW&interval=hilo&units=${units}&time_zone=lst_ldt&format=json`;

/** High/low predictions for local dates [from, to] inclusive. */
export async function hilo(f: FetchText, s: Station, from: string, to: string, units: Units): Promise<Tide[]> {
  return parsePredictions(s, await getJson(f, hiloUrl(s, from, to, units), 21600, 20000));
}

/** Height between two turning points by the cosine curve navigators use (a smooth rule of twelfths). */
export function heightAt(prev: Tide, next: Tide, at: Date): number {
  const span = next.utc.getTime() - prev.utc.getTime();
  const k = span > 0 ? Math.min(1, Math.max(0, (at.getTime() - prev.utc.getTime()) / span)) : 0;
  return prev.height + (next.height - prev.height) * (1 - Math.cos(Math.PI * k)) / 2;
}

export function bracket(tides: Tide[], at: Date): { prev: Tide; next: Tide } | null {
  for (let i = 0; i + 1 < tides.length; i++) if (tides[i].utc <= at && tides[i + 1].utc > at) return { prev: tides[i], next: tides[i + 1] };
  return null;
}

export function fmtDuration(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}

/** Sun altitude in degrees (low-precision solar position). Used only to label a low tide as daylight or dark. */
export function sunAltitude(lat: number, lon: number, at: Date): number {
  const r = Math.PI / 180;
  const d = at.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * r;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * r;
  const e = (23.439 - 0.00000036 * d) * r;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const lha = (gmst * 15 + lon) * r - ra;
  return Math.asin(Math.sin(lat * r) * Math.sin(dec) + Math.cos(lat * r) * Math.cos(dec) * Math.cos(lha)) / r;
}

export type Units = 'english' | 'metric';
const unitLabel = (u: Units) => (u === 'metric' ? 'm' : 'ft');
const fmtH = (h: number, u: Units) => `${h.toFixed(2)} ${unitLabel(u)}`;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function units(u: unknown): Units {
  if (u === undefined || u === null || u === '') return 'english';
  if (u === 'english' || u === 'metric') return u;
  throw new InputError('units must be english (feet) or metric (metres)');
}

function stationInfo(r: Resolved, now: Date) {
  const s = r.station;
  return {
    lines: [
      `Station: ${s.name}${s.state ? `, ${s.state}` : ''} (NOAA ${s.id}, ${s.type === 'R' ? 'reference' : 'subordinate'} station)`,
      `Matched by: ${r.how}${r.km !== undefined ? `, ${r.km.toFixed(1)} km away` : ''}`,
      `Times: station local, ${tzLabel(s, now)}. Heights above MLLW (mean lower low water).`,
    ],
    station: { id: s.id, name: s.name, state: s.state || null, type: s.type === 'R' ? 'reference' : 'subordinate', lat: s.lat, lon: s.lon, matched_by: r.how, km_away: r.km === undefined ? null : Number(r.km.toFixed(1)) },
    timezone: tzLabel(s, now),
  };
}
const base = (now: Date, u: Units) => ({ units: u === 'metric' ? 'metres' : 'feet', datum: 'MLLW', as_of: now.toISOString(), source: SOURCE, more: more() });

export async function tideTimes(f: FetchText, a: { location: string; date?: string; days?: number; units?: Units }, now = new Date()) {
  const n = a.days ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > 31) throw new InputError('days must be 1 to 31');
  const u = units(a.units);
  if (a.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(a.date)) throw new InputError('date must be YYYY-MM-DD');
  const r = await resolveStation(f, a.location);
  const from = a.date ?? localDate(r.station, now);
  const to = addDays(from, n - 1);
  const tides = await hilo(f, r.station, from, to, u);
  const info = stationInfo(r, now);
  const lines = [...info.lines];
  let day = '';
  for (const t of tides) {
    const d = t.local.slice(0, 10);
    if (d !== day) {
      day = d;
      lines.push('', `${new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} ${d}`);
    }
    lines.push(`  ${t.type === 'high' ? 'High' : 'Low '} ${t.local.slice(11)}  ${fmtH(t.height, u)}`);
  }
  if (!tides.length) lines.push('', 'NOAA returned no high or low tides for that range.');
  return {
    summary: lines.join('\n'), station: info.station, timezone: info.timezone, from, to,
    tides: tides.map((t) => ({ local: t.local, type: t.type, height: r3(t.height) })), ...base(now, u),
  };
}

export async function tideNow(f: FetchText, a: { location: string; units?: Units }, now = new Date()) {
  const u = units(a.units);
  const r = await resolveStation(f, a.location);
  const today = localDate(r.station, now);
  const tides = await hilo(f, r.station, addDays(today, -1), addDays(today, 2), u);
  const b = bracket(tides, now);
  if (!b) throw new UpstreamError('NOAA returned too few predictions around the current time to bracket it');
  const rising = b.next.type === 'high';
  const after = tides.filter((t) => t.utc > now);
  const nextHigh = after.find((t) => t.type === 'high'), nextLow = after.find((t) => t.type === 'low');
  const height = heightAt(b.prev, b.next, now);
  const info = stationInfo(r, now);
  const lines = [
    ...info.lines, '',
    `Now (${utcToLocal(r.station, now)} local): tide is ${rising ? 'RISING (coming in)' : 'FALLING (going out)'}, about ${fmtH(height, u)}`,
    `Last ${b.prev.type} tide: ${b.prev.local.slice(11)} on ${b.prev.local.slice(0, 10)}, ${fmtH(b.prev.height, u)} (${fmtDuration(now.getTime() - b.prev.utc.getTime())} ago)`,
  ];
  if (nextHigh) lines.push(`Next high tide: ${nextHigh.local}, ${fmtH(nextHigh.height, u)} (in ${fmtDuration(nextHigh.utc.getTime() - now.getTime())})`);
  if (nextLow) lines.push(`Next low tide: ${nextLow.local}, ${fmtH(nextLow.height, u)} (in ${fmtDuration(nextLow.utc.getTime() - now.getTime())})`);
  lines.push('', 'Current height is interpolated between NOAA\'s predicted high and low (cosine curve).');
  const tide = (t?: Tide) => (t ? { local: t.local, height: r3(t.height) } : null);
  return {
    summary: lines.join('\n'), station: info.station, timezone: info.timezone, local_time: utcToLocal(r.station, now),
    direction: rising ? 'rising' : 'falling', estimated_height: r3(height),
    last_tide: { type: b.prev.type, ...tide(b.prev)! }, next_high: tide(nextHigh), next_low: tide(nextLow), ...base(now, u),
  };
}

export async function lowTideWindows(f: FetchText, a: { location: string; days?: number; max_height?: number; daylight_only?: boolean; units?: Units }, now = new Date()) {
  const n = a.days ?? 7;
  if (!Number.isInteger(n) || n < 1 || n > 90) throw new InputError('days must be 1 to 90');
  const u = units(a.units);
  const limit = a.max_height ?? (u === 'metric' ? 0.15 : 0.5);
  const dayOnly = a.daylight_only ?? true;
  const r = await resolveStation(f, a.location);
  const today = localDate(r.station, now);
  const tides = await hilo(f, r.station, today, addDays(today, n - 1), u);
  const lows = tides.filter((t) => t.type === 'low' && t.utc > now);
  const tagged = lows.map((t) => ({ t, day: sunAltitude(r.station.lat, r.station.lon, t.utc) > -0.833 }));
  const hits = tagged.filter((x) => x.t.height <= limit && (!dayOnly || x.day)).sort((x, y) => x.t.height - y.t.height);
  const info = stationInfo(r, now);
  const lines = [...info.lines, '', `Low tides at or below ${fmtH(limit, u)}${dayOnly ? ' in daylight' : ''}, next ${n} day(s): ${hits.length} of ${lows.length} lows`];
  for (const { t, day } of hits) lines.push(`  ${t.local}  ${fmtH(t.height, u)}  ${day ? 'daylight' : 'dark'}`);
  const best = tagged.filter((x) => !dayOnly || x.day).sort((x, y) => x.t.height - y.t.height)[0];
  if (!hits.length && best) lines.push(`  none; the lowest ${dayOnly ? 'daylight ' : ''}low is ${best.t.local} at ${fmtH(best.t.height, u)}`);
  lines.push('', 'Sorted lowest first. Daylight = sun above the horizon at the time of the low.');
  return {
    summary: lines.join('\n'), station: info.station, timezone: info.timezone, max_height: limit, daylight_only: dayOnly, days: n,
    lows_scanned: lows.length, windows: hits.map(({ t, day }) => ({ local: t.local, height: r3(t.height), light: day ? 'daylight' : 'dark' })),
    lowest_eligible: best ? { local: best.t.local, height: r3(best.t.height), light: best.day ? 'daylight' : 'dark' } : null, ...base(now, u),
  };
}

export async function stationsSearch(f: FetchText, a: { query: string; limit?: number }, now = new Date()) {
  const k = a.limit ?? 10;
  if (!Number.isInteger(k) || k < 1 || k > 25) throw new InputError('limit must be 1 to 25');
  const q = String(a.query ?? '').trim();
  if (!q) throw new InputError('give a station or place name, or lat,lon');
  const list = await stations(f);
  const ll = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q);
  let rows: { s: Station; km?: number }[];
  let how: string;
  if (ll) {
    rows = nearest(list, +ll[1], +ll[2], k).map((s) => ({ s, km: s.km }));
    how = `nearest to ${ll[1]},${ll[2]}`;
  } else {
    const named = searchByName(list, q);
    if (named.length) {
      rows = named.slice(0, k).map((s) => ({ s }));
      how = `name contains "${q}" (${named.length} match${named.length === 1 ? '' : 'es'})`;
    } else {
      const r = await resolveStation(f, q);
      rows = nearest(list, r.station.lat, r.station.lon, k).map((s) => ({ s, km: s.km }));
      how = `no station name matched; ${r.how}`;
    }
  }
  const lines = [`${list.length} NOAA tide prediction stations. Showing ${rows.length}, ${how}:`];
  for (const { s, km: d } of rows) {
    lines.push(`  ${s.id}  ${s.name}${s.state ? `, ${s.state}` : ''}  [${s.type === 'R' ? 'reference' : 'subordinate'}]  ${s.lat.toFixed(3)},${s.lon.toFixed(3)}${d !== undefined ? `  ${d.toFixed(1)} km` : ''}`);
  }
  return {
    summary: lines.join('\n'), total_stations: list.length, matched_by: how,
    stations: rows.map(({ s, km: d }) => ({ id: s.id, name: s.name, state: s.state || null, type: s.type === 'R' ? 'reference' : 'subordinate', lat: s.lat, lon: s.lon, km_away: d === undefined ? null : Number(d.toFixed(1)) })),
    as_of: now.toISOString(), source: SOURCE, more: more(),
  };
}
