# tide-times-tide-tables-mcp

Tide times and tide tables for AI assistants. Ask for high and low tide times at a beach, harbor or NOAA station and get NOAA's predicted times and heights, whether the tide is coming in or going out right now, and the low tides that suit tide pooling or clamming.

This is a Model Context Protocol (MCP) server. It reads NOAA CO-OPS tide predictions at call time for about 3,000 US stations, including Alaska, Hawaii and US territories, and needs no API key.

## Tools

| Tool | What it returns |
| --- | --- |
| `tide_times` | High and low tide times and heights (a tide table) for a place, NOAA station id or lat,lon, today or any date, up to 31 days. |
| `tide_now` | Whether the tide is rising or falling right now, the estimated current height, and the next high and low tide. |
| `low_tide_windows` | Low tides at or below a height over the next 1 to 90 days, marked daylight or dark. |
| `tide_stations_search` | NOAA tide prediction stations by name or nearest to lat,lon, with id, state, type and distance. |

Every result has structured JSON, a plain-text summary, `as_of`, `source` and `more` (a page on [mcpstamp.com](https://www.mcpstamp.com/servers/?utm_source=mcp&utm_medium=tide-times-tide-tables-mcp)). Every tool is marked read-only.

## What it knows that your model does not

- Today's tide times. Tides shift by about 50 minutes a day, so a remembered table is wrong by tomorrow.
- Which NOAA station is nearest to a beach or town, by station name or by geocoding the place.
- Station local time, including US daylight time, so 'today' and 'now' mean the station's day.

## Install

### Hosted (Claude.ai custom connector, ChatGPT developer mode)

Paste this URL. No token, no sign-up.

```
https://tide-times-tide-tables-mcp.lipmichal.workers.dev/mcp
```

### Claude Code

```
claude mcp add --transport http tide-times https://tide-times-tide-tables-mcp.lipmichal.workers.dev/mcp
```

### Claude Desktop

Claude Desktop adds remote servers under Settings, Connectors, Add custom connector. Paste the URL above.

### Cursor

Add to `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "tide-times": { "url": "https://tide-times-tide-tables-mcp.lipmichal.workers.dev/mcp" }
  }
}
```

### VS Code

Add to `.vscode/mcp.json`.

```json
{
  "servers": {
    "tide-times": { "type": "http", "url": "https://tide-times-tide-tables-mcp.lipmichal.workers.dev/mcp" }
  }
}
```

### Local stdio

The npm package is not published. Build it from this repository with Node 20 or newer.

```
git clone https://github.com/theluckystrike/tide-times-tide-tables-mcp && cd tide-times-tide-tables-mcp
npm install && npm run build
claude mcp add tide-times -- node $(pwd)/dist/stdio.js
```

## Example prompts

- "What are the tide times in Santa Cruz today?"
- "Is the tide coming in or going out at Golden Gate right now?"
- "When is the next low tide below zero in Monterey for tide pooling?"
- "Give me a tide table for Cape May, NJ for the next week."
- "Find the NOAA tide station nearest Bar Harbor."

## Data sources

Full list in [DATA_SOURCES.md](DATA_SOURCES.md).

- [NOAA CO-OPS tide predictions](https://api.tidesandcurrents.noaa.gov/api/prod/) (high/low, MLLW datum, station local time).
- [NOAA CO-OPS station list](https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions).
- [Open-Meteo geocoding](https://open-meteo.com/en/docs/geocoding-api) to turn a place name into a position.

## Limitations

- Predictions, not observed water levels. Wind, pressure and river flow move the real tide.
- US stations only (NOAA CO-OPS coverage).
- Heights are above mean lower low water (MLLW). The current height in tide_now is interpolated between predicted highs and lows.
- The hosted server caches predictions for up to 6 hours and the station list for a day.

## More

More MCP servers that answer questions your assistant cannot answer alone are on [mcpstamp.com](https://www.mcpstamp.com/servers/?utm_source=mcp&utm_medium=tide-times-tide-tables-mcp).

Part of the Zovo MCP collection at https://mcp.zovo.one

Built by [theluckystrike](https://github.com/theluckystrike).

## Development

```
npm install
npm test                              # builds, then runs the fixture tests and an offline stdio test
node scripts/stdio-transcript.mjs     # live stdio round trip, writes .live/stdio-transcript.jsonl
```

CI (`.github/workflows/bundle.yml`) runs the tests, the type check and `wrangler deploy --dry-run --outdir out`, and uploads the Worker bundle as an artifact.

## License

MIT
