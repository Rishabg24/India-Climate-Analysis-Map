// ============================================
// GLOBAL STATE
// ============================================

const state = {
    svg: null,
    projection: null,
    path: null,
    // PERF: Flat array indexed by voronoi order (same as clustersData.features[i])
    // Much faster than hash map lookup per frame
    cellNodes: [],           // cellNodes[i] = raw DOM <path> node for cluster i
    clusterMeta: [],         // clusterMeta[i] = { clusterId, zone } — pre-cached at load time
    clustersData: null,
    loadedYearData: {},      // temperature year data
    loadedPM25YearData: {},  // PM2.5 year data
    allDates: [],
    dateToDataMap: {},
    currentTempType: 'tmax',
    currentMode: 'temp',     // 'temp' | 'pm25'
    currentDateIndex: 0,
    svgWidth: 0,
    svgHeight: 0,
    boundaryGeoJSON: null,
    // RACE-CONDITION FIX: Track in-flight loads per mode so the UI stays locked
    // until every selected year has arrived — regardless of which resolves first.
    pendingYearLoads:  new Set(),   // years currently being fetched (temp mode)
    pendingPM25Loads:  new Set(),   // years currently being fetched (pm25 mode)
};

const HF_BASE = 'https://huggingface.co/datasets/Lotus-28/India_Temperature_Analysis_Data/resolve/main';

// ============================================
// ZONE CONFIGURATION  (Temperature)
// ============================================

// PERF: Flat lookup table — O(1) zone lookup vs Array.includes() O(n)
const ZONE_TROPICAL  = 0;
const ZONE_TEMPERATE = 1;
const ZONE_COLD      = 2;

const KG_CODE_TO_ZONE = new Int8Array(30);
KG_CODE_TO_ZONE.fill(ZONE_COLD);
[0,1,2,3,4].forEach(c => { KG_CODE_TO_ZONE[c] = ZONE_TROPICAL; });
[6,11,12].forEach(c =>   { KG_CODE_TO_ZONE[c] = ZONE_TEMPERATE; });

const ZONE_CONFIG = [
    // 0: TROPICAL
    {
        minTemp: 15, maxTemp: 30,
        colorScale: d3.scaleSequential(d3.interpolateRgbBasis([
            '#ffffcc','#fee08b','#fdae61','#f46d43','#d73027','#a50026'
        ])).domain([0, 1])
    },
    // 1: TEMPERATE
    {
        minTemp: 16, maxTemp: 28,
        colorScale: d3.scaleSequential(d3.interpolateRgbBasis([
            '#d4edda','#74c476','#31a354','#006d2c','#00441b','#002d0f'
        ])).domain([0, 1])
    },
    // 2: COLD
    {
        minTemp: 8, maxTemp: 25,
        colorScale: d3.scaleSequential(d3.interpolateRgbBasis([
            '#c9d7e6','#c6dbef','#6baed6','#2171b5','#08519c','#08306b'
        ])).domain([0, 1])
    }
];

// Pre-compute reciprocals to avoid division in the hot path
ZONE_CONFIG.forEach(z => { z.rangeRecip = 1 / (z.maxTemp - z.minTemp); });

// ============================================
// PM2.5 COLOR SCALE
// Mirrors the CSS gradient in .pm25-gradient:
//   green(Good) → yellow(Moderate) → orange(Sensitive) → red(Unhealthy) → maroon(Hazardous)
// WHO 24-hr guideline: 15 µg/m³; India's typical range: 0–250+
// We cap at 150 (Hazardous) so extreme outliers don't wash out the scale.
// ============================================

const PM25_DOMAIN_MAX = 150;  // µg/m³ — anything ≥ this renders as full maroon

const PM25_COLOR_SCALE = d3.scaleSequential(
    d3.interpolateRgbBasis([
        '#00e400',  //   0  Good
        '#cccc00',  //  ~35 Moderate
        '#ff7e00',  //  ~75 Sensitive Groups
        '#ff0000',  // ~110 Unhealthy
        '#7e0023',  //  150 Hazardous
    ])
).domain([0, PM25_DOMAIN_MAX]);

