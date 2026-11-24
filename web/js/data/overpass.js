// OpenStreetMap features for the browser tier: one Overpass query (shared
// with the Python bake script, data/overpass/web.ql), mirror fallback,
// polite spacing between requests, and an IndexedDB cache.
//
// classify() mirrors pipeline/hyperscale_landscapes/providers/features.py.
// Keep the two in step; tests/web/classify.test.mjs checks the shared cases.
import { OVERPASS_MIRRORS } from '../config.js';
import { cacheGet, cacheSet } from './cache.js';

export const QUERY_VERSION = 'web-v2';   // v2 adds natural=coastline
let lastRequest = 0;

export async function loadQuery(bbox) {
  const ql = await (await fetch('data/overpass/web.ql')).text();
  const b = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  return ql.replaceAll('{{bbox}}', b);
}

export async function fetchOSM(bbox, onStatus = () => {}) {
  const key = `osm:${QUERY_VERSION}:${[bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon].map(v => v.toFixed(5)).join(',')}`;
  const hit = await cacheGet(key);
  if (hit) return hit;
  const query = await loadQuery(bbox);
  let lastErr;
  for (let round = 0; round < 2; round++) {
    for (const url of OVERPASS_MIRRORS) {
      const wait = Math.max(0, lastRequest + 1500 - Date.now());   // at most one request every 1.5 s
      if (wait) await new Promise(r => setTimeout(r, wait));
      lastRequest = Date.now();
      try {
        onStatus(new URL(url).host);
        const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }) });
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const json = await r.json();
        await cacheSet(key, json);
        return json;
      } catch (e) { lastErr = e; }
    }
    await new Promise(r => setTimeout(r, 8000));
  }
  throw new Error(`OpenStreetMap servers are busy (${lastErr?.message}). Please try again in a minute.`);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
const set = (...a) => new Set(a);
const RAIL = set('rail', 'light_rail', 'narrow_gauge', 'abandoned', 'disused', 'razed', 'dismantled', 'preserved', 'construction', 'proposed');
const RES_HISTORIC = set('mine', 'mine_shaft', 'mine_adit', 'industrial', 'kiln', 'ruins', 'charcoal_pile', 'bunker');
const RES_MANMADE = set('spoil_heap', 'mineshaft', 'adit', 'works', 'gasometer', 'chimney', 'storage_tank', 'wastewater_plant', 'kiln', 'slurry_tank', 'silo');
const RES_LANDUSE = set('quarry', 'landfill', 'brownfield', 'industrial', 'military');
const RECEPTOR = set('school', 'kindergarten', 'college', 'university', 'hospital', 'clinic', 'doctors', 'prison', 'community_centre', 'place_of_worship', 'library', 'social_facility', 'nursing_home', 'childcare');
const COVER_NATURAL = set('wood', 'heath', 'scrub', 'wetland', 'grassland', 'bare_rock', 'scree', 'moor', 'fell');
export const RECEPTOR_BUILDINGS = set('school', 'kindergarten', 'college', 'university', 'hospital', 'clinic', 'prison', 'community_centre', 'church', 'chapel', 'mosque', 'temple', 'synagogue', 'civic', 'public', 'library', 'care_home');

export function status(t) {
  const s = Object.keys(t).join(' ');
  if (t.power === 'construction' || 'construction:power' in t || t.railway === 'construction') return 'construction';
  if (t.power === 'proposed' || 'proposed:power' in t || t.railway === 'proposed') return 'proposed';
  if (['abandoned', 'disused', 'razed', 'dismantled'].includes(t.railway) || /(^| )(disused|abandoned):/.test(s)
      || t.disused === 'yes' || t.abandoned === 'yes') return 'disused';
  return 'existing';
}

export function classify(t) {
  let power = t.power || t['construction:power'] || t['proposed:power'] || t['disused:power'];
  if (power === 'construction' || power === 'proposed') power = t[power] || power;
  if (power || 'generator:source' in t || 'plant:source' in t) {
    if (t['generator:source'] === 'battery' || t['plant:storage'] || t['generator:method'] === 'battery-storage') return ['power', 'battery'];
    if ((!power || power === 'generator') && t['generator:source']) return ['power', `generator:${t['generator:source']}`];
    if ((!power || power === 'plant') && t['plant:source']) return ['power', `plant:${t['plant:source']}`];
    return ['power', power || 'generator'];
  }
  const rail = t.railway;
  if (RAIL.has(rail) || 'disused:railway' in t || 'abandoned:railway' in t) return ['rail', rail || t['disused:railway'] || t['abandoned:railway']];
  if (RES_HISTORIC.has(t.historic)) return ['residues', `historic:${t.historic}`];
  if (RES_MANMADE.has(t.man_made)) return ['residues', `man_made:${t.man_made}`];
  if (RES_LANDUSE.has(t.landuse)) return ['residues', `landuse:${t.landuse}`];
  if (RECEPTOR.has(t.amenity) || 'social_facility' in t || 'healthcare' in t) return ['receptors', t.amenity || t.social_facility || t.healthcare];
  if (t.landuse) return ['landcover', `landuse:${t.landuse}`];
  if (COVER_NATURAL.has(t.natural)) return ['landcover', `natural:${t.natural}`];
  return null;
}

