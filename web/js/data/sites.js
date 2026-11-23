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
  }
  return { site, bundle };
}
