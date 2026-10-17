/* Nexo Tiempo — mapa meteorológico interactivo con datos abiertos.
 * Pronóstico: Open-Meteo (https://open-meteo.com) · Radar: RainViewer (https://www.rainviewer.com)
 * Mapa base: © OpenStreetMap contributors, © CARTO.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuración de capas y escalas de color
  // ---------------------------------------------------------------------------
  const LAYERS = {
    pressure: {
      name: 'Presión', ico: '◎', unit: 'hPa', key: 'pressure_msl', min: 970, max: 1045, digits: 0,
      stops: [[970, [92, 44, 160]], [985, [52, 92, 205]], [1000, [40, 160, 195]], [1008, [56, 178, 120]],
        [1015, [168, 200, 80]], [1022, [232, 188, 70]], [1032, [222, 112, 60]], [1045, [178, 48, 72]]],
    },
    wind: {
      name: 'Viento', ico: '≋', unit: 'km/h', key: 'wind_speed_10m', min: 0, max: 100, digits: 0,
      stops: [[0, [38, 64, 132]], [8, [40, 120, 170]], [18, [46, 168, 130]], [30, [150, 196, 70]],
        [45, [232, 170, 52]], [65, [216, 72, 58]], [85, [168, 40, 110]], [100, [120, 40, 150]]],
    },
    temp: {
      name: 'Temperatura', ico: '🌡', unit: '°C', key: 'temperature_2m', min: -30, max: 45, digits: 0,
      stops: [[-30, [120, 60, 170]], [-15, [60, 80, 200]], [-5, [50, 140, 220]], [0, [70, 190, 220]],
        [8, [70, 190, 140]], [15, [150, 205, 80]], [22, [240, 210, 70]], [30, [240, 140, 50]],
        [38, [215, 55, 50]], [45, [150, 25, 60]]],
    },
    rain: {
      name: 'Lluvia', ico: '☂', unit: 'mm/h', key: 'precipitation', min: 0, max: 20, digits: 1,
      stops: [[0, [70, 140, 230, 0]], [0.09, [70, 140, 230, 0]], [0.3, [70, 150, 235, 150]], [1, [40, 110, 225, 200]],
        [3, [50, 190, 120, 220]], [6, [240, 215, 60, 230]], [12, [240, 120, 40, 240]], [20, [215, 35, 70, 250]]],
    },
    radar: { name: 'Radar', ico: '⌁', unit: 'dBZ', radar: true },
    clouds: {
      name: 'Nubes', ico: '☁', unit: '%', key: 'cloud_cover', min: 0, max: 100, digits: 0,
      stops: [[0, [200, 210, 225, 0]], [15, [200, 210, 225, 0]], [50, [205, 214, 228, 120]], [100, [240, 244, 250, 225]]],
    },
  };
  const LAYER_ORDER = ['pressure', 'wind', 'temp', 'rain', 'radar', 'clouds'];
  const HOURLY_VARS = ['temperature_2m', 'pressure_msl', 'wind_speed_10m', 'wind_direction_10m', 'precipitation', 'cloud_cover'];
  const FORECAST_HOURS = 96;

  const fmtTime = new Intl.DateTimeFormat('es-CL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const fmtDay = new Intl.DateTimeFormat('es-CL', { weekday: 'short', day: 'numeric' });
  const fmtHour = new Intl.DateTimeFormat('es-CL', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------
  const state = {
    layer: 'pressure',
    grid: null,        // { w, e, s, n, nx, ny, zoom, times: [], fields: { key: Float32Array[] } }
    timeIndex: 0,      // índice en grid.times
    radar: null,       // { host, frames: [{ time, path }] }
    radarIndex: 0,
    playing: null,
  };

  // ---------------------------------------------------------------------------
  // Mapa base
  // ---------------------------------------------------------------------------
  const initial = readHash();
  const map = L.map('map', {
    center: [initial.lat, initial.lon], zoom: initial.zoom, minZoom: 2, maxZoom: 11,
    worldCopyJump: true, zoomControl: true, attributionControl: true,
  });
  if (LAYERS[initial.layer]) state.layer = initial.layer;

  // Mapa base OpenStreetMap, oscurecido con un filtro CSS (ver .nx-base en styles.css)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19, className: 'nx-base',
  }).addTo(map);
  map.attributionControl.addAttribution('Pronóstico <a href="https://open-meteo.com/">Open-Meteo</a> (CC BY 4.0)');
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

  const paneField = map.createPane('nxField'); paneField.style.zIndex = 250; paneField.style.pointerEvents = 'none';
  const paneParticles = map.createPane('nxParticles'); paneParticles.style.zIndex = 440; paneParticles.style.pointerEvents = 'none';
  const paneRadar = map.createPane('nxRadar'); paneRadar.style.zIndex = 260; paneRadar.style.pointerEvents = 'none';


  // ---------------------------------------------------------------------------
  // Datos: grilla de Open-Meteo según la vista
  // ---------------------------------------------------------------------------
  function normLon(lon) { return ((((lon + 180) % 360) + 360) % 360) - 180; }

  let loadTimer = null;
  let retryTimer = null;
  let loadSeq = 0;
  // Caché en memoria: la API gratuita de Open-Meteo cuenta cada punto de la grilla como una consulta
  const gridCache = new Map();
  const CACHE_MS = 30 * 60 * 1000;
  function scheduleLoad() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(loadGrid, 400);
  }

  function gridCoversView() {
    const g = state.grid;
    if (!g) return false;
    const b = map.getBounds();
    const dz = map.getZoom() - g.zoom;
    return dz >= 0 && dz <= 1 && b.getWest() >= g.w && b.getEast() <= g.e &&
      Math.max(b.getSouth(), -80) >= g.s && Math.min(b.getNorth(), 80) <= g.n;
  }

  // Grilla anclada a múltiplos fijos según el zoom, para que vistas cercanas reutilicen la caché
  function gridSpec() {
    const z = map.getZoom();
    const b = map.getBounds().pad(0.25);
    let w = b.getWest(), e = b.getEast();
    if (e - w > 360) { const c = map.getCenter().lng; w = c - 180; e = c + 180; }
    let sp = 360 / Math.pow(2, z) * 110 / 256;
    for (;;) {
      const gw = Math.floor(w / sp) * sp, ge = Math.ceil(e / sp) * sp;
      const gs = Math.max(Math.floor(b.getSouth() / sp) * sp, -85), gn = Math.min(Math.ceil(b.getNorth() / sp) * sp, 85);
      const nx = Math.round((ge - gw) / sp) + 1, ny = Math.max(2, Math.round((gn - gs) / sp) + 1);
      if (nx * ny <= 160) return { z, w: gw, e: ge, s: gs, n: gn, nx, ny };
      sp *= 1.25;
    }
  }

  async function loadGrid() {
    if (gridCoversView()) return;
    clearTimeout(retryTimer);
    const seq = ++loadSeq;
    const { z, w, e, s, n, nx, ny } = gridSpec();
    const cacheKey = [z, w, e, s, n].map((x) => x.toFixed(3)).join('|');
    const cached = gridCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_MS) { applyGrid(cached.grid); return; }
    const lats = [], lons = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        lats.push((s + (n - s) * j / (ny - 1)).toFixed(3));
        lons.push(normLon(w + (e - w) * i / (nx - 1)).toFixed(3));
      }
    }
    // Se divide en bloques paralelos: la API responde mucho más rápido con menos puntos por consulta
    const CHUNK = 30;
    const urls = [];
    for (let k = 0; k < lats.length; k += CHUNK) {
      urls.push('https://api.open-meteo.com/v1/forecast?latitude=' + lats.slice(k, k + CHUNK).join(',') +
        '&longitude=' + lons.slice(k, k + CHUNK).join(',') + '&hourly=' + HOURLY_VARS.join(',') +
        '&forecast_hours=' + FORECAST_HOURS + '&timeformat=unixtime&timezone=GMT&cell_selection=nearest');
    }
    setLoading(true);
    try {
      const parts = await Promise.all(urls.map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        return Array.isArray(j) ? j : [j];
      }));
      const json = parts.flat();
      if (seq !== loadSeq) return;
      const times = json[0].hourly.time;
      const fields = {};
      for (const key of HOURLY_VARS) {
        fields[key] = times.map((_, t) => {
          const arr = new Float32Array(nx * ny);
          for (let k = 0; k < nx * ny; k++) {
            const v = json[k] && json[k].hourly[key] ? json[k].hourly[key][t] : null;
            arr[k] = v == null ? NaN : v;
          }
          return arr;
        });
      }
      // Componentes u/v del viento (dirección meteorológica: de dónde viene)
      fields.u = []; fields.v = [];
      for (let t = 0; t < times.length; t++) {
        const sp = fields.wind_speed_10m[t], dir = fields.wind_direction_10m[t];
        const u = new Float32Array(nx * ny), v = new Float32Array(nx * ny);
        for (let k = 0; k < nx * ny; k++) {
          const rad = dir[k] * Math.PI / 180;
          u[k] = -sp[k] * Math.sin(rad);
          v[k] = -sp[k] * Math.cos(rad);
        }
        fields.u.push(u); fields.v.push(v);
      }
      const grid = { w, e, s, n, nx, ny, zoom: z, times, fields, fetchedAt: new Date() };
      gridCache.set(cacheKey, { at: Date.now(), grid });
      applyGrid(grid);
    } catch (err) {
      console.error(err);
      if (seq !== loadSeq) return;
      if (String(err.message).includes('429')) {
        setStatus('Límite gratuito de Open-Meteo alcanzado; reintento en 1 min');
        retryTimer = setTimeout(loadGrid, 60 * 1000);
      } else {
        setStatus('No se pudo cargar el pronóstico; reintento en 20 s');
        retryTimer = setTimeout(loadGrid, 20 * 1000);
      }
    } finally {
      if (seq === loadSeq) setLoading(false);
    }
  }

  function applyGrid(grid) {
    const times = grid.times;
    const prevTime = state.grid ? state.grid.times[state.timeIndex] : null;
    state.grid = grid;
    let idx = prevTime != null ? times.indexOf(prevTime) : -1;
    if (idx < 0) {
      const now = Date.now() / 1000;
      idx = 0;
      for (let t = 0; t < times.length; t++) if (times[t] <= now) idx = t;
    }
    state.timeIndex = idx;
    setStatus('Actualizado ' + fmtHour.format(grid.fetchedAt) + ' · Open-Meteo');
    buildTimebar();
    redrawAll();
  }

  // Interpolación Catmull-Rom (suave) sobre la grilla
  function cubic(p0, p1, p2, p3, t) {
    return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  }
  function sampleSmooth(field, lat, lon) {
    const g = state.grid;
    const fx = (lon - g.w) / (g.e - g.w) * (g.nx - 1);
    const fy = (lat - g.s) / (g.n - g.s) * (g.ny - 1);
    if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return NaN;
    const i = Math.min(Math.floor(fx), g.nx - 2), j = Math.min(Math.floor(fy), g.ny - 2);
    const tx = fx - i, ty = fy - j;
    const rows = [];
    for (let m = -1; m <= 2; m++) {
      const jj = clamp(j + m, 0, g.ny - 1) * g.nx;
      rows.push(cubic(
        field[jj + clamp(i - 1, 0, g.nx - 1)], field[jj + i], field[jj + i + 1], field[jj + clamp(i + 2, 0, g.nx - 1)], tx));
    }
    return cubic(rows[0], rows[1], rows[2], rows[3], ty);
  }
  function sampleLinear(field, lat, lon) {
    const g = state.grid;
    const fx = (lon - g.w) / (g.e - g.w) * (g.nx - 1);
    const fy = (lat - g.s) / (g.n - g.s) * (g.ny - 1);
    if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return NaN;
    const i = Math.min(Math.floor(fx), g.nx - 2), j = Math.min(Math.floor(fy), g.ny - 2);
    const tx = fx - i, ty = fy - j, k = j * g.nx + i;
    const a = field[k] + (field[k + 1] - field[k]) * tx;
    const b = field[k + g.nx] + (field[k + g.nx + 1] - field[k + g.nx]) * tx;
    return a + (b - a) * ty;
  }

  // ---------------------------------------------------------------------------
  // Escalas de color
  // ---------------------------------------------------------------------------
  function buildLut(cfg) {
    const lut = new Uint8ClampedArray(256 * 4);
    const st = cfg.stops;
    for (let k = 0; k < 256; k++) {
      const v = cfg.min + (cfg.max - cfg.min) * k / 255;
      let a = st[0], b = st[st.length - 1];
      for (let s = 0; s < st.length - 1; s++) if (v >= st[s][0] && v <= st[s + 1][0]) { a = st[s]; b = st[s + 1]; break; }
      const t = b[0] === a[0] ? 0 : clamp((v - a[0]) / (b[0] - a[0]), 0, 1);
      const ca = a[1], cb = b[1];
      lut[k * 4] = ca[0] + (cb[0] - ca[0]) * t;
      lut[k * 4 + 1] = ca[1] + (cb[1] - ca[1]) * t;
      lut[k * 4 + 2] = ca[2] + (cb[2] - ca[2]) * t;
      lut[k * 4 + 3] = (ca[3] ?? 200) + ((cb[3] ?? 200) - (ca[3] ?? 200)) * t;
    }
    return lut;
  }
  for (const id of LAYER_ORDER) if (LAYERS[id].stops) LAYERS[id].lut = buildLut(LAYERS[id]);

  // ---------------------------------------------------------------------------
  // Capa de campo (gradiente) + isobaras
  // ---------------------------------------------------------------------------
  const fieldCanvas = L.DomUtil.create('canvas', '', paneField);
  fieldCanvas.style.position = 'absolute';
  const lowCanvas = document.createElement('canvas');
  let viewLats = [], viewLons = [];

  function computeViewCoords() {
    const size = map.getSize();
    viewLons = new Float64Array(size.x + 1);
    viewLats = new Float64Array(size.y + 1);
    for (let x = 0; x <= size.x; x++) viewLons[x] = map.containerPointToLatLng([x, 0]).lng;
    for (let y = 0; y <= size.y; y++) viewLats[y] = map.containerPointToLatLng([0, y]).lat;
  }

  function drawField() {
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    fieldCanvas.width = size.x * dpr; fieldCanvas.height = size.y * dpr;
    fieldCanvas.style.width = size.x + 'px'; fieldCanvas.style.height = size.y + 'px';
    L.DomUtil.setPosition(fieldCanvas, map.containerPointToLayerPoint([0, 0]));
    const ctx = fieldCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    const g = state.grid;
    const cfg = LAYERS[state.layer];
    if (!g || !size.x || !size.y) return;
    computeViewCoords();

    if (cfg.stops) {
      const step = 4;
      const w = Math.ceil(size.x / step), h = Math.ceil(size.y / step);
      lowCanvas.width = w; lowCanvas.height = h;
      const lctx = lowCanvas.getContext('2d');
      const img = lctx.createImageData(w, h);
      const field = g.fields[cfg.key][state.timeIndex];
      const lut = cfg.lut, span = cfg.max - cfg.min;
      for (let y = 0; y < h; y++) {
        const lat = viewLats[Math.min(y * step + step / 2, size.y)];
        for (let x = 0; x < w; x++) {
          const v = sampleSmooth(field, lat, viewLons[Math.min(x * step + step / 2, size.x)]);
          const o = (y * w + x) * 4;
          if (isNaN(v)) { img.data[o + 3] = 0; continue; }
          const k = clamp(Math.round((v - cfg.min) / span * 255), 0, 255) * 4;
          img.data[o] = lut[k]; img.data[o + 1] = lut[k + 1]; img.data[o + 2] = lut[k + 2]; img.data[o + 3] = lut[k + 3];
        }
      }
      lctx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.globalAlpha = 0.78;
      ctx.drawImage(lowCanvas, 0, 0, w * step, h * step);
      ctx.globalAlpha = 1;
    }
    if ($('isobarsToggle').checked && !cfg.radar) drawIsobars(ctx, size);
  }

  function drawIsobars(ctx, size) {
    const g = state.grid;
    const field = g.fields.pressure_msl[state.timeIndex];
    const step = 8;
    const cols = Math.ceil(size.x / step) + 1, rows = Math.ceil(size.y / step) + 1;
    const vals = new Float32Array(cols * rows);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < rows; j++) {
      const lat = viewLats[Math.min(j * step, size.y)];
      for (let i = 0; i < cols; i++) {
        const v = sampleSmooth(field, lat, viewLons[Math.min(i * step, size.x)]);
        vals[j * cols + i] = v;
        if (!isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
    }
    if (!isFinite(lo)) return;
    const interval = map.getZoom() >= 5 ? 2 : 4;
    const labels = [];
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '600 11px system-ui, sans-serif';
    for (let L0 = Math.ceil(lo / interval) * interval; L0 <= hi; L0 += interval) {
      ctx.beginPath();
      ctx.lineWidth = L0 % (interval * 4) === 0 ? 1.8 : 1.1;
      for (let j = 0; j < rows - 1; j++) {
        for (let i = 0; i < cols - 1; i++) {
          const a = vals[j * cols + i], b = vals[j * cols + i + 1];
          const c = vals[(j + 1) * cols + i + 1], d = vals[(j + 1) * cols + i];
          if (isNaN(a) || isNaN(b) || isNaN(c) || isNaN(d)) continue;
          const idx = (a >= L0 ? 8 : 0) | (b >= L0 ? 4 : 0) | (c >= L0 ? 2 : 0) | (d >= L0 ? 1 : 0);
          if (idx === 0 || idx === 15) continue;
          const x = i * step, y = j * step;
          const top = [x + step * (L0 - a) / (b - a), y];
          const right = [x + step, y + step * (L0 - b) / (c - b)];
          const bottom = [x + step * (L0 - d) / (c - d), y + step];
          const left = [x, y + step * (L0 - a) / (d - a)];
          const segs = MS[idx](top, right, bottom, left);
          for (const [p, q] of segs) {
            ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
            if (i % 16 === 8) {
              const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
              if (mx > 30 && my > 30 && mx < size.x - 30 && my < size.y - 30 &&
                labels.every((l) => Math.hypot(l.x - mx, l.y - my) > 70)) labels.push({ x: mx, y: my, t: String(L0) });
            }
          }
        }
      }
      ctx.stroke();
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const l of labels) {
      const w = ctx.measureText(l.t).width + 8;
      ctx.fillStyle = 'rgba(11,17,27,0.75)';
      ctx.fillRect(l.x - w / 2, l.y - 8, w, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(l.t, l.x, l.y + 0.5);
    }
    drawPressureCenters(ctx, size, field);
  }

  // Tabla de segmentos de marching squares (bits: a=8 sup-izq, b=4 sup-der, c=2 inf-der, d=1 inf-izq)
  const MS = [
    null,
    (t, r, b, l) => [[l, b]], (t, r, b, l) => [[b, r]], (t, r, b, l) => [[l, r]],
    (t, r, b, l) => [[t, r]], (t, r, b, l) => [[l, t], [b, r]], (t, r, b, l) => [[t, b]],
    (t, r, b, l) => [[l, t]], (t, r, b, l) => [[l, t]], (t, r, b, l) => [[t, b]],
    (t, r, b, l) => [[t, r], [l, b]], (t, r, b, l) => [[t, r]], (t, r, b, l) => [[l, r]],
    (t, r, b, l) => [[b, r]], (t, r, b, l) => [[l, b]],
  ];

  // Centros de alta (A) y baja (B) presión sobre la grilla de datos
  function drawPressureCenters(ctx, size, field) {
    const g = state.grid, R = 2;
    ctx.font = '800 20px system-ui, sans-serif';
    for (let j = R; j < g.ny - R; j++) {
      for (let i = R; i < g.nx - R; i++) {
        const v = field[j * g.nx + i];
        let isMax = true, isMin = true;
        for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
          if (!di && !dj) continue;
          const o = field[(j + dj) * g.nx + i + di];
          if (o >= v) isMax = false;
          if (o <= v) isMin = false;
        }
        if (!isMax && !isMin) continue;
        const lat = g.s + (g.n - g.s) * j / (g.ny - 1), lon = g.w + (g.e - g.w) * i / (g.nx - 1);
        const p = map.latLngToContainerPoint([lat, lon]);
        if (p.x < 10 || p.y < 10 || p.x > size.x - 10 || p.y > size.y - 10) continue;
        ctx.fillStyle = isMax ? '#7fb2ff' : '#ff7a7a';
        ctx.fillText(isMax ? 'A' : 'B', p.x, p.y - 6);
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillStyle = '#fff';
        ctx.fillText(Math.round(v), p.x, p.y + 11);
        ctx.font = '800 20px system-ui, sans-serif';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Partículas de viento animadas
  // ---------------------------------------------------------------------------
  const partCanvas = L.DomUtil.create('canvas', '', paneParticles);
  partCanvas.style.position = 'absolute';
  let particles = [], animFrame = null;

  function resetParticles() {
    cancelAnimationFrame(animFrame);
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    partCanvas.width = size.x * dpr; partCanvas.height = size.y * dpr;
    partCanvas.style.width = size.x + 'px'; partCanvas.style.height = size.y + 'px';
    L.DomUtil.setPosition(partCanvas, map.containerPointToLayerPoint([0, 0]));
    const ctx = partCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    if (!state.grid || !size.x || !size.y || !$('particlesToggle').checked) return;
    const count = Math.round(clamp(size.x * size.y / 900, 300, 2500));
    particles = Array.from({ length: count }, () => spawn(size, true));
    const tick = () => { stepParticles(ctx, size); animFrame = requestAnimationFrame(tick); };
    animFrame = requestAnimationFrame(tick);
  }
  function spawn(size, randomAge) {
    return { x: Math.random() * size.x, y: Math.random() * size.y, age: randomAge ? Math.floor(Math.random() * 80) : 0 };
  }
  function stepParticles(ctx, size) {
    const g = state.grid;
    const u = g.fields.u[state.timeIndex], v = g.fields.v[state.timeIndex];
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.94)';
    ctx.fillRect(0, 0, size.x, size.y);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const k = 0.06;
    for (let n = 0; n < particles.length; n++) {
      const p = particles[n];
      const xi = p.x | 0, yi = p.y | 0;
      if (p.age > 90 || xi < 0 || yi < 0 || xi > size.x || yi > size.y) { particles[n] = spawn(size, false); continue; }
      const lat = viewLats[yi], lon = viewLons[xi];
      const uu = sampleLinear(u, lat, lon), vv = sampleLinear(v, lat, lon);
      if (isNaN(uu)) { particles[n] = spawn(size, false); continue; }
      const nx = p.x + uu * k, ny = p.y - vv * k;
      ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny);
      p.x = nx; p.y = ny; p.age++;
    }
    ctx.stroke();
  }

  // ---------------------------------------------------------------------------
  // Radar (RainViewer)
  // ---------------------------------------------------------------------------
  const radarLayers = new Map();
  async function loadRadar() {
    if (state.radar) return;
    setLoading(true);
    try {
      const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
      const json = await res.json();
      const frames = [...(json.radar.past || []), ...(json.radar.nowcast || [])];
      state.radar = { host: json.host, frames };
      state.radarIndex = Math.max(0, (json.radar.past || []).length - 1);
    } catch (err) {
      console.error(err);
      setStatus('No se pudo cargar el radar');
    } finally { setLoading(false); }
  }
  function radarLayerFor(frame) {
    if (!radarLayers.has(frame.path)) {
      const layer = L.tileLayer(state.radar.host + frame.path + '/256/{z}/{x}/{y}/2/1_1.png', {
        pane: 'nxRadar', opacity: 0, maxNativeZoom: 7, maxZoom: 19, tileSize: 256,
        attribution: 'Radar <a href="https://www.rainviewer.com/api.html">RainViewer</a>',
      });
      radarLayers.set(frame.path, layer);
    }
    return radarLayers.get(frame.path);
  }
  function showRadarFrame() {
    if (!state.radar) return;
    const frames = state.radar.frames;
    frames.forEach((f, i) => {
      const layer = radarLayerFor(f);
      const near = Math.abs(i - state.radarIndex) <= 1;
      if (near && !map.hasLayer(layer)) layer.addTo(map); // precarga vecinos
      layer.setOpacity(i === state.radarIndex ? 0.85 : 0);
    });
  }
  function hideRadar() { radarLayers.forEach((l) => { if (map.hasLayer(l)) map.removeLayer(l); }); }

  // ---------------------------------------------------------------------------
  // Interfaz: panel de capas, leyenda, barra de tiempo
  // ---------------------------------------------------------------------------
  function buildPanel() {
    const ul = $('layerList');
    ul.innerHTML = '';
    for (const id of LAYER_ORDER) {
      const cfg = LAYERS[id];
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'layer-btn';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(id === state.layer));
      btn.dataset.layer = id;
      btn.innerHTML = `<span class="ico">${cfg.ico}</span>${cfg.name}<span class="unit">${cfg.unit}</span>`;
      btn.addEventListener('click', () => setLayer(id));
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  async function setLayer(id) {
    state.layer = id;
    document.querySelectorAll('.layer-btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.layer === id)));
    stopPlay();
    $('isobarsToggle').checked = id === 'pressure';
    if (LAYERS[id].radar) {
      await loadRadar();
      showRadarFrame();
    } else {
      hideRadar();
    }
    if (window.innerWidth <= 720) togglePanel(false);
    buildLegend();
    buildTimebar();
    redrawAll();
    writeHash();
  }

  function buildLegend() {
    const cfg = LAYERS[state.layer];
    const el = $('legend');
    if (cfg.radar) {
      el.innerHTML = `<div class="title"><span>Radar de precipitación</span><span>RainViewer</span></div>
        <div class="bar" style="background:linear-gradient(90deg,#88ddee,#0099cc,#0077aa,#ffee00,#ff9900,#ff4400,#c10000,#ff77ff)"></div>
        <div class="labels"><span>Débil</span><span>Moderada</span><span>Intensa</span></div>`;
      return;
    }
    const grad = cfg.stops.map(([v, c]) => `rgba(${c[0]},${c[1]},${c[2]},${c[3] == null ? 1 : Math.max(c[3] / 255, 0.15)}) ${((v - cfg.min) / (cfg.max - cfg.min) * 100).toFixed(1)}%`).join(',');
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const v = cfg.min + (cfg.max - cfg.min) * f;
      return `<span>${Number(v.toFixed(cfg.digits))}</span>`;
    }).join('');
    el.innerHTML = `<div class="title"><span>${cfg.name}</span><span>${cfg.unit}</span></div>
      <div class="bar" style="background:linear-gradient(90deg,${grad})"></div><div class="labels">${ticks}</div>`;
  }

  function currentTimes() {
    if (LAYERS[state.layer].radar) return state.radar ? state.radar.frames.map((f) => f.time) : [];
    return state.grid ? state.grid.times : [];
  }
  function currentIndex() { return LAYERS[state.layer].radar ? state.radarIndex : state.timeIndex; }

  function buildTimebar() {
    const times = currentTimes();
    const slider = $('timeSlider');
    slider.max = Math.max(0, times.length - 1);
    slider.value = currentIndex();
    const ticks = $('timeTicks');
    ticks.innerHTML = '';
    if (times.length > 1) {
      const radar = LAYERS[state.layer].radar;
      times.forEach((t, i) => {
        const d = new Date(t * 1000);
        const show = radar ? i % 3 === 0 : d.getHours() === 0;
        if (!show) return;
        const span = document.createElement('span');
        span.style.left = (i / (times.length - 1) * 100) + '%';
        span.textContent = radar ? fmtHour.format(d) : fmtDay.format(d);
        ticks.appendChild(span);
      });
    }
    updateTimeLabel();
  }

  function updateTimeLabel() {
    const times = currentTimes();
    const t = times[currentIndex()];
    if (t == null) { $('timeLabel').textContent = '—'; $('timeRel').textContent = ''; return; }
    const d = new Date(t * 1000);
    $('timeLabel').textContent = fmtTime.format(d);
    const diffMin = Math.round((t * 1000 - Date.now()) / 60000);
    let rel;
    if (Math.abs(diffMin) < 31) rel = 'ahora';
    else if (Math.abs(diffMin) < 120) rel = (diffMin > 0 ? 'en ' : 'hace ') + Math.abs(diffMin) + ' min';
    else rel = (diffMin > 0 ? '+' : '−') + Math.round(Math.abs(diffMin) / 60) + ' h';
    $('timeRel').textContent = rel + (LAYERS[state.layer].radar ? ' · observado' : ' · pronóstico');
  }

  function setIndex(i) {
    if (LAYERS[state.layer].radar) { state.radarIndex = i; showRadarFrame(); }
    else { state.timeIndex = i; drawField(); }
    $('timeSlider').value = i;
    updateTimeLabel();
  }

  $('timeSlider').addEventListener('input', (e) => { stopPlay(); setIndex(Number(e.target.value)); });

  function togglePlay() {
    if (state.playing) return stopPlay();
    const delay = LAYERS[state.layer].radar ? 600 : 700;
    state.playing = setInterval(() => {
      const n = currentTimes().length;
      if (n) setIndex((currentIndex() + 1) % n);
    }, delay);
    $('playIcon').innerHTML = '<path d="M6 5h4v14H6zm8 0h4v14h-4z" fill="currentColor"/>';
    $('playBtn').setAttribute('aria-label', 'Pausar');
  }
  function stopPlay() {
    clearInterval(state.playing); state.playing = null;
    $('playIcon').innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
    $('playBtn').setAttribute('aria-label', 'Reproducir');
  }
  $('playBtn').addEventListener('click', togglePlay);

  function togglePanel(force) {
    const open = force ?? !$('panel').classList.contains('open');
    $('panel').classList.toggle('open', open);
    $('panelToggle').setAttribute('aria-expanded', String(open));
  }
  $('panelToggle').addEventListener('click', () => togglePanel());
  $('particlesToggle').addEventListener('change', resetParticles);
  $('isobarsToggle').addEventListener('change', drawField);

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (e.target.type === 'range') return;
      const n = currentTimes().length; if (!n) return;
      stopPlay();
      setIndex(clamp(currentIndex() + (e.key === 'ArrowRight' ? 1 : -1), 0, n - 1));
    }
  });

  function setStatus(t) { $('status').textContent = t; }
  function setLoading(on) { $('loading').hidden = !on; }

  // ---------------------------------------------------------------------------
  // Popup con pronóstico del punto
  // ---------------------------------------------------------------------------
  const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const cardinal = (deg) => CARD[Math.round(deg / 45) % 8];
  const arrow = (deg) => `<span style="display:inline-block;transform:rotate(${deg + 180}deg)">↑</span>`;
  const fmt = (v, d = 0) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(d));

  map.on('click', async (e) => {
    const lat = e.latlng.lat, lon = normLon(e.latlng.lng);
    const popup = L.popup({ maxWidth: 320 }).setLatLng(e.latlng)
      .setContent(`<div class="pop-h">${fmtCoord(lat, lon)}</div><div class="pop-sub">Cargando pronóstico…</div>`).openOn(map);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
      '&hourly=temperature_2m,precipitation,precipitation_probability,wind_speed_10m,wind_direction_10m,pressure_msl' +
      '&forecast_hours=25&timezone=auto';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const c = d.current, h = d.hourly;
      let rows = '';
      for (let i = 3; i < h.time.length; i += 3) {
        rows += `<tr><td>${h.time[i].slice(11, 16)}</td><td>${fmt(h.temperature_2m[i])}°</td>` +
          `<td>${arrow(h.wind_direction_10m[i])} ${fmt(h.wind_speed_10m[i])}</td>` +
          `<td>${fmt(h.precipitation[i], 1)}</td><td>${fmt(h.precipitation_probability[i])}%</td><td>${fmt(h.pressure_msl[i])}</td></tr>`;
      }
      popup.setContent(`
        <div class="pop-h">${fmtCoord(lat, lon)}</div>
        <div class="pop-sub">Ahora (${c.time.slice(11, 16)} hora local · ${d.elevation != null ? Math.round(d.elevation) + ' m s.n.m.' : ''})</div>
        <div class="pop-now">
          <div><small>Temperatura</small><b class="pop-big">${fmt(c.temperature_2m)}°C</b></div>
          <div><small>Sensación</small><b>${fmt(c.apparent_temperature)}°C</b><small>Humedad ${fmt(c.relative_humidity_2m)}%</small></div>
          <div><small>Viento</small><b>${arrow(c.wind_direction_10m)} ${fmt(c.wind_speed_10m)} km/h ${cardinal(c.wind_direction_10m)}</b><small>Ráfagas ${fmt(c.wind_gusts_10m)} km/h</small></div>
          <div><small>Presión</small><b>${fmt(c.pressure_msl)} hPa</b></div>
          <div><small>Lluvia</small><b>${fmt(c.precipitation, 1)} mm</b></div>
          <div><small>Nubes</small><b>${fmt(c.cloud_cover)}%</b></div>
        </div>
        <table class="pop-table"><thead><tr><th>Hora</th><th>Temp</th><th>Viento</th><th>mm</th><th>Prob</th><th>hPa</th></tr></thead><tbody>${rows}</tbody></table>`);
    } catch (err) {
      popup.setContent(`<div class="pop-h">${fmtCoord(lat, lon)}</div><div class="pop-sub">No se pudo cargar el pronóstico.</div>`);
    }
  });
  function fmtCoord(lat, lon) {
    return `${Math.abs(lat).toFixed(2)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}° ${lon < 0 ? 'O' : 'E'}`;
  }

  // Valor bajo el cursor
  const probe = L.DomUtil.create('div', 'leaflet-tooltip', map.getContainer());
  Object.assign(probe.style, { position: 'absolute', pointerEvents: 'none', display: 'none', zIndex: 800,
    background: 'rgba(11,17,27,.85)', color: '#fff', border: '1px solid rgba(255,255,255,.12)', fontSize: '12px', padding: '3px 7px' });
  map.on('mousemove', (e) => {
    const cfg = LAYERS[state.layer];
    if (!state.grid || cfg.radar) { probe.style.display = 'none'; return; }
    const v = sampleSmooth(state.grid.fields[cfg.key][state.timeIndex], e.latlng.lat, e.latlng.lng);
    if (isNaN(v)) { probe.style.display = 'none'; return; }
    probe.textContent = `${Math.max(cfg.min < 0 ? -Infinity : 0, v).toFixed(cfg.digits)} ${cfg.unit}`;
    probe.style.display = 'block';
    probe.style.left = (e.containerPoint.x + 14) + 'px';
    probe.style.top = (e.containerPoint.y - 10) + 'px';
  });
  map.on('mouseout', () => { probe.style.display = 'none'; });

  // ---------------------------------------------------------------------------
  // Eventos del mapa y URL
  // ---------------------------------------------------------------------------
  function redrawAll() { drawField(); resetParticles(); }

  let moveRaf = null;
  map.on('move', () => {
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => { moveRaf = null; drawField(); });
  });
  map.on('movestart', () => { cancelAnimationFrame(animFrame); partCanvas.style.opacity = 0; });
  map.on('zoomstart', () => { fieldCanvas.style.opacity = 0; partCanvas.style.opacity = 0; });
  map.on('moveend', () => {
    fieldCanvas.style.opacity = 1; partCanvas.style.opacity = 1;
    redrawAll(); scheduleLoad(); writeHash();
  });
  map.on('resize', () => { redrawAll(); scheduleLoad(); });

  function readHash() {
    const parts = location.hash.replace('#', '').split(',');
    const lat = parseFloat(parts[0]), lon = parseFloat(parts[1]), zoom = parseInt(parts[2], 10);
    return {
      lat: isFinite(lat) ? lat : -33.452, lon: isFinite(lon) ? lon : -70.654,
      zoom: isFinite(zoom) ? zoom : 5, layer: parts[3] || 'pressure',
    };
  }
  function writeHash() {
    const c = map.getCenter();
    history.replaceState(null, '', `#${c.lat.toFixed(3)},${normLon(c.lng).toFixed(3)},${map.getZoom()},${state.layer}`);
  }

  // Inicio
  buildPanel();
  $('isobarsToggle').checked = state.layer === 'pressure';
  buildLegend();
  buildTimebar();
  if (LAYERS[state.layer].radar) setLayer(state.layer);
  loadGrid();
  // Refrescar datos cada 30 minutos
  setInterval(() => { gridCache.clear(); state.grid && (state.grid.zoom = -99); loadGrid(); state.radar = null; if (LAYERS[state.layer].radar) setLayer(state.layer); }, 30 * 60 * 1000);
})();
