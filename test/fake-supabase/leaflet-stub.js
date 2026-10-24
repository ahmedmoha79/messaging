/* Minimal Leaflet stand-in for tests (tiles are not reachable from the sandbox). */
(function () {
  const chain = o => new Proxy(o, { get: (t, k) => (k in t ? t[k] : () => chain(t)) });
  function latLng(a, b) { return Array.isArray(a) ? { lat: a[0], lng: a[1] } : (a && a.lat !== undefined ? a : { lat: a, lng: b }); }
  window.L = {
    map(id) {
      const el = document.getElementById(id);
      el.dataset.stub = 'map';
      let center = { lat: 0, lng: 0 };
      const m = chain({
        setView(c) { center = latLng(c); el.dataset.center = `${center.lat},${center.lng}`; return m; },
        flyTo(c) { return m.setView(c); },
        fitBounds() { return m; },
        getCenter() { return center; },
        invalidateSize() { return m; },
        removeLayer() { return m; }
      });
      m._el = el;
      return m;
    },
    tileLayer() { return chain({ addTo() { return this; } }); },
    control: { zoom() { return chain({ addTo() { return this; } }); } },
    divIcon(o) { return o; },
    marker(ll, o) {
      let pos = latLng(ll);
      const node = document.createElement('div');
      node.className = 'stub-marker';
      node.title = o.title || '';
      node.innerHTML = o.icon.html;
      const mk = chain({
        addTo(map) { map._el.appendChild(node); return mk; },
        setLatLng(v) { pos = latLng(v); return mk; },
        getLatLng() { return pos; },
        setIcon(i) { node.innerHTML = i.html; return mk; },
        bindPopup() { return mk; },
        setPopupContent(h) { node.dataset.popup = h; return mk; },
        openPopup() { return mk; },
        remove() { node.remove(); return mk; }
      });
      return mk;
    },
    latLng,
    latLngBounds() { return chain({ pad() { return this; } }); }
  };
})();
