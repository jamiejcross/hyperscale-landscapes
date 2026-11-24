// Area picker: a Leaflet map with box and polygon drawing, a submit-only
// place search (Nominatim), and typed corners for keyboard users.
import { BASEMAP, NOMINATIM } from './config.js';
import { allCoords, bboxOfCoords } from './geo.js';

const L = window.L;

export function createPicker(el, { onBBox, onFootprint }) {
  const map = L.map(el, { zoomSnap: 0.25, keyboard: true }).setView([56.0, -3.8], 9);
  L.tileLayer(BASEMAP, {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  let rect = null, footprint = null, mode = null, start = null, poly = [], polyLine = null;
  const style = { color: '#D55E00', weight: 2, fillOpacity: 0.08 };

  function showBBox(b, fit = true) {
    rect?.remove();
    rect = L.rectangle([[b.minLat, b.minLon], [b.maxLat, b.maxLon]], { ...style, color: '#0072B2' }).addTo(map);
    if (fit) map.fitBounds(rect.getBounds(), { padding: [20, 20] });
    onBBox(b);
  }

  function showFootprint(gj) {
    footprint?.remove();
    footprint = gj ? L.geoJSON(gj, { style: { ...style, fillOpacity: 0.3 } }).addTo(map) : null;
  }

  function setMode(m) {
    mode = m; start = null; poly = []; polyLine?.remove(); polyLine = null;
    el.classList.toggle('drawing', !!m);
    if (m) map.dragging.disable(); else map.dragging.enable();
  }

  map.on('mousedown', e => {
    if (mode !== 'box') return;
    start = e.latlng;
  });
  map.on('mousemove', e => {
    if (mode !== 'box' || !start) return;
    rect?.remove();
    rect = L.rectangle(L.latLngBounds(start, e.latlng), { ...style, color: '#0072B2' }).addTo(map);
  });
  map.on('mouseup', e => {
    if (mode !== 'box' || !start) return;
    const b = L.latLngBounds(start, e.latlng);
    setMode(null);
    showBBox({ minLat: b.getSouth(), maxLat: b.getNorth(), minLon: b.getWest(), maxLon: b.getEast() }, false);
  });
  map.on('click', e => {
    if (mode !== 'polygon' && mode !== 'footprint') return;
    poly.push([e.latlng.lng, e.latlng.lat]);
    polyLine?.remove();
    polyLine = L.polyline(poly.map(([x, y]) => [y, x]), style).addTo(map);
  });

  function finishPolygon() {
    if (poly.length < 3) return false;
    const gj = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...poly, poly[0]]] } };
    const m = mode;
    setMode(null);
    if (m === 'footprint') { showFootprint(gj); onFootprint(gj); }
    else { showBBox(bboxOfCoords(allCoords(gj), 300), false); showFootprint(null); }
    return true;
  }

  async function search(q) {
    const url = `${NOMINATIM}?format=jsonv2&limit=5&countrycodes=gb&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'Accept-Language': 'en-GB' } });
    if (!r.ok) throw new Error(`Search failed (${r.status})`);
    return (await r.json()).map(p => ({ name: p.display_name, lat: +p.lat, lon: +p.lon }));
  }

  function goTo(lat, lon, sideKm = 1.5) {
    const dLat = sideKm / 2 / 111.32, dLon = dLat / Math.cos(lat * Math.PI / 180);
    showBBox({ minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon });
  }

  let pin = null;
  function showPin([lon, lat], label) {
    pin?.remove();
    pin = L.circleMarker([lat, lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#D55E00', fillOpacity: 1 })
      .addTo(map).bindTooltip(label);
  }

  return { map, showBBox, showFootprint, showPin, setMode, finishPolygon, search, goTo, get mode() { return mode; } };
}