const NO_DATA_COLOR = '#474747';

// Temperature color (zone-aware)
function getColorTemp(zoneIndex, temperature) {
    if (temperature === null || temperature === undefined) return NO_DATA_COLOR;
    const cfg = ZONE_CONFIG[zoneIndex];
    const t = Math.max(0, Math.min(1, (temperature - cfg.minTemp) * cfg.rangeRecip));
    return cfg.colorScale(t);
}

// PM2.5 color (single global scale)
function getColorPM25(value) {
    if (value === null || value === undefined) return NO_DATA_COLOR;
    const capped = Math.max(0, Math.min(PM25_DOMAIN_MAX, value));
    return PM25_COLOR_SCALE(capped);
}

function showLoading() { document.getElementById('loading-overlay').classList.add('active'); }
function hideLoading()  { document.getElementById('loading-overlay').classList.remove('active'); }

// ============================================
// ROBUST HUGGINGFACE FETCH
// HF "resolve" URLs sometimes serve an HTML redirect page instead of raw data.
// Adding ?download=true forces the raw file. We also validate the response
// is actually JSON before parsing.
// ============================================

async function hfFetch(filename) {
    const urls = [
        `${HF_BASE}/${filename}?download=true`,
        `${HF_BASE}/${filename}`,
    ];

    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (!res.ok) {
                console.warn(`HTTP ${res.status} for ${url}`);
                continue;
            }

            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('text/html')) {
                console.warn(`Got HTML response from ${url} — trying fallback`);
                continue;
            }

            const text = await res.text();
            const trimmed = text.trimStart();
            if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
                console.warn(`Non-JSON response from ${url} — trying fallback`);
                continue;
            }

            return JSON.parse(text);
        } catch (err) {
            console.warn(`Fetch failed for ${url}:`, err.message);
        }
    }

    throw new Error(`All fetch attempts failed for: ${filename}`);
}

// ============================================
// MAP INITIALIZATION
// ============================================

function initMap() {
    const container = document.getElementById('map');
    state.svgWidth  = container.clientWidth;
    state.svgHeight = container.clientHeight;

    state.projection = d3.geoMercator()
        .center([82.0, 22.5])
        .scale(1000)
        .translate([state.svgWidth / 2, state.svgHeight / 2]);

    state.path = d3.geoPath().projection(state.projection);

    state.svg = d3.select('#map')
        .append('svg')
        .attr('width',  state.svgWidth)
        .attr('height', state.svgHeight);

    state.svg.append('defs')
        .append('clipPath').attr('id', 'india-clip')
        .append('path').attr('id', 'clip-path-geometry');

    state.svg.append('g').attr('id', 'voronoi-group');
    state.svg.append('g').attr('id', 'zonal-outlines-group');
    state.svg.append('g').attr('id', 'boundary-group');
}

function onResize() {
    const container = document.getElementById('map');
    state.svgWidth  = container.clientWidth;
    state.svgHeight = container.clientHeight;
    state.svg.attr('width', state.svgWidth).attr('height', state.svgHeight);

    if (state.boundaryGeoJSON) {
        fitProjectionToBoundary(state.boundaryGeoJSON, state.svgWidth, state.svgHeight);
        redrawBoundary();
        redrawClusters();
        updateMapColors();
    }
}

function fitProjectionToBoundary(geojson, width, height) {
    state.projection.fitExtent([[20, 20], [width - 20, height - 20]], geojson);
    state.path = d3.geoPath().projection(state.projection);
}

// ============================================
// DATA LOADING
// ============================================

async function loadBoundary() {
    try {
        const data = await hfFetch('india_boundary.geojson');
        state.boundaryGeoJSON = data;
        fitProjectionToBoundary(data, state.svgWidth, state.svgHeight);
        redrawBoundary();
        console.log('Boundary loaded');
    } catch (err) {
        console.error(err);
        alert('Failed to load India boundary.\n' + err.message);
    }
}

