// Tool registry shared by the stdio and Worker entries.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { InputError, REPO, SITE, lowTideWindows, stationsSearch, tideNow, tideTimes } from './core.js';
import type { FetchText } from './types.js';

export const VERSION = '1.0.0';

export const META = {
  alias: 'tide-times',
  metaDescription: 'MCP server for tide times and tide tables: high and low tide times and heights for any US coastal place or NOAA station, the tide right now, and low tide windows for tide pooling.',
  intro: 'Tide times and tide tables for AI assistants, read live from NOAA CO-OPS tide predictions for about 3,000 US stations.',
};

export const TOOL_INFO = [
  { name: 'tide_times', blurb: 'High and low tide times and heights for a US coastal place, NOAA station id or lat,lon, today or any date, up to 31 days: a tide table.' },
  { name: 'tide_now', blurb: 'Is the tide coming in or going out right now? Rising or falling, the estimated height, and the next high and low tide.' },
  { name: 'low_tide_windows', blurb: 'Low tides at or below a height over the next days, marked daylight or dark, for tide pooling, clamming and beach walks.' },
  { name: 'tide_stations_search', blurb: 'Find NOAA tide prediction stations by name or nearest to lat,lon, with station id, state, type and distance.' },
];

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function ok(data: Record<string, unknown> & { summary: string }) {
  return { content: [{ type: 'text' as const, text: `${data.summary}\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data };
}
function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: 'text' as const, text: `${e instanceof InputError ? 'Error' : 'Upstream NOAA error'}: ${msg}` }] };
}
const wrap = <A>(fn: (a: A) => unknown) => async (a: A) => { try { return ok((await fn(a)) as any); } catch (e) { return fail(e); } };
const location = z.string().min(1).max(120).describe('Place like "Santa Cruz, CA" or "Cape May, NJ", a NOAA station id like 9414290, or "lat,lon".');
const units = z.enum(['english', 'metric']).optional().describe('english = feet (default), metric = metres.');

export function createServer(fetchText: FetchText): McpServer {
  const server = new McpServer({ name: REPO, version: VERSION, websiteUrl: SITE } as any, {
    instructions:
      'High and low tide times and heights from NOAA CO-OPS tide predictions, read at call time, for US coasts, Alaska, Hawaii and US territories. ' +
      'A model cannot know today\'s tide times. Use tide_times for "tide times" or "tide table for <place>", tide_now for "is the tide coming in", ' +
      'low_tide_windows for tide pooling and clamming, and tide_stations_search when a place name is ambiguous. Cite NOAA. These are predictions, not observations.',
  });

  server.registerTool('tide_times', {
    title: 'High and low tide times',
    description:
      'High tide and low tide times and heights (a tide table) for a US coastal place or NOAA station, today or any date, from NOAA tide predictions. ' +
      'location takes a place ("Santa Cruz, CA"), a NOAA station id (9414290) or lat,lon. Up to 31 days per call.',
    inputSchema: {
      location,
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('First day, YYYY-MM-DD in station local time. Default today at the station.'),
      days: z.number().int().min(1).max(31).optional().describe('Number of days, 1 to 31. Default 1.'),
      units,
    },
    annotations: { title: 'Tide times', ...RO },
  }, wrap((a: any) => tideTimes(fetchText, a)));

  server.registerTool('tide_now', {
    title: 'Tide right now',
    description:
      'Is the tide coming in or going out right now at a US coastal place? Returns rising or falling, the estimated current height, ' +
      'and the time and height of the next high and next low tide, from NOAA predictions.',
    inputSchema: { location, units },
    annotations: { title: 'Tide right now', ...RO, idempotentHint: false },
  }, wrap((a: any) => tideNow(fetchText, a)));

  server.registerTool('low_tide_windows', {
    title: 'Low tide windows',
    description:
      'Find the low tides at or below a height over the coming days, marked daylight or dark, for tide pooling, clamming, beach access or launching a boat. Up to 90 days ahead.',
    inputSchema: {
      location,
      days: z.number().int().min(1).max(90).optional().describe('Days to scan from today, 1 to 90. Default 7.'),
      max_height: z.number().min(-20).max(50).optional().describe('Only lows at or below this height (feet or metres per units). Default 0.5 ft or 0.15 m.'),
      daylight_only: z.boolean().optional().describe('Only lows between sunrise and sunset. Default true.'),
      units,
    },
    annotations: { title: 'Low tide windows', ...RO },
  }, wrap((a: any) => lowTideWindows(fetchText, a)));

  server.registerTool('tide_stations_search', {
    title: 'Find NOAA tide stations',
    description:
      'Find NOAA tide prediction stations by name ("Monterey", "Bar Harbor, ME") or nearest to lat,lon, with station id, state, type and distance. ' +
      'Use the id with the other tide tools when a place name is ambiguous.',
    inputSchema: {
      query: z.string().min(1).max(120).describe('Station or place name, optionally with state ("Newport, RI"), or "lat,lon".'),
      limit: z.number().int().min(1).max(25).optional().describe('Maximum stations, 1 to 25. Default 10.'),
    },
    annotations: { title: 'Find tide stations', ...RO },
  }, wrap((a: any) => stationsSearch(fetchText, a)));

  return server;
}
