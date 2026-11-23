// Read a boundary file the user chooses. Nothing is uploaded anywhere:
// the file is parsed in this browser.
import { kml } from '../../vendor/togeojson.js';
import { unzipSync, strFromU8 } from '../../vendor/fflate.js';

export async function readBoundary(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.geojson') || name.endsWith('.json')) {
    return JSON.parse(await file.text());
  }
  if (name.endsWith('.kml')) {
    return kml(new DOMParser().parseFromString(await file.text(), 'text/xml'));
  }
  if (name.endsWith('.kmz')) {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const doc = Object.keys(files).find(k => k.toLowerCase().endsWith('.kml'));
    if (!doc) throw new Error('No KML document inside this KMZ');
    return kml(new DOMParser().parseFromString(strFromU8(files[doc]), 'text/xml'));
  }
  throw new Error('Please choose a .geojson, .kml or .kmz file');
}