function redrawBoundary() {
    state.svg.select('#clip-path-geometry').attr('d', state.path(state.boundaryGeoJSON));

    const g = state.svg.select('#boundary-group');
    g.selectAll('*').remove();
    g.append('path')
        .datum(state.boundaryGeoJSON)
        .attr('class', 'india-boundary')
        .attr('d', state.path);
}

async function loadClusters() {
    try {
        const data = await hfFetch('clusters.geojson');
        state.clustersData = data;
        console.log(`Loaded ${data.features.length} clusters`);

        // PERF: Pre-cache zone and clusterId per index — computed once, used every frame
        state.clusterMeta = data.features.map(f => ({
            clusterId: f.properties.cluster_id,
            zone: KG_CODE_TO_ZONE[Math.min(f.properties.kg_code ?? 29, 29)]
        }));

        redrawClusters();
        console.log('Clusters drawn');
    } catch (err) {
        console.error(err);
        alert('Failed to load clusters.\n' + err.message);
    }
}

function redrawClusters() {
    if (!state.clustersData) return;

    const vGroup = state.svg.select('#voronoi-group');
    const oGroup = state.svg.select('#zonal-outlines-group');
    vGroup.selectAll('*').remove();
    oGroup.selectAll('*').remove();
    state.cellNodes = [];

    const W = state.svgWidth;
    const H = state.svgHeight;

    const points   = state.clustersData.features.map(f => state.projection(f.geometry.coordinates));
    const delaunay = d3.Delaunay.from(points);
    const voronoi  = delaunay.voronoi([0, 0, W, H]);

    vGroup.attr('clip-path', 'url(#india-clip)');
    oGroup.attr('clip-path', 'url(#india-clip)');

    // PERF: No CSS transition on fill — transitions on thousands of SVG paths
    // force full style recalculation every frame, making playback glacially slow
    state.clustersData.features.forEach((feature, i) => {
        const cellPath = voronoi.renderCell(i);
        if (!cellPath) {
            state.cellNodes.push(null);
            return;
        }
        const node = vGroup.append('path')
            .attr('d', cellPath)
            .attr('class', 'cluster-cell')
            .attr('fill', NO_DATA_COLOR)
            .node();
        state.cellNodes.push(node);
    });

    buildZonalOutlines(voronoi, delaunay, oGroup);
}

function buildZonalOutlines(voronoi, delaunay, oGroup) {
    const features      = state.clustersData.features;
    const halfedges     = delaunay.halfedges;
    const triangles     = delaunay.triangles;
    const circumcenters = voronoi.circumcenters;
    const parts         = [];

    for (let e = 0; e < halfedges.length; e++) {
        const opp = halfedges[e];
        if (opp < e) continue;

        const i = triangles[e];
        const j = triangles[opp];
        if (i === undefined || j === undefined) continue;

        const zI = KG_CODE_TO_ZONE[Math.min(features[i]?.properties?.kg_code ?? 29, 29)];
        const zJ = KG_CODE_TO_ZONE[Math.min(features[j]?.properties?.kg_code ?? 29, 29)];
        if (zI === zJ) continue;

        const t1 = Math.floor(e   / 3);
        const t2 = Math.floor(opp / 3);
        const x1 = circumcenters[t1 * 2],   y1 = circumcenters[t1 * 2 + 1];
        const x2 = circumcenters[t2 * 2],   y2 = circumcenters[t2 * 2 + 1];

        if (isFinite(x1) && isFinite(y1) && isFinite(x2) && isFinite(y2)) {
            parts.push(`M${x1},${y1}L${x2},${y2}`);
        }
    }

    if (parts.length) {
        oGroup.append('path')
            .attr('d', parts.join(''))
            .attr('class', 'zonal-outline');
    }
}

