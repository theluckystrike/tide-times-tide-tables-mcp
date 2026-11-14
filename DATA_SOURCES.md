# Data sources

All sources are public, keyless and read at call time. Test fixtures in `test/fixtures/` were downloaded on 2026-11-14.

| Data | URL | Notes |
|---|---|---|
| Tide prediction station list | https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions | About 3,000 stations, about 2 MB. Reference (R) and subordinate (S) stations and the TEC tide-table stations. Cached a day. Fixture keeps 5 stations. |
| High/low tide predictions | https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&interval=hilo&datum=MLLW&time_zone=lst_ldt&format=json | Feet or metres above MLLW, station local time. Cached 6 hours. Fixture: San Francisco (Golden Gate) 9414290, 2026-11-14 to 2026-11-16. |
| Geocoding | https://geocoding-api.open-meteo.com/v1/search | Place name to lat/lon when no station name matches. Open-Meteo, CC BY 4.0. Cached a day. |

NOAA data is a US government work and in the public domain. The station list leaves `observedst` empty, so daylight time is derived from the state and offset (Hawaii and the territories do not observe it).
