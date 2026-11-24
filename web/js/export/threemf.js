// Multi-object 3MF writer for the browser, matching the Python tier's
// format: every print object is a component of one parent (so the parts
// stay locked together in the slicer), plus core <metadata> with title,
// attribution and the exaggeration disclosure, plus Bambu Studio's
// Metadata/model_settings.config assigning each part to a filament slot.
// Optional `separate` parts become their own build items beside the model.
import { Zip, ZipDeflate, strToU8 } from '../../vendor/fflate.js';

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// parts: [{name, slot, colour, mesh:{positions, indices}}]; separate: same shape
export async function write3MF({ title, metadata, parts, separate = [] }) {
  parts = parts.filter(p => p.mesh && p.mesh.indices.length);
  separate = separate.filter(p => p.mesh && p.mesh.indices.length);
  const all = [...parts, ...separate];
  const slots = [...new Set(all.map(p => p.slot))].sort((a, b) => a - b);
  const slotIndex = Object.fromEntries(slots.map((s, i) => [s, i]));
  const slotColour = {};
  all.forEach(p => { slotColour[p.slot] ||= [p.name, p.colour]; });

  const chunks = [];
  const zip = new Zip((err, data, final) => { if (err) throw err; chunks.push(data); });
  const add = (name, text) => { const f = new ZipDeflate(name, { level: 6 }); zip.add(f); f.push(strToU8(text), true); };
  add('[Content_Types].xml', CONTENT_TYPES);
  add('_rels/.rels', RELS);

  const model = new ZipDeflate('3D/3dmodel.model', { level: 6 });
  zip.add(model);
  const push = s => model.push(strToU8(s));
  push('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-GB" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">\n');
  for (const [k, v] of Object.entries({ Title: title, ...metadata })) push(`<metadata name="${esc(k)}">${esc(v)}</metadata>\n`);
  push('<resources><basematerials id="1">');
  for (const s of slots) push(`<base name="${esc(slotColour[s][0])}" displaycolor="${slotColour[s][1]}"/>`);
  push('</basematerials>\n');
  const ids = new Map();
  let oid = 2;
  for (const p of all) {
    push(`<object id="${oid}" type="model" name="${esc(p.name)}" pid="1" pindex="${slotIndex[p.slot]}"><mesh><vertices>`);
    const P = p.mesh.positions, I = p.mesh.indices;
    const STEP = 20000;
    for (let k = 0; k < P.length; k += 3 * STEP) {
      let s = '';
      for (let j = k; j < Math.min(P.length, k + 3 * STEP); j += 3) s += `<vertex x="${P[j].toFixed(4)}" y="${P[j + 1].toFixed(4)}" z="${P[j + 2].toFixed(4)}"/>`;
      push(s);
    }
    push('</vertices><triangles>');
    for (let k = 0; k < I.length; k += 3 * STEP) {
      let s = '';
      for (let j = k; j < Math.min(I.length, k + 3 * STEP); j += 3) s += `<triangle v1="${I[j]}" v2="${I[j + 1]}" v3="${I[j + 2]}"/>`;
      push(s);
    }
    push('</triangles></mesh></object>\n');
    ids.set(p, oid++);
    await new Promise(r => setTimeout(r));            // keep the page responsive
  }
  const parent = oid;
  push(`<object id="${parent}" type="model" name="${esc(title)}"><components>`);
  for (const p of parts) push(`<component objectid="${ids.get(p)}"/>`);
  push('</components></object>\n</resources><build>');
  push(`<item objectid="${parent}"/>`);
  let x = Math.max(...parts.map(p => maxX(p.mesh))) + 10;
  for (const p of separate) {
    const [minx, miny, minz, w] = bounds(p.mesh);
    push(`<item objectid="${ids.get(p)}" transform="1 0 0 0 1 0 0 0 1 ${(x - minx).toFixed(4)} ${(-miny).toFixed(4)} ${(-minz).toFixed(4)}"/>`);
    x += w + 10;
  }
  model.push(strToU8('</build></model>\n'), true);

  let cfg = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n';
  cfg += `  <object id="${parent}">\n    <metadata key="name" value="${esc(title)}"/>\n    <metadata key="extruder" value="${parts[0]?.slot ?? 1}"/>\n`;
  for (const p of parts) cfg += `    <part id="${ids.get(p)}" subtype="normal_part">\n      <metadata key="name" value="${esc(p.name)}"/>\n      <metadata key="extruder" value="${p.slot}"/>\n    </part>\n`;
  cfg += '  </object>\n';
  for (const p of separate) cfg += `  <object id="${ids.get(p)}">\n    <metadata key="name" value="${esc(p.name)}"/>\n    <metadata key="extruder" value="${p.slot}"/>\n  </object>\n`;
  add('Metadata/model_settings.config', cfg + '</config>\n');
  zip.end();
  return new Blob(chunks, { type: 'model/3mf' });
}

function maxX(m) { let v = -Infinity; for (let k = 0; k < m.positions.length; k += 3) v = Math.max(v, m.positions[k]); return v; }
function bounds(m) {
  let a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < m.positions.length; k += 3) for (let d = 0; d < 3; d++) {
    a[d] = Math.min(a[d], m.positions[k + d]); b[d] = Math.max(b[d], m.positions[k + d]);
  }
  return [a[0], a[1], a[2], b[0] - a[0]];
}