// ─── Temperature year loader (HuggingFace) ───
async function loadYearData(year) {
    if (state.loadedYearData[year]) return state.loadedYearData[year];

    console.log(`Loading temperature year ${year} from HuggingFace...`);
    try {
        const data = await hfFetch(`temp_data_${year}.json`);
        state.loadedYearData[year] = data;
        console.log(`Loaded temp ${year}: ${data.dates.length} days`);
        return data;
    } catch (err) {
        console.error(err);
        alert(`Failed to load temperature data for ${year}.\n${err.message}`);
        return null;
    }
}

// ─── PM2.5 year loader (HuggingFace) ───
async function loadPM25YearDataHF(year) {
    // BUG FIX: was reading from loadedYearData (temperature cache) on both the
    // cache-hit check and the store — PM2.5 data was written into the wrong object
    // so updateMapColorsPM25 always read undefined and the map stayed grey.
    if (state.loadedPM25YearData[year]) return state.loadedPM25YearData[year];

    console.log(`Loading PM2.5 year ${year} from HuggingFace...`);
    try {
        const data = await hfFetch(`pm25_data_${year}.json`);
        state.loadedPM25YearData[year] = data;  // ← correct cache
        console.log(`Loaded PM2.5 ${year}: ${data.dates.length} days`);
        return data;
    } catch (err) {
        console.error(err);
        alert(`Failed to load PM2.5 data for ${year}.\n${err.message}`);
        return null;
    }
}

// ============================================
// DATE MANAGEMENT — mode-aware
// ============================================

function rebuildDateIndex() {
    // Remember which date was on screen before rebuilding so we can restore the
    // slider position rather than always snapping back to index 0.  This matters
    // when a fast-resolving year arrives before a slow one: without this, every
    // intermediate rebuild would reset playback to the very first date.
    const prevDate = state.allDates.length > 0
        ? state.allDates[state.currentDateIndex]
        : null;

    state.allDates      = [];
    state.dateToDataMap = {};

    if (state.currentMode === 'temp') {
        Array.from(document.querySelectorAll('.year-checkbox:checked'))
            .map(cb => parseInt(cb.value)).sort((a, b) => a - b)
            .forEach(year => {
                const yd = state.loadedYearData[year];
                if (!yd) return;
                yd.dates.forEach((d, idx) => {
                    state.allDates.push(d);
                    state.dateToDataMap[d] = { year, localIndex: idx };
                });
            });
    } else {
        // PM2.5 mode
        Array.from(document.querySelectorAll('.pm25-year-checkbox:checked'))
            .map(cb => parseInt(cb.value)).sort((a, b) => a - b)
            .forEach(year => {
                const yd = state.loadedPM25YearData[year];
                if (!yd) return;
                yd.dates.forEach((d, idx) => {
                    state.allDates.push(d);
                    state.dateToDataMap[d] = { year, localIndex: idx };
                });
            });
    }

    // Restore the slider position to the same calendar date if it still exists in
    // the newly-built index (e.g. user added a later year while viewing mid-2015).
    // Fall back to 0 only when the previous date is no longer in the index.
    if (prevDate !== null && state.dateToDataMap[prevDate] !== undefined) {
        state.currentDateIndex = state.allDates.indexOf(prevDate);
    } else {
        state.currentDateIndex = 0;
    }

    updateSlider();
}

function updateSlider() {
    const slider  = document.getElementById('date-slider');
    const playBtn = document.getElementById('play-btn');

    if (!state.allDates.length) {
        slider.disabled = playBtn.disabled = true;
        slider.max = 0;
        document.getElementById('current-date').textContent = 'Select years to begin';
        return;
    }

    // Guard: don't unlock controls if any fetches are still in-flight.
    // This prevents an uncheck (synchronous) from accidentally re-enabling the
    // slider while concurrent checked-year loads are still awaiting.
    const hasInflight = state.pendingYearLoads.size > 0 || state.pendingPM25Loads.size > 0;
    slider.disabled = playBtn.disabled = hasInflight;
    slider.max   = state.allDates.length - 1;
    slider.value = state.currentDateIndex;
    updateDateDisplay();
}

