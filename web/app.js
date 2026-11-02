/* Ojo de Dios: Cali — live ADS-B surveillance over Cali, Valle del Cauca.
 * Basemap, geocoding and reverse geocoding: Amazon Location Service (v2, API key).
 * Aircraft: AWS Lambda Function URL proxying adsb.lol; replay from S3 snapshots.
 * Terrain: Terrain Tiles from the Registry of Open Data on AWS.
 * Earthquakes: USGS FDSN event API.
 */
(() => {
  "use strict";
  const CFG = window.OJO_CONFIG;
  const CALI = [-76.532, 3.4516];
  const SKCL = { name: "SKCL · Alfonso Bonilla Aragón", pos: [-76.3816, 3.5432] };
  const POLL_MS = 5000;
  const TRAIL_MAX = 60;
  const POIS = [
    { name: "Centro · Plaza de Caicedo", pos: [-76.5321, 3.4517], zoom: 15, pitch: 60, bearing: 30 },
    { name: "Cristo Rey", pos: [-76.565, 3.4359], zoom: 14.5, pitch: 68, bearing: 70 },
    { name: "Cerro de las Tres Cruces", pos: [-76.548, 3.4655], zoom: 14, pitch: 65, bearing: 200 },
    { name: "Aeropuerto SKCL (Palmira)", pos: SKCL.pos, zoom: 13.6, pitch: 55, bearing: 15 },
    { name: "Farallones de Cali", pos: [-76.67, 3.38], zoom: 11.6, pitch: 72, bearing: 250 },
    { name: "Estadio Pascual Guerrero", pos: [-76.5413, 3.4297], zoom: 15.5, pitch: 55, bearing: 0 },
    { name: "Río Cauca · Juanchito", pos: [-76.4856, 3.4475], zoom: 13.5, pitch: 60, bearing: 340 },
    { name: "Vista regional (Valle)", pos: [-76.45, 3.6], zoom: 8.2, pitch: 45, bearing: -10 },
  ];

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const R = 6371e3;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  function haversine(a, b) {
    const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearingTo(a, b) {
    const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
    const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function move(pos, brg, dist) {
    const d = dist / R, b = rad(brg), la = rad(pos[1]), lo = rad(pos[0]);
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return [deg(lo2), deg(la2)];
  }
  function circle(center, km, n = 128) {
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(move(center, (i / n) * 360, km * 1000));
    return pts;
  }
  const altColor = (alt, gnd) => {
    if (gnd || alt == null || alt < 500) return "#ff3b3b";
    if (alt < 5000) return "#ffb000";
    if (alt < 15000) return "#39ff88";
    if (alt < 30000) return "#4fd1ff";
    return "#c58bff";
  };
  const fmt = (n, d = 0) => (n == null || isNaN(n) ? "—" : Number(n).toLocaleString("es-CO", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const cotTime = (t) => new Date(t - 5 * 3600e3).toISOString().slice(11, 19);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function toast(msg, ms = 2600) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.hidden = true), ms);
  }

  // ---------- boot sequence ----------
  const bootLines = [
    "> INICIANDO OJO DE DIOS v1.0 ……………… OK",
    "> ENLACE AMAZON LOCATION SERVICE ……… OK",
    "> TERRENO · AWS OPEN DATA ……………………… OK",
    "> RECEPTOR ADS-B · LAMBDA ……………………… OK",
    "> ARCHIVO DE VUELOS · S3 ………………………… OK",
    "> OBJETIVO: SANTIAGO DE CALI 3.4516N 76.5320W",
  ];
  let bootI = 0;
  const bootTimer = setInterval(() => {
    if (bootI < bootLines.length) $("#boot-log").textContent += bootLines[bootI++] + "\n";
  }, 260);
  let booted = false;
  setTimeout(() => bootDone(), 7000); // never trap the viewer behind the boot screen
  function bootDone() {
    if (booted) return;
    booted = true;
    setTimeout(() => {
      clearInterval(bootTimer);
      $("#boot").classList.add("done");
    }, Math.max(0, (bootLines.length - bootI) * 260 + 300));
  }

  // ---------- map ----------
  let baseStyle = "Satellite";
  const styleUrl = (name) =>
    `https://maps.geo.${CFG.region}.amazonaws.com/v2/styles/${name}/descriptor?key=${CFG.locationKey}` +
    (name === "Monochrome" ? "&color-scheme=Dark" : "");

  const map = new maplibregl.Map({
    container: "map",
    style: styleUrl(baseStyle),
    center: [-76.55, 3.2],
    zoom: 7.6,
    pitch: 50,
    bearing: -12,
    maxPitch: 80,
    // HiDPI screens render 4x the pixels; 1.5 keeps it sharp without melting laptops
    pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
    attributionControl: { compact: true, customAttribution: "Aeronaves: adsb.lol (ODbL) · Sismos: USGS · Terreno: AWS Open Data / Mapzen" },
    transformRequest: (url) => {
      if (/\.geo\.[a-z0-9-]+\.amazonaws\.com/.test(url) && !/[?&]key=/.test(url)) {
        return { url: url + (url.includes("?") ? "&" : "?") + "key=" + CFG.locationKey };
      }
      return { url };
    },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  window.ojo = { map }; // debug/automation handle (demo recordings)

  const layerOn = {
    aircraft: true, trails: true, det: true, quakes: true, poi: true, rings: true, terrain: true,
  };

  function planeImage() {
    const s = 64, c = document.createElement("canvas");
    c.width = c.height = s;
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.translate(s / 2, s / 2);
    g.beginPath();
    // nose up (north); rotated by track in the layer
    g.moveTo(0, -28);
    g.lineTo(4, -18); g.lineTo(4, -6); g.lineTo(26, 6); g.lineTo(26, 11); g.lineTo(4, 5);
    g.lineTo(3, 18); g.lineTo(10, 24); g.lineTo(10, 28); g.lineTo(0, 25);
    g.lineTo(-10, 28); g.lineTo(-10, 24); g.lineTo(-3, 18); g.lineTo(-4, 5);
    g.lineTo(-26, 11); g.lineTo(-26, 6); g.lineTo(-4, -6); g.lineTo(-4, -18);
    g.closePath();
    g.fill();
    return g.getImageData(0, 0, s, s);
  }

  const emptyFC = () => ({ type: "FeatureCollection", features: [] });
  let quakeFC = emptyFC();

  function addOverlays() {
    if (!map.getSource("terrain")) {
      map.addSource("terrain", {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 12,
      });
    }
    applyTerrain();
    try {
      map.setSky({ "sky-color": "#02060a", "horizon-color": "#0b2a1c", "fog-color": "#000000", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.75 });
    } catch {}
    if (!map.hasImage("plane")) map.addImage("plane", planeImage(), { sdf: true, pixelRatio: 2 });

    const rings = [10, 25, 50, 100, 200].map((km) => ({
      type: "Feature", properties: { km }, geometry: { type: "LineString", coordinates: circle(CALI, km) },
    }));
    map.addSource("rings", { type: "geojson", data: { type: "FeatureCollection", features: rings } });
    map.addLayer({ id: "rings", type: "line", source: "rings",
      paint: { "line-color": "#e8fff2", "line-opacity": 0.55, "line-width": 1.2, "line-dasharray": [4, 4] } });

    map.addSource("quakes", { type: "geojson", data: quakeFC });
    map.addLayer({ id: "quakes-halo", type: "circle", source: "quakes", paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "mag"], 2.5, 8, 6, 34],
      "circle-color": "#ff3b3b", "circle-opacity": 0.12, "circle-stroke-color": "#ff3b3b", "circle-stroke-width": 1, "circle-stroke-opacity": 0.6,
      "circle-pitch-alignment": "map",
    } });
    map.addLayer({ id: "quakes", type: "circle", source: "quakes", paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "mag"], 2.5, 2.5, 6, 7],
      "circle-color": ["interpolate", ["linear"], ["get", "depth"], 0, "#ffb000", 70, "#ff3b3b", 200, "#c58bff"],
      "circle-pitch-alignment": "map",
    } });

    map.addSource("trails", { type: "geojson", data: emptyFC() });
    map.addLayer({ id: "trails", type: "line", source: "trails", layout: { "line-cap": "round", "line-join": "round" }, paint: {
      "line-color": ["get", "color"],
      "line-width": ["case", ["get", "trk"], 3, 1.6],
      "line-opacity": ["case", ["get", "trk"], 0.95, 0.6],
    } });

    map.addSource("aircraft", { type: "geojson", data: emptyFC() });
    map.addLayer({ id: "aircraft", type: "symbol", source: "aircraft", layout: {
      "icon-image": "plane",
      "icon-size": ["interpolate", ["linear"], ["zoom"],
        6, ["case", ["get", "trk"], 0.85, 0.55],
        10, ["case", ["get", "trk"], 1.2, 0.8],
        14, ["case", ["get", "trk"], 1.8, 1.2]],
      "icon-rotate": ["get", "hdg"],
      "icon-rotation-alignment": "map",
      "icon-pitch-alignment": "viewport",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    }, paint: {
      "icon-color": ["case", ["get", "trk"], "#ffffff", ["get", "color"]],
      "icon-halo-color": "#000", "icon-halo-width": 1.5,
    } });

    for (const id of Object.keys(layerOn)) setLayerVisibility(id, layerOn[id]);
    pushAircraft();
  }

  function applyTerrain() {
    if (!map.getSource("terrain")) return;
    map.setTerrain(layerOn.terrain ? { source: "terrain", exaggeration: 1.5 } : null);
  }

  const glLayers = { aircraft: ["aircraft"], trails: ["trails"], quakes: ["quakes", "quakes-halo"], rings: ["rings"] };
  function setLayerVisibility(id, on) {
    layerOn[id] = on;
    if (id === "terrain") return applyTerrain();
    if (id === "det") { $("#det").style.display = on ? "" : "none"; return; }
    if (id === "poi") { poiMarkers.forEach((m) => (m.getElement().style.display = on ? "" : "none")); return; }
    for (const l of glLayers[id] || []) if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", on ? "visible" : "none");
  }

  map.on("style.load", addOverlays);
  map.once("style.load", () => {
    bootDone();
    camTelemetry();
  });

  // ---------- POIs ----------
  const poiMarkers = POIS.map((p) => {
    const el = document.createElement("div");
    el.className = "poi";
    el.innerHTML = `<span>◆</span>${esc(p.name)}`;
    el.style.cssText = "color:#ffb000;font-size:10px;letter-spacing:.06em;text-shadow:0 0 3px #000,0 0 6px #000;white-space:nowrap;cursor:pointer";
    el.onclick = (e) => { e.stopPropagation(); flyToPoi(p); };
    return new maplibregl.Marker({ element: el, anchor: "left" }).setLngLat(p.pos).addTo(map);
  });
  function flyToPoi(p) {
    untrack();
    map.flyTo({ center: p.pos, zoom: p.zoom, pitch: p.pitch, bearing: p.bearing, duration: 3500, essential: true });
  }
  for (const p of POIS) {
    const b = document.createElement("button");
    b.textContent = p.name;
    b.onclick = () => flyToPoi(p);
    $("#poi-list").appendChild(b);
  }

  // ---------- aircraft state ----------
  /** hex -> { ...slim fields, pos:[lon,lat], seen:ms, trail:[[lon,lat]] } */
  const fleet = new Map();
  let mode = "live";
  let tracked = null;
  let lastPoll = 0;

  async function pollLive() {
    if (mode !== "live") return;
    try {
      const res = await fetch(CFG.apiUrl + "?mode=live", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const snap = await res.json();
      lastPoll = Date.now();
      ingest(snap.ac, snap.t);
      $("#rec").textContent = "● EN VIVO";
    } catch (e) {
      console.warn("live feed", e);
      $("#rec").textContent = "○ SIN SEÑAL";
    }
  }

  function ingest(list, t) {
    const now = Date.now();
    const seenNow = new Set();
    for (const a of list) {
      seenNow.add(a.hex);
      const prev = fleet.get(a.hex);
      const pos = [a.lon, a.lat];
      if (prev) {
        const last = prev.trail[prev.trail.length - 1];
        if (!last || haversine(last, pos) > 30) prev.trail.push(pos);
        if (prev.trail.length > TRAIL_MAX) prev.trail.shift();
        Object.assign(prev, a, { pos, base: pos, seen: now });
      } else {
        fleet.set(a.hex, { ...a, pos, base: pos, seen: now, trail: [pos] });
      }
    }
    for (const [hex, a] of fleet) if (now - a.seen > 60_000 && hex !== tracked) fleet.delete(hex);
    renderContacts();
    renderStats();
  }

  // dead reckoning between polls so contacts glide instead of jumping
  function extrapolate() {
    const now = Date.now();
    for (const a of fleet.values()) {
      if (a.gnd || !a.gs || a.trk == null) { a.pos = a.base; continue; }
      const dt = Math.min((now - a.seen) / 1000, 20);
      a.pos = move(a.base, a.trk, a.gs * 0.514444 * dt);
    }
  }

  function pushAircraft() {
    const src = map.getSource("aircraft");
    if (!src) return;
    const planes = [], trails = [];
    for (const a of fleet.values()) {
      const color = altColor(a.alt, a.gnd);
      const isT = a.hex === tracked;
      planes.push({ type: "Feature", properties: { hex: a.hex, hdg: a.trk ?? 0, color, trk: isT },
        geometry: { type: "Point", coordinates: a.pos } });
      const line = [...a.trail, a.pos];
      if (line.length > 1) trails.push({ type: "Feature", properties: { color, trk: isT }, geometry: { type: "LineString", coordinates: line } });
    }
    src.setData({ type: "FeatureCollection", features: planes });
    map.getSource("trails").setData({ type: "FeatureCollection", features: trails });
  }

  // ---------- detection overlay ----------
  const boxes = new Map();
  function renderDet() {
    if (!layerOn.det || !layerOn.aircraft) { boxes.forEach((b) => (b.style.display = "none")); return; }
    const w = map.getContainer().clientWidth, h = map.getContainer().clientHeight;
    const live = new Set();
    for (const a of fleet.values()) {
      const p = map.project(a.pos);
      if (p.x < -50 || p.y < -50 || p.x > w + 50 || p.y > h + 50) continue;
      live.add(a.hex);
      let b = boxes.get(a.hex);
      if (!b) {
        b = document.createElement("div");
        b.innerHTML = "<span></span>";
        $("#det").appendChild(b);
        boxes.set(a.hex, b);
      }
      b.className = "box" + (a.hex === tracked ? " trk" : "") + (a.mil ? " mil" : "");
      b.style.display = "";
      b.style.left = `${p.x}px`;
      b.style.top = `${p.y}px`;
      const label = `${a.cs || a.reg || a.hex.toUpperCase()}${a.type ? " · " + a.type : ""}\n${a.gnd ? "EN TIERRA" : "FL" + String(Math.round((a.alt || 0) / 100)).padStart(3, "0")} · ${fmt(a.gs)}KT`;
      const span = b.firstChild;
      if (span.textContent !== label) { span.textContent = label; span.style.whiteSpace = "pre"; }
    }
    for (const [hex, b] of boxes) if (!live.has(hex)) { b.remove(); boxes.delete(hex); }
  }

  // ---------- tracking ----------
  let followPausedUntil = 0;
  let lastGeo = { pos: null, t: 0, text: "" };

  function track(hex) {
    tracked = hex;
    lastGeo = { pos: null, t: 0, text: "" };
    const a = fleet.get(hex);
    if (!a) return;
    $("#target").hidden = false;
    map.flyTo({ center: a.pos, zoom: Math.max(map.getZoom(), 11.5), pitch: 62, duration: 1600, essential: true });
    followPausedUntil = Date.now() + 1700;
    renderTarget();
    renderContacts();
    pushAircraft();
  }
  function untrack() {
    tracked = null;
    $("#target").hidden = true;
    renderContacts();
    pushAircraft();
  }
  $("#untrack").onclick = untrack;
  map.on("dragstart", () => (followPausedUntil = Date.now() + 4000));

  function follow() {
    if (!tracked || Date.now() < followPausedUntil) return;
    const a = fleet.get(tracked);
    if (a) map.easeTo({ center: a.pos, duration: 240, easing: (x) => x });
  }

  async function overflight(a) {
    const now = Date.now();
    if (lastGeo.pos && now - lastGeo.t < 12_000 && haversine(lastGeo.pos, a.pos) < 3000) return lastGeo.text;
    lastGeo = { pos: a.pos, t: now, text: lastGeo.text || "consultando…" };
    const r = await reverseGeocode(a.pos);
    lastGeo.text = r ? [r.Address?.District, r.Address?.Locality, r.Address?.SubRegion?.Name].filter(Boolean).join(", ") || r.Title : "fuera de cobertura / zona rural";
    return lastGeo.text;
  }

  function renderTarget() {
    const a = tracked && fleet.get(tracked);
    if (!a) return;
    const dCali = haversine(a.pos, CALI) / 1000;
    const dSkcl = haversine(a.pos, SKCL.pos) / 1000;
    const altM = a.alt != null ? a.alt * 0.3048 : null;
    const vr = a.vr == null ? "—" : a.vr > 150 ? `▲ ${fmt(a.vr)} ft/min` : a.vr < -150 ? `▼ ${fmt(-a.vr)} ft/min` : "nivelado";
    $("#target-body").innerHTML = `
      <div class="big">${esc(a.cs || a.reg || a.hex.toUpperCase())}</div>
      <div class="dim" style="margin-bottom:8px">${esc([a.reg, a.type, a.mil ? "MILITAR" : null].filter(Boolean).join(" · ") || "sin datos de registro")}</div>
      <dl class="kv">
        <dt>ICAO24</dt><dd>${esc(a.hex.toUpperCase())}</dd>
        <dt>ALTITUD</dt><dd>${a.gnd ? "EN TIERRA" : `${fmt(a.alt)} ft · ${fmt(altM)} m`}</dd>
        <dt>VERTICAL</dt><dd>${vr}</dd>
        <dt>VELOCIDAD</dt><dd>${fmt(a.gs)} kt · ${fmt(a.gs * 1.852)} km/h</dd>
        <dt>RUMBO</dt><dd>${fmt(a.trk)}°</dd>
        <dt>SQUAWK</dt><dd${a.emg ? ' style="color:#ff3b3b"' : ""}>${esc(a.sq || "—")}${a.emg ? " " + esc(a.emg.toUpperCase()) : ""}</dd>
        <dt>A CALI</dt><dd>${fmt(dCali, 1)} km · ${fmt(bearingTo(CALI, a.pos))}°</dd>
        <dt>A SKCL</dt><dd>${fmt(dSkcl, 1)} km</dd>
        <dt>POSICIÓN</dt><dd>${a.pos[1].toFixed(4)}, ${a.pos[0].toFixed(4)}</dd>
      </dl>
      <div class="over"><b>SOBREVOLANDO · AMAZON LOCATION</b><span id="overflight">${esc(lastGeo.text || "consultando…")}</span></div>`;
    overflight(a).then((txt) => { const el = $("#overflight"); if (el) el.textContent = txt; });
  }

  // ---------- contacts list ----------
  function renderContacts() {
    const list = [...fleet.values()].map((a) => ({ a, d: haversine(a.pos, CALI) })).sort((x, y) => x.d - y.d);
    $("#n-contacts").textContent = list.length;
    $("#contacts").innerHTML = list.map(({ a, d }) => `
      <button class="contact${a.hex === tracked ? " on" : ""}" data-hex="${esc(a.hex)}">
        <span class="sw" style="background:${altColor(a.alt, a.gnd)}"></span>
        <span><span class="cs">${esc(a.cs || a.reg || a.hex.toUpperCase())}</span>
          <span class="sub">${esc(a.type || "")}${a.mil ? " · MIL" : ""}</span><br>
          <span class="sub">${a.gnd ? "EN TIERRA" : fmt(a.alt) + " ft"} · ${fmt(a.gs)} kt</span></span>
        <span class="rt">${fmt(d / 1000, 0)} km</span>
      </button>`).join("") || `<div class="dim">sin contactos en 280 km</div>`;
  }
  $("#contacts").addEventListener("click", (e) => {
    const b = e.target.closest(".contact");
    if (b) track(b.dataset.hex);
  });

  function renderStats() {
    const arr = [...fleet.values()];
    const air = arr.filter((a) => !a.gnd);
    const top = air.reduce((m, a) => (a.alt > (m?.alt ?? -1) ? a : m), null);
    const fast = air.reduce((m, a) => (a.gs > (m?.gs ?? -1) ? a : m), null);
    $("#t-stats").textContent =
      `${arr.length} CONTACTOS` +
      (top ? ` · MÁS ALTO ${top.cs || top.hex.toUpperCase()} FL${Math.round(top.alt / 100)}` : "") +
      (fast ? ` · MÁS RÁPIDO ${fast.cs || fast.hex.toUpperCase()} ${fmt(fast.gs)}KT` : "") +
      ` · ${quakeFC.features.length} SISMOS`;
  }

  // ---------- render loop ----------
  // Positions advance at 4 Hz (each setData re-tiles the GeoJSON in a worker);
  // detection boxes follow the map's own render events so they never drift.
  let lastTick = performance.now();
  setInterval(() => {
    if (document.hidden) return;
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;
    if (mode === "live") extrapolate();
    else replayTick(dt);
    pushAircraft();
    follow();
  }, 250);
  let detQueued = false;
  map.on("render", () => {
    if (detQueued) return;
    detQueued = true;
    requestAnimationFrame(() => { detQueued = false; renderDet(); });
  });

  let liveTimer = null;
  let targetTimer = null;
  function startLive() {
    pollLive();
    clearInterval(liveTimer);
    liveTimer = setInterval(pollLive, POLL_MS);
    clearInterval(targetTimer);
    targetTimer = setInterval(renderTarget, 1000);
  }

  map.on("click", "aircraft", (e) => {
    const hex = e.features?.[0]?.properties?.hex;
    if (hex) track(hex);
  });
  map.on("mouseenter", "aircraft", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "aircraft", () => (map.getCanvas().style.cursor = ""));

  // ---------- Amazon Location: places ----------
  const placesUrl = (op) => `https://places.geo.${CFG.region}.amazonaws.com/v2/${op}?key=${CFG.locationKey}`;
  async function reverseGeocode(pos) {
    try {
      const res = await fetch(placesUrl("reverse-geocode"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ QueryPosition: pos, MaxResults: 1, Language: "es" }),
      });
      if (!res.ok) return null;
      return (await res.json()).ResultItems?.[0] || null;
    } catch { return null; }
  }
  async function geocode(text) {
    const res = await fetch(placesUrl("geocode"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ QueryText: text, BiasPosition: CALI, Filter: { IncludeCountries: ["COL"] }, MaxResults: 6, Language: "es" }),
    });
    if (!res.ok) throw new Error(res.status);
    return (await res.json()).ResultItems || [];
  }

  $("#search").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#q").value.trim();
    if (!q) return;
    $("#results").innerHTML = `<div class="dim">buscando…</div>`;
    try {
      const items = await geocode(/cali|valle|palmira|jamund|yumbo/i.test(q) ? q : `${q}, Cali, Valle del Cauca`);
      $("#results").innerHTML = items.map((r, i) => `<button data-i="${i}">▸ ${esc(r.Title)}</button>`).join("") || `<div class="dim">sin resultados</div>`;
      $$("#results button").forEach((b) => (b.onclick = () => {
        const r = items[+b.dataset.i];
        untrack();
        map.flyTo({ center: r.Position, zoom: 16, pitch: 60, duration: 3000, essential: true });
        showPin(r.Position, r);
      }));
    } catch {
      $("#results").innerHTML = `<div class="dim">error de geocodificación</div>`;
    }
  });

  let pinMarker = null;
  async function showPin(pos, known) {
    if (!pinMarker) {
      const el = document.createElement("div");
      el.style.cssText = "width:22px;height:22px;border:2px solid #ffb000;transform:rotate(45deg);box-shadow:0 0 12px #ffb000";
      pinMarker = new maplibregl.Marker({ element: el });
    }
    pinMarker.setLngLat(pos).addTo(map);
    const card = $("#pin-card");
    card.hidden = false;
    card.innerHTML = `<b>IDENTIFICANDO…</b>`;
    const r = known || (await reverseGeocode(pos));
    const d = haversine(pos, SKCL.pos) / 1000;
    card.innerHTML = `<b>PUNTO MARCADO · AMAZON LOCATION</b>
      <div style="margin:6px 0;color:#fff;font-weight:600">${esc(r?.Title || "sin dirección")}</div>
      <div class="dim">${esc([r?.Address?.District, r?.Address?.Locality, r?.Address?.SubRegion?.Name].filter(Boolean).join(" · "))}</div>
      <div class="dim">${pos[1].toFixed(5)}, ${pos[0].toFixed(5)} · ${fmt(d, 1)} km a SKCL</div>`;
  }
  map.on("click", (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ["aircraft", "quakes", "quakes-halo"].filter((l) => map.getLayer(l)) }).length) return;
    showPin([e.lngLat.lng, e.lngLat.lat]);
  });

  // ---------- earthquakes (USGS) ----------
  async function loadQuakes() {
    const start = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&latitude=${CALI[1]}&longitude=${CALI[0]}&maxradiuskm=300&minmagnitude=2.5&orderby=time`;
    try {
      const gj = await (await fetch(url)).json();
      quakeFC = {
        type: "FeatureCollection",
        features: gj.features.map((f) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: f.geometry.coordinates.slice(0, 2) },
          properties: { mag: f.properties.mag, depth: f.geometry.coordinates[2], place: f.properties.place, time: f.properties.time, url: f.properties.url },
        })),
      };
      map.getSource("quakes")?.setData(quakeFC);
      renderStats();
    } catch {}
  }
  map.on("click", "quakes-halo", (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ offset: 10 }).setLngLat(e.lngLat).setHTML(
      `<b style="color:#ff3b3b">SISMO M${fmt(p.mag, 1)}</b><br>${esc(p.place)}<br>prof. ${fmt(p.depth)} km<br>${new Date(p.time).toLocaleString("es-CO", { timeZone: "America/Bogota" })}`
    ).addTo(map);
  });

  // ---------- replay from S3 ----------
  let replay = null; // { frames, idx: float, playing, byHex }
  async function startReplay() {
    clearInterval(liveTimer);
    $("#rec").textContent = "◉ REPLAY";
    $("#rec").classList.add("replay");
    toast("CARGANDO ARCHIVO DE VUELOS DESDE S3…");
    try {
      const res = await fetch(CFG.apiUrl + "?mode=replay&minutes=180");
      const data = await res.json();
      if (!data.frames || data.frames.length < 2) {
        toast("ARCHIVO AÚN VACÍO · LA GRABACIÓN SIGUE CORRIENDO");
        return setMode("live");
      }
      replay = { frames: data.frames, idx: 0, playing: true };
      replay.index = data.frames.map((f) => new Map(f.ac.map((a) => [a.hex, a])));
      fleet.clear();
      $("#scrub").max = String(data.frames.length - 1);
      $("#scrub").hidden = $("#play").hidden = false;
      $("#play").textContent = "❚❚";
      toast(`${data.frames.length} CAPTURAS · ${Math.round((data.to - data.from) / 60000)} MIN DE CIELO SOBRE CALI`);
    } catch {
      toast("ERROR CARGANDO REPLAY");
      setMode("live");
    }
  }

  function replayTick(dt) {
    if (!replay) return;
    const { frames, index } = replay;
    if (replay.playing) {
      replay.idx += dt / 400; // 1 captured minute every 0.4 s
      if (replay.idx >= frames.length - 1) replay.idx = 0;
    }
    const i = Math.floor(replay.idx), f = replay.idx - i;
    const A = index[i], B = index[Math.min(i + 1, frames.length - 1)];
    const seen = new Set();
    for (const [hex, a] of A) {
      const b = B.get(hex);
      const pos = b ? [a.lon + (b.lon - a.lon) * f, a.lat + (b.lat - a.lat) * f] : [a.lon, a.lat];
      const trail = [];
      for (let k = Math.max(0, i - 40); k <= i; k++) {
        const p = index[k].get(hex);
        if (p) trail.push([p.lon, p.lat]);
      }
      const prev = fleet.get(hex);
      fleet.set(hex, { ...a, ...(b && f > 0.5 ? b : {}), pos, base: pos, seen: Date.now(), trail });
      seen.add(hex);
      if (!prev) renderContactsSoon();
    }
    for (const hex of [...fleet.keys()]) if (!seen.has(hex) && hex !== tracked) { fleet.delete(hex); renderContactsSoon(); }
    $("#scrub").value = String(i);
    $("#replay-time").textContent = `${cotTime(frames[i].t)} COT`;
  }
  let contactsTimer = null;
  function renderContactsSoon() {
    if (contactsTimer) return;
    contactsTimer = setTimeout(() => { contactsTimer = null; renderContacts(); renderStats(); }, 500);
  }
  $("#scrub").addEventListener("input", (e) => { if (replay) { replay.idx = +e.target.value; } });
  $("#play").onclick = () => {
    if (!replay) return;
    replay.playing = !replay.playing;
    $("#play").textContent = replay.playing ? "❚❚" : "▶";
  };

  function setMode(m) {
    mode = m;
    $$("#mode button").forEach((b) => b.classList.toggle("on", b.dataset.v === m));
    if (m === "replay") return startReplay();
    replay = null;
    $("#scrub").hidden = $("#play").hidden = true;
    $("#replay-time").textContent = "";
    $("#rec").classList.remove("replay");
    fleet.clear();
    startLive();
  }
  $("#mode").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b && b.dataset.v !== mode) setMode(b.dataset.v);
  });

  // ---------- controls ----------
  function setSensor(v) {
    document.body.dataset.sensor = v;
    $$("#sensor button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  }
  $("#sensor").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSensor(b.dataset.v); });
  $("#basemap").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.v === baseStyle) return;
    baseStyle = b.dataset.v;
    $$("#basemap button").forEach((x) => x.classList.toggle("on", x === b));
    map.setStyle(styleUrl(baseStyle), { diff: false });
  });
  $$("[data-layer]").forEach((cb) => cb.addEventListener("change", () => setLayerVisibility(cb.dataset.layer, cb.checked)));

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "Escape") untrack();
    const sensors = { 1: "normal", 2: "nvg", 3: "flir", 4: "crt" };
    if (sensors[e.key]) setSensor(sensors[e.key]);
    if (e.key === "l" || e.key === "L") document.body.classList.toggle("show-left");
  });

  // ---------- telemetry + clock ----------
  map.on("mousemove", (e) => {
    $("#t-cursor").textContent = `LAT ${e.lngLat.lat.toFixed(4)} LON ${e.lngLat.lng.toFixed(4)}`;
  });
  function camTelemetry() {
    const c = map.getCenter(), z = map.getZoom(), h = map.getContainer().clientHeight;
    const mpp = (40075016.686 * Math.cos(rad(c.lat))) / (512 * 2 ** z);
    const alt = ((h / 2) * mpp) / Math.tan(rad(36.87 / 2));
    $("#t-cam").textContent = `ALT CAM ${alt > 10000 ? fmt(alt / 1000, 1) + " km" : fmt(alt) + " m"} · INCL ${fmt(map.getPitch())}° · RUMBO ${fmt((map.getBearing() + 360) % 360)}°`;
  }
  map.on("move", camTelemetry);
  // data feeds don't depend on tiles finishing; start right away
  startLive();
  loadQuakes();
  setInterval(() => {
    const now = Date.now();
    $("#clock-cot").textContent = `${cotTime(now)} COT`;
    $("#clock-utc").textContent = `${new Date(now).toISOString().slice(11, 19)}Z`;
    if (mode === "live" && lastPoll && now - lastPoll > 20_000) $("#rec").textContent = "○ SIN SEÑAL";
  }, 1000);
})();
