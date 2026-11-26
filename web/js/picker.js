// Area picker: a Leaflet map with box and polygon drawing, a submit-only
// place search (Nominatim), and typed corners for keyboard users.
import { BASEMAP, NOMINATIM } from './config.js';
import { allCoords, bboxOfCoords } from './geo.js';

const L = window.L;

export function createPicker(el, { onBBox, onSection = () => {}, onBoundary = () => {} }) {
  const map = L.map(el, { zoomSnap: 0.25, keyboard: true }).setView([56.0, -3.8], 9);
  L.tileLayer(BASEMAP, {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  // The map box stretches with the controls beside it (a site's facts make
  // that column taller); tell Leaflet, or the new space stays without tiles.
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(el);

  let rect = null, mode = null, start = null, poly = [], polyLine = null;
  // Swiss palette: black and white only: the model area
  // as a black outline, the site as a black pin with a white ring.
  const style = { color: '#000000', weight: 2, fillOpacity: 0.08 };
  const areaStyle = { color: '#000', weight: 2, fillOpacity: 0.04, dashArray: null };

  function showBBox(b, fit = true) {
    rect?.remove();
    rect = L.rectangle([[b.minLat, b.minLon], [b.maxLat, b.maxLon]], areaStyle).addTo(map);
    if (fit) map.fitBounds(rect.getBounds(), { padding: [20, 20] });
    onBBox(b);
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
    rect = L.rectangle(L.latLngBounds(start, e.latlng), areaStyle).addTo(map);
  });
  map.on('mouseup', e => {
    if (mode !== 'box' || !start) return;
    const b = L.latLngBounds(start, e.latlng);
    setMode(null);
    showBBox({ minLat: b.getSouth(), maxLat: b.getNorth(), minLon: b.getWest(), maxLon: b.getEast() }, false);
  });
  map.on('click', e => {
    if (mode !== 'polygon' && mode !== 'section') return;
    poly.push([e.latlng.lng, e.latlng.lat]);
    polyLine?.remove();
    polyLine = L.polyline(poly.map(([x, y]) => [y, x]), style).addTo(map);
  });

  const sectionLayer = L.layerGroup().addTo(map);
  function showSection(coords) {
    sectionLayer.clearLayers();
    if (!coords) return;
    L.polyline(coords.map(([x, y]) => [y, x]), { color: '#111', weight: 3, dashArray: '6 4' }).addTo(sectionLayer);
    for (const [label, [x, y]] of [['A', coords[0]], ['B', coords.at(-1)]])
      L.circleMarker([y, x], { radius: 4, color: '#111', fillOpacity: 1 }).addTo(sectionLayer)
        .bindTooltip(label, { permanent: true, direction: 'top' });
  }

  function finishPolygon() {
    if (mode === 'section') {
      if (poly.length < 2) return false;
      const line = poly.slice();
      setMode(null); showSection(line); onSection(line);
      return true;
    }
    if (poly.length < 3) return false;
    const gj = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...poly, poly[0]]] } };
    setMode(null);
    showBBox(bboxOfCoords(allCoords(gj), 300), false);
    onBoundary(gj);                    // a drawn area is also shown as a red line
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
    pin = L.circleMarker([lat, lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#000000', fillOpacity: 1 })
      .addTo(map).bindTooltip(label);
  }

  return { map, showBBox, showPin, showSection, setMode, finishPolygon, search, goTo, get mode() { return mode; } };
}