// FIX: date strings like "2014-01-15" are parsed as UTC midnight by the JS Date
// constructor. Displaying them with toLocaleDateString() in a non-UTC timezone
// (e.g. US/Pacific = UTC-8) shifts the date one day back.
// Solution: force UTC rendering via the timeZone option.
function updateDateDisplay() {
    if (!state.allDates.length) return;
    const dateStr = state.allDates[state.currentDateIndex];
    const d = new Date(dateStr);
    document.getElementById('current-date').textContent =
        d.toLocaleDateString('en-US', {
            year:     'numeric',
            month:    'long',
            day:      'numeric',
            timeZone: 'UTC',   // <-- prevents off-by-one-day in western timezones
        });
}

// ============================================
// MAP COLOR UPDATE — dispatcher + per-mode implementations
// Hot path: optimized for speed across ~30k Voronoi cells
// ============================================

function updateMapColors() {
    if (state.currentMode === 'pm25') {
        updateMapColorsPM25();
    } else {
        updateMapColorsTemp();
    }
}

// ─── Temperature ───
function updateMapColorsTemp() {
    if (!state.clustersData || !state.allDates.length) return;

    const dataInfo = state.dateToDataMap[state.allDates[state.currentDateIndex]];
    if (!dataInfo) return;

    const yearData = state.loadedYearData[dataInfo.year];
    if (!yearData) return;

    const tempData   = state.currentTempType === 'tmax' ? yearData.tmax : yearData.tmin;
    const localIndex = dataInfo.localIndex;
    const meta       = state.clusterMeta;
    const nodes      = state.cellNodes;
    const n          = meta.length;

    // PERF: Tight loop — pre-cached zone index, no hash lookups, direct DOM write
    for (let i = 0; i < n; i++) {
        const node = nodes[i];
        if (!node) continue;
        const { clusterId, zone } = meta[i];
        const temps = tempData[clusterId];
        node.setAttribute('fill', temps ? getColorTemp(zone, temps[localIndex]) : NO_DATA_COLOR);
    }
}

// ─── PM2.5 ───
function updateMapColorsPM25() {
    if (!state.clustersData || !state.allDates.length) return;

    const dataInfo = state.dateToDataMap[state.allDates[state.currentDateIndex]];
    if (!dataInfo) return;

    const yearData = state.loadedPM25YearData[dataInfo.year];
    if (!yearData) return;

    const pm25Data   = yearData.pm25;
    const localIndex = dataInfo.localIndex;
    const meta       = state.clusterMeta;
    const nodes      = state.cellNodes;
    const n          = meta.length;

    // PERF: Same tight loop pattern — clusterId lookup, direct DOM write
    for (let i = 0; i < n; i++) {
        const node = nodes[i];
        if (!node) continue;
        const { clusterId } = meta[i];
        const vals = pm25Data[clusterId];
        node.setAttribute('fill', vals ? getColorPM25(vals[localIndex]) : NO_DATA_COLOR);
    }
}

// ─── Reset all cells to no-data (used on mode switch) ───
function clearMapColors() {
    const nodes = state.cellNodes;
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
        if (nodes[i]) nodes[i].setAttribute('fill', NO_DATA_COLOR);
    }
}

// ─── Enable / disable slider + play button ───────────────────────────────────
// Called by the checkbox handlers to lock the UI while datasets are in-flight.
// We never enable the controls when there are no dates to display.
function setInteractivityEnabled(enabled) {
    const slider  = document.getElementById('date-slider');
    const playBtn = document.getElementById('play-btn');
    if (!enabled || !state.allDates.length) {
        slider.disabled  = true;
        playBtn.disabled = true;
    } else {
        slider.disabled  = false;
        playBtn.disabled = false;
    }
}

