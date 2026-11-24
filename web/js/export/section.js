// Cross-section profile along a line the user draws (brief §6.2): true
// elevation along the line, with what it crosses — buildings at their
// heights, the proposed facility at its stated height, water, roads,
// railways, power lines and pylons, industrial residues, schools and care.
// Drawn as SVG (and PNG) with the caption, at true vertical scale unless
// the user chooses otherwise, which the image then states.
import { allCoords, makeProjection, polygonsOf, pointInPolygon } from '../geo.js';
import { captionLines } from '../scene/caption.js';

const MAJOR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link']);

// ---------------------------------------------------------------------------
// Geometry along the line
// ---------------------------------------------------------------------------
function along(line, proj) {
  const pts = line.map(([lon, lat]) => proj.toXY(lon, lat));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const at = s => {             // point at distance s along the line
    let i = 1; while (i < pts.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])];
  };
  return { pts, cum, length: cum.at(-1), at };
}

// Parameter (distance along the section) of each crossing of segment a-b.
function segCross(p, q, a, b) {
  const r = [q[0] - p[0], q[1] - p[1]], s = [b[0] - a[0], b[1] - a[1]];
  const d = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(d) < 1e-12) return null;
  const t = ((a[0] - p[0]) * s[1] - (a[1] - p[1]) * s[0]) / d;
  const u = ((a[0] - p[0]) * r[1] - (a[1] - p[1]) * r[0]) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

function crossings(L, coordsXY) {
  const out = [];
  for (let i = 1; i < L.pts.length; i++) {
    const p = L.pts[i - 1], q = L.pts[i], segLen = L.cum[i] - L.cum[i - 1];
    for (let k = 1; k < coordsXY.length; k++) {
      const t = segCross(p, q, coordsXY[k - 1], coordsXY[k]);
      if (t != null) out.push(L.cum[i - 1] + t * segLen);
    }
  }
  return out.sort((a, b) => a - b);
}

// Intervals [s0, s1] of the section that lie inside a polygon (rings in metres).
function intervals(L, rings) {
  const ss = [0, L.length];
  for (const r of rings) ss.push(...crossings(L, r));
  ss.sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < ss.length; i++) {
    if (ss[i] - ss[i - 1] < 0.5) continue;
    const [x, y] = L.at((ss[i] + ss[i - 1]) / 2);
    if (pointInPolygon(x, y, rings)) {
      if (out.length && Math.abs(out.at(-1)[1] - ss[i - 1]) < 0.5) out.at(-1)[1] = ss[i];
      else out.push([ss[i - 1], ss[i]]);
    }
  }
  return out;
}

function distToLine(L, [x, y]) {
  let best = { d: Infinity, s: 0 };
  for (let i = 1; i < L.pts.length; i++) {
    const [ax, ay] = L.pts[i - 1], [bx, by] = L.pts[i];
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2));
    const d = Math.hypot(x - ax - t * vx, y - ay - t * vy);
    if (d < best.d) best = { d, s: L.cum[i - 1] + t * Math.sqrt(l2) };
  }
  return best;
}

const num = (v, d) => { const n = parseFloat(String(v ?? '').replace('m', '')); return Number.isFinite(n) ? n : d; };

