// Fixtures in test/fixtures/ were downloaded from NOAA CO-OPS on 2026-11-14: five stations from the tide prediction station list
// (Honolulu, Cape May NJ, Santa Cruz CA, San Francisco Golden Gate, the TEC2789 Cape Hatteras tide-table station) and the
// high/low predictions for San Francisco 9414290, 2026-11-14 to 2026-11-16 in feet above MLLW, local standard time (UTC-8).
// Expected values are read off that file: High 03:56 4.39 ft, Low 08:01 3.643, High 13:34 5.201, Low 20:48 0.108, ...
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  offsetAt, localToUtc, utcToLocal, heightAt, parseStations, searchByName, nearest, tideTimes, tideNow, lowTideWindows, stationsSearch,
  InputError, UpstreamError, STATIONS_URL, UTM,
} from '../dist/core.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const STATIONS = fx('stations.json'), HILO = fx('hilo-9414290.json');
const f = async (u) => {
  if (u === STATIONS_URL) return STATIONS;
  if (u.startsWith('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?')) {
    return /station=9414290&/.test(u) ? HILO : '{"error":{"message":" No Predictions data was found."}}';
  }
  if (u.startsWith('https://geocoding-api.open-meteo.com/v1/search')) {
    const name = decodeURIComponent(/name=([^&]+)/.exec(u)[1]);
    return JSON.stringify({ results: name === 'Pacifica' ? [{ name: 'Pacifica', latitude: 37.6138, longitude: -122.4869, admin1: 'California', country_code: 'US' }] : [] });
  }
  throw new Error(`HTTP 404 (no fixture for ${u})`);
};

test('US daylight time: 2026 ends Nov 1 and starts Mar 8 at 02:00 local; Hawaii never shifts', () => {
  const sf = { id: '9414290', name: 'SF', state: 'CA', lat: 37.8, lon: -122.5, tzOffset: -8, type: 'R' };
  assert.equal(offsetAt(sf, new Date('2026-11-01T08:59:00Z')), -7);
  assert.equal(offsetAt(sf, new Date('2026-11-01T09:00:00Z')), -8);
  assert.equal(offsetAt(sf, new Date('2026-03-08T09:59:00Z')), -8);
  assert.equal(offsetAt(sf, new Date('2026-03-08T10:00:00Z')), -7);
  assert.equal(offsetAt({ ...sf, state: 'HI', tzOffset: -10 }, new Date('2026-07-01T00:00:00Z')), -10);
  assert.equal(localToUtc(sf, '2026-11-14 03:23').toISOString(), '2026-11-14T11:23:00.000Z');
  assert.equal(utcToLocal(sf, new Date('2026-07-04T19:00:00Z')), '2026-07-04 12:00');
});

test('cosine interpolation is exact at the turning points and halfway between', () => {
  const lo = { local: '', utc: new Date('2026-01-01T00:00:00Z'), height: 0, type: 'low' };
  const hi = { local: '', utc: new Date('2026-01-01T06:00:00Z'), height: 6, type: 'high' };
  assert.equal(heightAt(lo, hi, lo.utc), 0); assert.equal(heightAt(lo, hi, hi.utc), 6);
  assert.ok(Math.abs(heightAt(lo, hi, new Date('2026-01-01T03:00:00Z')) - 3) < 1e-9);
});

test('station names match with a state hint; TEC tide-table stations are kept; nearest by distance', () => {
  const list = parseStations(JSON.parse(STATIONS));
  assert.equal(list.length, 5);
  assert.equal(searchByName(list, 'Santa Cruz, CA')[0].id, '9413745');
  assert.equal(searchByName(list, 'cape may, new jersey')[0].id, '8536110');
  assert.equal(searchByName(list, 'Santa Cruz, NJ').length, 0);
  assert.ok(list.some((s) => s.id === 'TEC2789'));
  assert.equal(nearest(list, 37.81, -122.47, 1)[0].id, '9414290');
  assert.throws(() => parseStations({}), UpstreamError);
});

test('tide times for San Francisco 9414290 from 2026-11-14: Saturday, High 03:56 4.39 ft, Low 20:48 0.108 ft', async () => {
  const r = await tideTimes(f, { location: '9414290', date: '2026-11-14', days: 2 }, new Date('2026-11-14T12:00:00Z'));
  assert.equal(r.station.name, 'SAN FRANCISCO (Golden Gate)'); assert.equal(r.station.type, 'reference');
  assert.equal(r.tides.length, 12);
  assert.deepEqual(r.tides[0], { local: '2026-11-14 03:56', type: 'high', height: 4.39 });
  assert.deepEqual(r.tides[3], { local: '2026-11-14 20:48', type: 'low', height: 0.108 });
  assert.match(r.summary, /Saturday 2026-11-14/); assert.match(r.summary, /High 03:56 {2}4\.39 ft/); assert.match(r.summary, /UTC-8\./);
  assert.equal(r.to, '2026-11-15'); assert.equal(r.units, 'feet'); assert.ok(r.more.includes(UTM));
});