// ============================================
// MODE SWITCH
// ============================================

function switchMode(mode) {
    if (mode === state.currentMode) return;

    stopPlayback();
    state.currentMode = mode;

    // Clear any in-flight loads for the old mode so stale completions from the
    // previous mode can't accidentally unlock the UI in the new one.
    state.pendingYearLoads.clear();
    state.pendingPM25Loads.clear();

    // Reset shared date state so the two modes never bleed into each other
    state.allDates = [];
    state.dateToDataMap = {};
    state.currentDateIndex = 0;

    // ── body class drives ALL .temp-only / .pm25-only visibility ──
    document.body.classList.toggle('mode-pm25', mode === 'pm25');

    // ── nav pill: active state + aria ──
    document.querySelectorAll('.mode-btn').forEach(btn => {
        const isActive = btn.dataset.mode === mode;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive);
    });

    // ── map header ──
    updateMapHeader();

    // ── reset slider display ──
    const slider  = document.getElementById('date-slider');
    const playBtn = document.getElementById('play-btn');
    slider.disabled = playBtn.disabled = true;
    slider.max = slider.value = 0;
    document.getElementById('current-date').textContent = 'Select years to begin';

    // ── paint map grey until user loads data ──
    clearMapColors();
}

function updateMapHeader() {
    const titleEl    = document.getElementById('current-map-title');
    const subtitleEl = document.getElementById('map-subtitle');

    if (state.currentMode === 'pm25') {
        titleEl.textContent    = 'PM2.5 Air Quality';
        subtitleEl.textContent = 'Select years and use the slider to explore daily air quality patterns';
    } else {
        const label = state.currentTempType === 'tmax' ? 'Maximum' : 'Minimum';
        titleEl.textContent    = `${label} Temperature`;
        subtitleEl.textContent = 'Select years and use the slider to explore daily temperature patterns';
    }
}

// ============================================
// EVENT HANDLERS
// ============================================

async function handleYearCheckboxChange(e) {
    stopPlayback();

    const year = parseInt(e.target.value);

    if (e.target.checked) {
        // Register this year as in-flight BEFORE the await so any subsequent
        // checkbox changes that fire synchronously see the correct pending count.
        state.pendingYearLoads.add(year);
        setInteractivityEnabled(false);
        showLoading();

        await loadYearData(year);

        state.pendingYearLoads.delete(year);

        // Only unlock the UI and rebuild the date index once every selected year
        // has finished loading.  If other years are still in-flight we just wait —
        // their own handler will do the final rebuild when the last one resolves.
        if (state.pendingYearLoads.size === 0) {
            hideLoading();
            rebuildDateIndex();
            updateMapColors();
            setInteractivityEnabled(true);
        }
    } else {
        // Unchecking is always synchronous; pending set should be empty here.
        delete state.loadedYearData[year];
        rebuildDateIndex();
        updateMapColors();
    }
}

async function handlePM25YearCheckboxChange(e) {
    stopPlayback();

    const year = parseInt(e.target.value);

    if (e.target.checked) {
        state.pendingPM25Loads.add(year);
        setInteractivityEnabled(false);
        showLoading();

        await loadPM25YearDataHF(year);

        state.pendingPM25Loads.delete(year);

        if (state.pendingPM25Loads.size === 0) {
            hideLoading();
            rebuildDateIndex();
            updateMapColors();
            setInteractivityEnabled(true);
        }
    } else {
        delete state.loadedPM25YearData[year];
        rebuildDateIndex();
        updateMapColors();
    }
}

function handleSliderChange(e) {
    state.currentDateIndex = parseInt(e.target.value);
    updateDateDisplay();
    updateMapColors();
}

function handleTempTypeChange(e) {
    state.currentTempType = e.target.value;
    if (state.currentMode === 'temp') {
        updateMapHeader();
    }
    updateMapColors();
}