export function computeSection({ line, bbox, elev, osm, footprint = null, insertHeight = null }) {
  const proj = makeProjection(bbox);
  const L = along(line, proj);
  const toXY = ([lon, lat]) => proj.toXY(lon, lat);
  const step = Math.max(2, L.length / 900);
  const profile = [];
  for (let s = 0; s <= L.length + 1e-6; s += step) {
    const [x, y] = L.at(Math.min(s, L.length));
    const [lon, lat] = proj.toLonLat(x, y);
    profile.push([Math.min(s, L.length), Math.max(elev.sample(lon, lat), 0)]);
  }
  const ground = s => {
    const i = Math.min(profile.length - 1, Math.max(0, Math.round(s / step)));
    return profile[i][1];
  };
  const minLon = Math.min(...line.map(p => p[0])), maxLon = Math.max(...line.map(p => p[0]));
  const minLat = Math.min(...line.map(p => p[1])), maxLat = Math.max(...line.map(p => p[1]));
  const pad = 0.002;
  // Keep features whose bounding box overlaps the line's (a long, straight
  // way can cross the section with all its vertices far away).
  const nearLine = g => {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [lon, lat] of allCoords(g)) { a = Math.min(a, lon); b = Math.max(b, lon); c = Math.min(c, lat); d = Math.max(d, lat); }
    return b > minLon - pad && a < maxLon + pad && d > minLat - pad && c < maxLat + pad;
  };

  const items = { buildings: [], site: [], water: [], points: [], spans: [] };
  // buildings (OSM heights; default two storeys)
  for (const b of osm.buildings) {
    if (!nearLine(b.geometry)) continue;
    const rings = b.geometry.coordinates.map(r => r.map(toXY));
    for (const [s0, s1] of intervals(L, rings)) {
      const g = Math.min(ground(s0), ground(s1));
      const h = num(b.tags.height, num(b.tags['building:levels'], 2) * 3);
      items.buildings.push({ s0, s1, base: g, top: g + h, receptor: !!b.receptor, kind: b.tags.building });
    }
  }
  // the proposed facility, at its stated height
  if (footprint && insertHeight) {
    for (const rs of polygonsOf(footprint)) {
      for (const [s0, s1] of intervals(L, rs.map(r => r.map(toXY)))) {
        let hi = 0; for (let s = s0; s <= s1; s += step) hi = Math.max(hi, ground(s));
        items.site.push({ s0, s1, base: hi, top: hi + insertHeight });
      }
    }
  }
  // water: polygons and waterways
  for (const w of osm.water) {
    if (!nearLine(w.geometry)) continue;
    for (const rs of polygonsOf(w.geometry)) for (const [s0, s1] of intervals(L, rs.map(r => r.map(toXY)))) items.water.push({ s0, s1 });
  }
  for (const w of osm.waterways) {
    if (!nearLine(w.geometry) || w.geometry.type !== 'LineString') continue;
    for (const s of crossings(L, w.geometry.coordinates.map(toXY)))
      items.points.push({ s, kind: 'water', label: w.tags.name || ({ river: 'River', stream: 'Burn', canal: 'Canal' }[w.kind] || 'Watercourse') });
  }
  // sea: ground at or below sea level along the section
  let seaStart = null;
  for (const [s, z] of profile) {
    if (z <= 0.3 && seaStart == null) seaStart = s;
    if ((z > 0.3 || s === L.length) && seaStart != null) { if (s - seaStart > 20) items.water.push({ s0: seaStart, s1: s, sea: true }); seaStart = null; }
  }
  // roads (major, labelled) and railways
  for (const r of osm.roads) {
    if (!MAJOR_ROADS.has(r.kind) || !nearLine(r.geometry) || r.geometry.type !== 'LineString') continue;
    for (const s of crossings(L, r.geometry.coordinates.map(toXY)))
      items.points.push({ s, kind: 'road', label: r.tags.ref || r.tags.name || 'Road' });
  }
  for (const f of osm.features) {
    if (!nearLine(f.geometry)) continue;
    const g = f.geometry;
    if (f.layer === 'rail' && g.type === 'LineString') {
      for (const s of crossings(L, g.coordinates.map(toXY)))
        items.points.push({ s, kind: 'rail', label: f.status === 'disused' ? 'Disused railway' : 'Railway' });
    } else if (f.layer === 'power' && (f.kind === 'line' || f.kind === 'minor_line') && g.type === 'LineString') {
      const kv = f.tags.voltage ? ` ${Math.round(parseFloat(f.tags.voltage.split(';')[0]) / 1000)} kV` : '';
      for (const s of crossings(L, g.coordinates.map(toXY)))
        items.points.push({ s, kind: 'power', label: `${f.kind === 'line' ? 'Power line' : 'Distribution line'}${kv}` });
    } else if (f.layer === 'power' && f.kind === 'tower' && g.type === 'Point') {
      const d = distToLine(L, toXY(g.coordinates));
      if (d.d < 40) items.points.push({ s: d.s, kind: 'pylon', label: 'Pylon', height: num(f.tags.height, 30) });
    } else if (['power', 'residues', 'receptors'].includes(f.layer) && (g.type === 'Polygon' || g.type === 'MultiPolygon')) {
      for (const rs of polygonsOf(g)) for (const [s0, s1] of intervals(L, rs.map(r => r.map(toXY)))) {
        const label = f.layer === 'power' ? ({ substation: 'Substation', battery: 'Battery storage' }[f.kind] || 'Power')
          : f.layer === 'receptors' ? ({ school: 'School', place_of_worship: 'Church', community_centre: 'Community centre', hospital: 'Hospital', social_facility: 'Care' }[f.kind] || 'Community')
          : f.kind.split(':')[1].replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
        items.spans.push({ s0, s1, layer: f.layer, label: f.status === 'existing' ? label : `${label} (${f.status})` });
      }
    }
  }
  const zs = profile.map(p => p[1]);
  return { length: L.length, profile, items, zMin: Math.min(...zs), zMax: Math.max(...zs) };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function sectionSVG(sec, { vex = 1, caption, colours, width = 1600, siteLabel = 'Proposed data centre' }) {
  const m = { l: 70, r: 30, t: 60, b: 50 };
  const pw = width - m.l - m.r;
  const kx = pw / sec.length;                         // px per metre, horizontal
  const ky = kx * vex;                                // px per metre, vertical
  const tallest = Math.max(sec.zMax, ...sec.items.buildings.map(b => b.top), ...sec.items.site.map(b => b.top),
    ...sec.items.points.filter(p => p.height).map(p => ground(sec, p.s) + p.height));
  const lo = Math.max(0, Math.floor((sec.zMin - 5) / 10) * 10);
  const ph = Math.max(140, (tallest - lo) * ky + 20);
  const labelRows = 5, rowH = 18;
  const top = m.t + labelRows * rowH;
  const H = top + ph + m.b;
  const X = s => m.l + s * kx, Y = z => top + ph - (z - lo) * ky;

  const capLines = [caption.title + '  ·  ' + caption.disclosure, ...wrapText(caption.sources, 190), caption.footer];
  const capH = 16 + capLines.length * 18;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H + capH}" viewBox="0 0 ${width} ${H + capH}" font-family="system-ui, -apple-system, 'Segoe UI', Arial, sans-serif" font-size="13">`);
  out.push(`<title>${esc(caption.title)}: cross-section</title>`);
  out.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  out.push(`<text x="${m.l}" y="26" font-size="18" font-weight="650" fill="#22201c">${esc(caption.title)}: cross-section A–B</text>`);
  out.push(`<text x="${m.l}" y="46" fill="#55504a">${(sec.length / 1000).toFixed(2)} km · vertical scale ${vex === 1 ? 'true (×1, not exaggerated)' : `exaggerated ×${vex}`} · heights in metres above sea level</text>`);

  // axes and grid
  const gstep = niceStep(Math.max((tallest - lo) / 4, 24 / ky));   // at least 24 px between gridlines
  for (let z = Math.ceil(lo / gstep) * gstep; z <= tallest + gstep; z += gstep) {
    if (Y(z) < top - 2) break;
    out.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${Y(z)}" y2="${Y(z)}" stroke="#e4e0d8"/>`);
    out.push(`<text x="${m.l - 8}" y="${Y(z) + 4}" text-anchor="end" fill="#55504a">${z} m</text>`);
  }
  const xstep = niceStep(sec.length / 8);
  for (let s = 0; s <= sec.length; s += xstep) {
    out.push(`<line x1="${X(s)}" x2="${X(s)}" y1="${top + ph}" y2="${top + ph + 5}" stroke="#55504a"/>`);
    out.push(`<text x="${X(s)}" y="${top + ph + 20}" text-anchor="middle" fill="#55504a">${s >= 1000 ? `${(s / 1000).toFixed(s % 1000 ? 1 : 0)} km` : `${s} m`}</text>`);
  }

  // water (behind the ground line)
  for (const w of sec.items.water) {
    const z = Math.max(ground(sec, w.s0), 0);
    out.push(`<rect x="${X(w.s0)}" y="${Y(z) - 3}" width="${Math.max(1, (w.s1 - w.s0) * kx)}" height="6" fill="${colours.water}"/>`);
  }
  // ground
  const pts = sec.profile.map(([s, z]) => `${X(s).toFixed(1)},${Y(z).toFixed(1)}`).join(' ');
  out.push(`<polygon points="${X(0)},${top + ph} ${pts} ${X(sec.length)},${top + ph}" fill="#cdbf9f"/>`);
  out.push(`<polyline points="${pts}" fill="none" stroke="#6f5a43" stroke-width="2"/>`);
  // residues, power and receptor spans as bands just under the ground line
  for (const sp of sec.items.spans) {
    const c = colours[sp.layer];
    out.push(`<rect x="${X(sp.s0)}" y="${Y(ground(sec, (sp.s0 + sp.s1) / 2)) + 3}" width="${Math.max(2, (sp.s1 - sp.s0) * kx)}" height="7" fill="${c}" opacity="0.85"/>`);
  }
  // buildings
  for (const b of sec.items.buildings)
    out.push(`<rect x="${X(b.s0)}" y="${Y(b.top)}" width="${Math.max(1, (b.s1 - b.s0) * kx)}" height="${Math.max(1, (b.top - b.base) * ky)}" fill="${b.receptor ? colours.receptors : '#9a958c'}"/>`);
  // the proposed facility
  for (const b of sec.items.site)
    out.push(`<rect x="${X(b.s0)}" y="${Y(b.top)}" width="${(b.s1 - b.s0) * kx}" height="${(b.top - b.base) * ky}" fill="${colours.site}" fill-opacity="0.55" stroke="${colours.site}" stroke-width="2" stroke-dasharray="6 3"/>`);
  // pylons
  for (const p of sec.items.points.filter(p => p.kind === 'pylon')) {
    const g = ground(sec, p.s);
    out.push(`<line x1="${X(p.s)}" x2="${X(p.s)}" y1="${Y(g)}" y2="${Y(g + p.height)}" stroke="${colours.power}" stroke-width="3"/>`);
  }

  // labels: one row each, greedily stacked so they do not overlap
  const labels = [
    ...sec.items.site.map(b => ({ s: (b.s0 + b.s1) / 2, z: b.top, text: `${siteLabel} (${Math.round(b.top - b.base)} m)`, colour: colours.site, bold: true })),
    ...sec.items.points.map(p => ({ s: p.s, z: ground(sec, p.s) + (p.height || 0), text: p.label, colour: colours[p.kind === 'pylon' ? 'power' : p.kind] || '#333' })),
    ...sec.items.spans.map(sp => ({ s: (sp.s0 + sp.s1) / 2, z: ground(sec, (sp.s0 + sp.s1) / 2), text: sp.label, colour: colours[sp.layer] })),
    ...mergeRuns(sec.items.buildings.filter(b => b.receptor)).map(r => ({ s: r, z: ground(sec, r), text: 'School / care / community', colour: colours.receptors })),
  ].sort((a, b) => a.s - b.s);
  const rowsEnd = Array(labelRows).fill(-Infinity);
  for (const lb of labels) {
    const w = lb.text.length * 7 + 10, x = X(lb.s);
    let row = rowsEnd.findIndex(e => e < x - 4);
    if (row < 0) continue;                              // too crowded: skip rather than overlap
    rowsEnd[row] = x + w;
    const ly = m.t + row * rowH + 12;
    out.push(`<line x1="${x}" x2="${x}" y1="${ly + 4}" y2="${Y(lb.z) - 2}" stroke="${lb.colour}" stroke-width="1" opacity="0.7"/>`);
    out.push(`<text x="${x + 3}" y="${ly}" fill="#22201c"${lb.bold ? ' font-weight="650"' : ''}>${esc(lb.text)}</text>`);
  }
  // A and B
  out.push(`<text x="${X(0)}" y="${top + ph + 38}" font-weight="700">A</text>`);
  out.push(`<text x="${X(sec.length)}" y="${top + ph + 38}" font-weight="700" text-anchor="end">B</text>`);

  // caption band
  out.push(`<rect x="0" y="${H}" width="${width}" height="${capH}" fill="#f7f5f0"/>`);
  capLines.forEach((l, i) => out.push(`<text x="${m.l}" y="${H + 22 + i * 18}" fill="${i ? '#55504a' : '#22201c'}"${i ? '' : ' font-weight="600"'}>${esc(l)}</text>`));
  out.push('</svg>');
  return out.join('\n');
}

function ground(sec, s) {
  const step = sec.profile.length > 1 ? sec.profile[1][0] - sec.profile[0][0] : 1;
  return sec.profile[Math.min(sec.profile.length - 1, Math.max(0, Math.round(s / step)))][1];
}
function niceStep(x) { const p = 10 ** Math.floor(Math.log10(x)); return [1, 2, 5, 10].map(k => k * p).find(v => v >= x) || 10 * p; }
function wrapText(t, n) { const out = []; let line = ''; for (const w of t.split(' ')) { if ((line + ' ' + w).length > n && line) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w; } if (line) out.push(line); return out; }
function mergeRuns(bs) { const out = []; for (const b of bs.sort((a, b) => a.s0 - b.s0)) { const c = (b.s0 + b.s1) / 2; if (!out.length || c - out.at(-1) > 150) out.push(c); } return out; }

export async function svgToPNG(svg, scale = 2) {
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth * scale; c.height = img.naturalHeight * scale;
  const g = c.getContext('2d'); g.scale(scale, scale); g.drawImage(img, 0, 0);
  URL.revokeObjectURL(img.src);
  return new Promise(r => c.toBlob(r, 'image/png'));
}

export { captionLines };
