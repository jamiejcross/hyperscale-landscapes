// Curated sites: data/sites/index.json plus one GeoJSON per site, and an
// optional pre-baked bundle (OSM features + elevation tiles) so that the
// common path makes no third-party requests at all.
import { gunzipSync, strFromU8 } from '../../vendor/fflate.js';

export async function listSites() {
  const r = await fetch('data/sites/index.json');
  return (await r.json()).sites;
}

export async function loadSite(entry) {
  const site = await (await fetch(`data/sites/${entry.file}`)).json();
  let bundle = null;
  if (entry.bundle) {
    const r = await fetch(`data/sites/${entry.bundle}`);
    if (r.ok) bundle = JSON.parse(strFromU8(gunzipSync(new Uint8Array(await r.arrayBuffer()))));
    // A bundle baked for a different area (e.g. before the default extent
    // changed) would leave gaps: ignore it and fetch live instead.
    const a = bundle?.bbox, b = site.properties.model_bbox;
    const same = a && ['min_lat', 'max_lat', 'min_lon', 'max_lon'].every(k => Math.abs(a[k] - b[k]) < 1e-6);
    if (bundle && !same) bundle = null;
  }
  return { site, bundle };
}
