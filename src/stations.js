// Metro stations, used by the demo seed to place parking lots near them. The list is a snapshot of
// OpenStreetMap data (STATIONS_FILE), made by `npm run fetch-stations`.
import { readFileSync } from 'node:fs';

// An interchange mapped once per line becomes one station. Their platforms can be a few hundred metres apart.
const MERGE_WITHIN_M = 600;

/** Overpass QL for subway/metro stations inside an OpenStreetMap area, e.g. the NCT of Delhi. */
export function overpassQuery(area, adminLevel) {
  const name = String(area).replace(/["\\]/g, '\\$&');
  return `[out:json][timeout:90];
area["name"="${name}"]["admin_level"="${adminLevel}"]->.target;
nwr["railway"="station"]["station"="subway"](area.target);
out center tags;`;
}

/** Approximate distance in metres (fine at city scale). */
export function metresBetween(a, b) {
  const kx = 111_320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot((a.lat - b.lat) * 110_574, (a.lng - b.lng) * kx);
}

/**
 * Turns an Overpass response into `[{ name, lat, lng, osm }]`, sorted by name. Stations mapped more than
 * once (an interchange has a node per line) are merged into one at their average position.
 */
export function stationsFromOverpass(response) {
  const merged = [];
  for (const el of response.elements ?? []) {
    const rawName = el.tags?.['name:en'] || el.tags?.name;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!rawName || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // "Hauz Khas (Yellow Line)", "Shalimar Bagh Metro Station" -> "Hauz Khas", "Shalimar Bagh"
    const name = rawName.replace(/\s*\([^)]*\bline\)\s*$/i, '').replace(/\s+metro station$/i, '').replace(/\s+/g, ' ').trim();
    const same = merged.find((s) => s.name.toLowerCase() === name.toLowerCase() && metresBetween(s, { lat, lng }) < MERGE_WITHIN_M);
    if (same) {
      same.points.push({ lat, lng });
      same.osm.push(`${el.type}/${el.id}`);
    } else {
      merged.push({ name, lat, lng, points: [{ lat, lng }], osm: [`${el.type}/${el.id}`] });
    }
  }
  const round = (n) => Math.round(n * 1e6) / 1e6;
  return merged
    .map(({ name, points, osm }) => ({
      name,
      lat: round(points.reduce((sum, p) => sum + p.lat, 0) / points.length),
      lng: round(points.reduce((sum, p) => sum + p.lng, 0) / points.length),
      osm: osm.sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads a stations file written by fetch-stations. */
export function loadStations(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read the metro stations file ${file} (${err.message}). Run npm run fetch-stations, or set STATIONS_FILE.`);
  }
  const stations = (data.stations ?? []).filter((s) => s?.name && Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (!stations.length) throw new Error(`The metro stations file ${file} has no stations. Run npm run fetch-stations.`);
  return stations;
}