const KEEP = set('voltage', 'operator', 'start_date', 'height', 'building:levels', 'railway', 'usage',
  'historic', 'man_made', 'landuse', 'natural', 'amenity', 'social_facility', 'healthcare',
  'generator:source', 'plant:source', 'plant:storage', 'highway', 'waterway', 'width', 'building', 'lanes');

function cleanTags(t, layer) {
  const out = {};
  for (const k of Object.keys(t)) if (KEEP.has(k)) out[k] = t[k];
  if (t.name && ['power', 'rail', 'residues', 'receptors'].includes(layer)) out.name = t.name;
  return out;
}

const LINE_KINDS = set('line', 'minor_line', 'cable');

function geometryOf(el, linear) {
  if (el.type === 'node') return { type: 'Point', coordinates: [el.lon, el.lat] };
  if (el.type === 'way') {
    const c = (el.geometry || []).filter(Boolean).map(p => [p.lon, p.lat]);
    if (c.length < 2) return null;
    const closed = c.length >= 4 && c[0][0] === c.at(-1)[0] && c[0][1] === c.at(-1)[1];
    return closed && !linear ? { type: 'Polygon', coordinates: [c] } : { type: 'LineString', coordinates: c };
  }
  if (el.type === 'relation') {
    // Multipolygons: keep each closed member ring (outer/inner by role).
    const outers = [], inners = [];
    for (const m of el.members || []) {
      const c = (m.geometry || []).filter(Boolean).map(p => [p.lon, p.lat]);
      if (c.length < 4) continue;
      const closed = c[0][0] === c.at(-1)[0] && c[0][1] === c.at(-1)[1];
      if (!closed) continue;
      (m.role === 'inner' ? inners : outers).push(c);
    }
    if (!outers.length) return null;
    return { type: 'MultiPolygon', coordinates: outers.map(o => [o, ...inners]) };
  }
  return null;
}

// Split raw Overpass JSON into the layers the model uses.
export function parseOSM(osm) {
  const out = { buildings: [], roads: [], waterways: [], water: [], coastlines: [], features: [] };
  for (const el of osm.elements || []) {
    const t = el.tags || {};
    if (t.building && el.type === 'way') {
      const g = geometryOf(el, false);
      if (g?.type === 'Polygon') {
        const c = classify(t);
        const receptor = c?.[0] === 'receptors';
        out.buildings.push({ geometry: g, tags: cleanTags(t, 'buildings'), receptor });
        // A building can also be a feature (a church, a works, a storage
        // tank): record it as one too, as the Python tier does.
        if (c && c[0] !== 'landcover') out.features.push({ layer: c[0], kind: c[1], status: status(t),
          osm: `w${el.id}`, geometry: g, tags: cleanTags(t, c[0]) });
      }
      continue;
    }
    if (t.highway && el.type === 'way') {
      const g = geometryOf(el, true);
      if (g) out.roads.push({ geometry: g, kind: t.highway, tags: cleanTags(t, 'roads') });
      continue;
    }
    if (t.waterway && el.type === 'way') {
      const g = geometryOf(el, true);
      if (g) out.waterways.push({ geometry: g, kind: t.waterway, tags: cleanTags(t, 'water') });
      continue;
    }
    if (t.natural === 'coastline' && el.type === 'way') {
      // Keep as lines (direction matters: land on the left). `out geom(bbox)`
      // leaves nulls where the way leaves the box: split there rather than
      // joining across the gap.
      let run = [];
      for (const p of [...(el.geometry || []), null]) {
        if (p) { run.push([p.lon, p.lat]); continue; }
        if (run.length >= 2) out.coastlines.push({ geometry: { type: 'LineString', coordinates: run } });
        run = [];
      }
      continue;
    }
    if (t.natural === 'water' || t.water) {
      const g = geometryOf(el, false);
      if (g && g.type !== 'LineString' && g.type !== 'Point') out.water.push({ geometry: g });
      continue;
    }
    const c = classify(t);
    if (!c) continue;
    const [layer, kind] = c;
    const g = geometryOf(el, layer === 'rail' || LINE_KINDS.has(kind));
    if (!g) continue;
    out.features.push({ layer, kind, status: status(t), osm: `${el.type[0]}${el.id}`, geometry: g, tags: cleanTags(t, layer) });
  }
  return out;
}