// ============================================
// PLAYBACK — requestAnimationFrame based
//
// WHY RAF instead of setInterval:
//   setInterval fires on a wall-clock schedule regardless of how long each frame
//   takes. With ~30k setAttribute calls per frame, a single tick can exceed the
//   interval period, causing callbacks to queue up. When the main thread catches
//   up, queued ticks fire back-to-back — producing the "freeze then jump" effect.
//
//   requestAnimationFrame self-schedules: the next frame only queues AFTER the
//   browser has painted the current one. Combined with elapsed-time gating for
//   fps control, this guarantees at most one data update per paint cycle and
//   eliminates callback accumulation entirely.
//
//   Bonus: RAF automatically pauses when the tab is hidden.
// ============================================

const playback = {
    rafId:    null,   // current requestAnimationFrame handle
    running:  false,
    lastTime: 0,
    fps:      6,      // frames per second — increased from 4 for snappier playback
};

const isPlaying = () => playback.running;

function playbackTick(now) {
    if (!playback.running) return;

    const elapsed = now - playback.lastTime;
    const frameMs = 1000 / playback.fps;

    if (elapsed >= frameMs) {
        // Advance one day
        if (state.currentDateIndex >= state.allDates.length - 1) {
            stopPlayback();
            return;
        }

        state.currentDateIndex++;
        document.getElementById('date-slider').value = state.currentDateIndex;
        updateDateDisplay();
        updateMapColors();

        // Use actual elapsed time for lastTime to avoid drift from integer division
        playback.lastTime = now - (elapsed % frameMs);
    }

    playback.rafId = requestAnimationFrame(playbackTick);
}

function startPlayback() {
    if (isPlaying() || !state.allDates.length) return;

    // If we're at the end, loop back to the start
    if (state.currentDateIndex >= state.allDates.length - 1) {
        state.currentDateIndex = 0;
        document.getElementById('date-slider').value = 0;
        updateDateDisplay();
    }

    document.getElementById('play-btn').textContent = '⏸ Pause';
    playback.running  = true;
    playback.lastTime = performance.now();
    playback.rafId    = requestAnimationFrame(playbackTick);
}

function stopPlayback() {
    if (playback.rafId !== null) {
        cancelAnimationFrame(playback.rafId);
        playback.rafId = null;
    }
    playback.running = false;
    document.getElementById('play-btn').textContent = '▶ Play';
}

function stepDate(dir) {
    if (!state.allDates.length) return;
    stopPlayback();
    state.currentDateIndex = Math.max(0, Math.min(state.allDates.length - 1, state.currentDateIndex + dir));
    document.getElementById('date-slider').value = state.currentDateIndex;
    updateDateDisplay();
    updateMapColors();
}

// ============================================
// INITIALIZATION
// ============================================

async function init() {
    showLoading();
    initMap();
    await loadBoundary();
    await loadClusters();
    hideLoading();

    // ── Temperature controls ──
    document.querySelectorAll('.year-checkbox')
        .forEach(cb => cb.addEventListener('change', handleYearCheckboxChange));

    document.querySelectorAll('input[name="temp-type"]')
        .forEach(r => r.addEventListener('change', handleTempTypeChange));

    // ── PM2.5 controls ──
    document.querySelectorAll('.pm25-year-checkbox')
        .forEach(cb => cb.addEventListener('change', handlePM25YearCheckboxChange));

    // ── Shared slider / play / keyboard ──
    document.getElementById('date-slider').addEventListener('input', handleSliderChange);
    document.getElementById('date-slider').addEventListener('mousedown', stopPlayback);
    document.getElementById('play-btn')
        .addEventListener('click', () => isPlaying() ? stopPlayback() : startPlayback());
    document.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight') { e.preventDefault(); stepDate(+1); }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); stepDate(-1); }
    });

    // ── Mode switcher (top nav) ──
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => switchMode(btn.dataset.mode));
    });

    window.addEventListener('resize', onResize);
}

document.addEventListener('DOMContentLoaded', init);