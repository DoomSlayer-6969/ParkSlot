// Downloads the metro stations in an OpenStreetMap area into STATIONS_FILE, for the demo seed.
// Usage: npm run fetch-stations [-- --area Delhi --admin-level 4 --out path/to/stations.json]
// Defaults come from STATIONS_AREA, STATIONS_AREA_ADMIN_LEVEL, STATIONS_FILE and OVERPASS_URL.
// Station data © OpenStreetMap contributors, available under the Open Database Licence (ODbL).
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { config } from './config.js';
import { overpassQuery, stationsFromOverpass } from './stations.js';

const { values } = parseArgs({
  options: {
    area: { type: 'string', default: config.stations.area },
    'admin-level': { type: 'string', default: String(config.stations.areaAdminLevel) },
    out: { type: 'string', default: config.stations.file },
  },
});

try {
  const query = overpassQuery(values.area, Number(values['admin-level']));
  const res = await fetch(config.stations.overpassUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'parkslot-fetch-stations' },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Overpass answered ${res.status} ${res.statusText}`);
  const stations = stationsFromOverpass(await res.json());
  if (!stations.length) throw new Error(`no metro stations found in "${values.area}" (admin_level ${values['admin-level']})`);

  writeFileSync(values.out, `${JSON.stringify({
    source: 'OpenStreetMap contributors, https://www.openstreetmap.org/copyright (ODbL), via the Overpass API',
    area: values.area,
    adminLevel: Number(values['admin-level']),
    fetchedAt: new Date().toISOString().slice(0, 10),
    stations,
  }, null, 1)}\n`);
  console.log(`Saved ${stations.length} metro stations in ${values.area} to ${values.out}`);
} catch (err) {
  console.error(`Could not fetch stations: ${err.message}`);
  process.exitCode = 1;
}