test('tide now at 12:00 local on 2026-11-14: rising from the 08:01 low toward the 13:34 high of 5.20 ft', async () => {
  const r = await tideNow(f, { location: 'SAN FRANCISCO' }, new Date('2026-11-14T20:00:00Z'));
  assert.equal(r.direction, 'rising'); assert.equal(r.local_time, '2026-11-14 12:00');
  assert.deepEqual(r.last_tide, { type: 'low', local: '2026-11-14 08:01', height: 3.643 });
  assert.deepEqual(r.next_high, { local: '2026-11-14 13:34', height: 5.201 });
  assert.deepEqual(r.next_low, { local: '2026-11-14 20:48', height: 0.108 });
  assert.ok(r.estimated_height > 4.8 && r.estimated_height < 5.0, String(r.estimated_height));
  assert.match(r.summary, /RISING \(coming in\)/); assert.match(r.summary, /3 h 59 min ago/);
});

test('low tide windows: no daylight low under 0.5 ft (best 3.37 at 10:38), two after dark at 0.108 and 0.313', async () => {
  const now = new Date('2026-11-14T00:00:00Z');
  const d = await lowTideWindows(f, { location: '9414290', days: 3 }, now);
  assert.equal(d.windows.length, 0); assert.equal(d.lows_scanned, 6);
  assert.deepEqual(d.lowest_eligible, { local: '2026-11-16 10:38', height: 3.371, light: 'daylight' });
  const n = await lowTideWindows(f, { location: '9414290', days: 3, daylight_only: false }, now);
  assert.deepEqual(n.windows.map((w) => [w.local, w.height, w.light]), [['2026-11-14 20:48', 0.108, 'dark'], ['2026-11-15 21:39', 0.313, 'dark']]);
});

test('station search: by name, by lat,lon and by a geocoded place name', async () => {
  assert.equal((await stationsSearch(f, { query: 'Santa Cruz' })).stations[0].id, '9413745');
  const ll = await stationsSearch(f, { query: '37.81,-122.47', limit: 2 });
  assert.equal(ll.stations[0].id, '9414290'); assert.equal(ll.stations.length, 2);
  const g = await tideTimes(f, { location: 'Pacifica, CA', date: '2026-11-14' });
  assert.equal(g.station.id, '9414290'); assert.match(g.station.matched_by, /nearest station to Pacifica, California, US/); assert.ok(g.station.km_away > 20 && g.station.km_away < 25);
});

test('errors: unknown station id and bad input are input errors; a NOAA error message is an upstream error', async () => {
  await assert.rejects(tideTimes(f, { location: '1234567' }), InputError);
  await assert.rejects(tideTimes(f, { location: 'Atlantis Deep' }), InputError);
  await assert.rejects(tideTimes(f, { location: '9414290', date: '14/11/2026' }), InputError);
  await assert.rejects(tideTimes(f, { location: '9414290', days: 40 }), InputError);
  await assert.rejects(tideTimes(f, { location: '9414290', units: 'feet' }), InputError);
  await assert.rejects(tideTimes(f, { location: '8536110', date: '2026-11-14' }), /No Predictions data was found/);
});

test('stdio: initialize, tools/list with annotations and a tools/call error over JSON-RPC (offline)', async () => {
  const child = spawn(process.execPath, [new URL('../dist/stdio.js', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = []; let buf = '';
  const got = (id) => new Promise((res) => { const iv = setInterval(() => { const m = lines.find((l) => l.id === id); if (m) { clearInterval(iv); res(m); } }, 10); });
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal((await got(1)).result.serverInfo.name, 'tide-times-tide-tables-mcp');
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  const tools = (await got(2)).result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['tide_times', 'tide_now', 'low_tide_windows', 'tide_stations_search']);
  for (const t of tools) { assert.ok(t.title); assert.equal(t.annotations.readOnlyHint, true); assert.equal(t.annotations.destructiveHint, false); assert.equal(t.annotations.openWorldHint, true); }
  send({ id: 3, method: 'tools/call', params: { name: 'tide_times', arguments: { location: '9414290', days: 99 } } });
  const r3 = await got(3);
  child.kill();
  assert.equal(r3.result?.isError ?? Boolean(r3.error), true);
});
