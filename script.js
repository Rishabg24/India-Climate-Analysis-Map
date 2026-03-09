// ============================================
// GLOBAL STATE
// ============================================

const state = {
    svg: null,
    projection: null,
    path: null,
    clusterLayers: {},      // clusterId -> D3 selection (the <circle> element)
    clustersData: null,
    loadedYearData: {},
    allDates: [],
    dateToDataMap: {},
    currentTempType: 'tmax',
    currentDateIndex: 0
};

const HF_BASE = 'https://huggingface.co/datasets/Lotus-28/India_Temperature_Analysis_Data/resolve/main'; // Datasets

// ============================================
// ZONE CONFIGURATION
// ============================================

const ZONE_CONFIG = {
    tropical: {
        codes: [0, 1, 2, 3, 4],
        minTemp: 15,
        maxTemp: 30,
        // Pink/rose scale (matches your CSS .tropical-gradient)
        colorScale: d3.scaleSequential(d3.interpolateRgbBasis([
            '#fde2e4', '#fbb6ce', '#f687b3', '#ed64a6', '#d53f8c', '#b83280'
        ]))
    },
    temperate: {
        codes: [6, 11, 12],
        minTemp: 16,
        maxTemp: 28,
        // Teal/green scale (matches your CSS .temperate-gradient)
        colorScale: d3.scaleSequential(d3.interpolateRgbBasis([
            '#d3f9d8', '#b2f5ea', '#81e6d9', '#4fd1c5', '#38b2ac', '#2c7a7b'
        ]))
    },
    cold: {
        codes: (() => {
            const codes = [5, 7, 8, 9, 10];
            for (let i = 13; i <= 29; i++) codes.push(i);
            return codes;
        })(),
        minTemp: 8,
        maxTemp: 25,
        // Indigo/blue scale (matches your CSS .cold-gradient)
        colorScale: d3.scaleSequential(d3.interpolateRgbBasis([
            '#e0e7ff', '#c3dafe', '#a3bffa', '#7f9cf5', '#667eea', '#5a67d8'
        ]))
    }
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

function getZoneType(kgCode) {
    if (ZONE_CONFIG.tropical.codes.includes(kgCode)) return 'tropical';
    if (ZONE_CONFIG.temperate.codes.includes(kgCode)) return 'temperate';
    return 'cold';
}

function calculateColor(kgCode, temperature) {
    if (temperature === null || temperature === undefined) {
        return '#e2e8f0'; // no-data gray
    }

    const zoneType = getZoneType(kgCode);
    const config = ZONE_CONFIG[zoneType];

    // Normalize temperature to [0, 1] within the zone's range, then clamp
    const t = Math.max(0, Math.min(1,
        (temperature - config.minTemp) / (config.maxTemp - config.minTemp)
    ));

    return config.colorScale(t);
}

function showLoading() {
    document.getElementById('loading-overlay').classList.add('active');
}

function hideLoading() {
    document.getElementById('loading-overlay').classList.remove('active');
}

// ============================================
// MAP INITIALIZATION  (D3, replaces L.map)
// ============================================

function initMap() {
    console.log('Initializing D3 map...');

    const container = document.getElementById('map');
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Mercator projection centered on India
    state.projection = d3.geoMercator()
        .center([82.0, 22.5])       // [longitude, latitude] of India's center
        .scale(1000)                // rough initial scale — fitExtent below will override
        .translate([width / 2, height / 2]);

    state.path = d3.geoPath().projection(state.projection);

    // Create the SVG that fills #map
    state.svg = d3.select('#map')
        .append('svg')
        .attr('width', width)
        .attr('height', height);

    // Group for the boundary so we can fit the projection to it later
    state.svg.append('g').attr('id', 'boundary-group');

    // Group for cluster dots, drawn on top of the boundary
    state.svg.append('g').attr('id', 'clusters-group');

    // Re-fit everything when the window is resized
    window.addEventListener('resize', onResize);

    console.log('D3 map initialized');
}

function onResize() {
    const container = document.getElementById('map');
    const width = container.clientWidth;
    const height = container.clientHeight;

    state.svg.attr('width', width).attr('height', height);

    // Re-fit projection if we have boundary data
    if (state.boundaryGeoJSON) {
        fitProjectionToBoundary(state.boundaryGeoJSON, width, height);
        redrawBoundary();
        redrawClusters();
    }
}

// Fit the Mercator projection so the boundary fills the SVG with padding
function fitProjectionToBoundary(geojson, width, height) {
    const padding = 20;
    state.projection.fitExtent(
        [[padding, padding], [width - padding, height - padding]],
        geojson
    );
    state.path = d3.geoPath().projection(state.projection);
}

// ============================================
// DATA LOADING  (fetch calls unchanged)
// ============================================

async function loadBoundary() {
    console.log('Loading India boundary...');

    try {
        const response = await fetch(`${HF_BASE}/india_boundary.geojson`);
        if (!response.ok) throw new Error(`Failed to load boundary: ${response.status}`);

        const boundaryData = await response.json();
        state.boundaryGeoJSON = boundaryData; // store for resize

        const container = document.getElementById('map');
        fitProjectionToBoundary(boundaryData, container.clientWidth, container.clientHeight);

        redrawBoundary();
        console.log('Boundary loaded');
    } catch (error) {
        console.error('Error loading boundary:', error);
        alert('Failed to load India boundary. Check that https://huggingface.co/datasets/Lotus-28/India_Temperature_Analysis_Data/Resolve/main/india_boundary.geojson exists.');
    }
}

function redrawBoundary() {
    const group = state.svg.select('#boundary-group');
    group.selectAll('*').remove();

    group.selectAll('path')
        .data(state.boundaryGeoJSON.features
            ? state.boundaryGeoJSON.features    // FeatureCollection
            : [state.boundaryGeoJSON])          // single Feature
        .enter()
        .append('path')
        .attr('class', 'india-boundary')
        .attr('d', state.path);
}

async function loadClusters() {
    console.log('Loading clusters...');

    try {
        const response = await fetch(`${HF_BASE}/clusters.geojson`);
        if (!response.ok) throw new Error(`Failed to load clusters: ${response.status}`);

        state.clustersData = await response.json();
        console.log(`Loaded ${state.clustersData.features.length} clusters`);

        redrawClusters();
        console.log('Clusters drawn on map');
    } catch (error) {
        console.error('Error loading clusters:', error);
        alert('Failed to load clusters. Check that https://huggingface.co/datasets/Lotus-28/India_Temperature_Analysis_Data/Resolve/main/clusters.geojson exists.');
    }
}

function redrawClusters() {
    if (!state.clustersData) return;

    const group = state.svg.select('#clusters-group');
    group.selectAll('*').remove();
    state.clusterLayers = {};

    state.clustersData.features.forEach(feature => {
        const clusterId = feature.properties.cluster_id;
        const coords = feature.geometry.coordinates; // [lon, lat]
        const [px, py] = state.projection(coords);

        const circle = group.append('circle')
            .attr('class', 'cluster-dot')
            .attr('cx', px)
            .attr('cy', py)
            .attr('r', 2.5)
            .attr('fill', '#cbd5e0')
            .attr('fill-opacity', 0.7);

        // Store the underlying DOM node for fast fill updates later
        state.clusterLayers[clusterId] = circle.node();
    });
}

async function loadYearData(year) {
    if (state.loadedYearData[year]) {
        console.log(`Year ${year} already loaded`);
        return state.loadedYearData[year];
    }

    console.log(`Loading year ${year}...`);
// https://huggingface.co/datasets/Lotus-28/India_Temperature_Analysis_Data/blob/main/temp_data_${year}.json
// https://huggingface.co/datasets/Lotus-28/India_Temperature_Analysis_Data/blob/main/temp_data_2016.json
    try {
        const response = await fetch(`${HF_BASE}/temp_data_${year}.json`);
        if (!response.ok) throw new Error(`Failed to load year ${year}: ${response.status}`);

        const yearData = await response.json();
        state.loadedYearData[year] = yearData;

        console.log(`Loaded ${year}: ${yearData.dates.length} days`);
        return yearData;
    } catch (error) {
        console.error(`Error loading year ${year}:`, error);
        alert(`Failed to load data for ${year}. Check that data/temp_data_${year}.json exists.`);
        return null;
    }
}

// ============================================
// DATE MANAGEMENT  (identical to original)
// ============================================

function rebuildDateIndex() {
    state.allDates = [];
    state.dateToDataMap = {};

    const checkedYears = Array.from(document.querySelectorAll('.year-checkbox:checked'))
        .map(cb => parseInt(cb.value))
        .sort();

    if (checkedYears.length === 0) {
        updateSlider();
        return;
    }

    checkedYears.forEach(year => {
        const yearData = state.loadedYearData[year];
        if (!yearData) return;

        yearData.dates.forEach((dateStr, idx) => {
            state.allDates.push(dateStr);
            state.dateToDataMap[dateStr] = { year, localIndex: idx };
        });
    });

    console.log(`Total dates available: ${state.allDates.length}`);
    updateSlider();
}

function updateSlider() {
    const slider = document.getElementById('date-slider');
    const playBtn = document.getElementById('play-btn');
    const dateDisplay = document.getElementById('current-date');

    if (state.allDates.length === 0) {
        slider.disabled = true;
        playBtn.disabled = true;
        slider.max = 0;
        dateDisplay.textContent = 'Select years to begin';
        return;
    }

    slider.disabled = false;
    playBtn.disabled = false;
    slider.max = state.allDates.length - 1;
    slider.value = state.currentDateIndex;

    updateDateDisplay();
}

function updateDateDisplay() {
    const dateDisplay = document.getElementById('current-date');

    if (state.allDates.length === 0) {
        dateDisplay.textContent = 'Select years to begin';
        return;
    }

    const currentDate = state.allDates[state.currentDateIndex];
    const dateObj = new Date(currentDate);
    const formatted = dateObj.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    dateDisplay.textContent = formatted;
}

// ============================================
// MAP COLOR UPDATE  (replaces circle.setStyle)
// ============================================

function updateMapColors() {
    if (!state.clustersData || state.allDates.length === 0) return;

    const currentDate = state.allDates[state.currentDateIndex];
    const dataInfo = state.dateToDataMap[currentDate];
    if (!dataInfo) return;

    const yearData = state.loadedYearData[dataInfo.year];
    if (!yearData) return;

    const tempData = state.currentTempType === 'tmax' ? yearData.tmax : yearData.tmin;

    state.clustersData.features.forEach(feature => {
        const clusterId = feature.properties.cluster_id;
        const kgCode = feature.properties.kg_code;
        const circleNode = state.clusterLayers[clusterId];

        if (!circleNode) return;

        const clusterTemps = tempData[clusterId];
        if (!clusterTemps) {
            circleNode.setAttribute('fill', '#e2e8f0');
            return;
        }

        const temperature = clusterTemps[dataInfo.localIndex];
        circleNode.setAttribute('fill', calculateColor(kgCode, temperature));
    });
}

// ============================================
// EVENT HANDLERS  (identical to original)
// ============================================

async function handleYearCheckboxChange(event) {
    const year = parseInt(event.target.value);
    const isChecked = event.target.checked;

    if (isChecked) {
        showLoading();
        await loadYearData(year);
        hideLoading();
    } else {
        delete state.loadedYearData[year];
    }

    rebuildDateIndex();
    updateMapColors();
}

function handleSliderChange(event) {
    state.currentDateIndex = parseInt(event.target.value);
    updateDateDisplay();
    updateMapColors();
}

function handleTempTypeChange(event) {
    state.currentTempType = event.target.value;

    document.getElementById('current-temp-type').textContent =
        state.currentTempType === 'tmax' ? 'Maximum Temperature' : 'Minimum Temperature';

    updateMapColors();
}

// ============================================
// PLAYBACK + KEYBOARD
// ============================================

const playback = {
    interval: null,
    fps: 10   // frames per second — increase to go faster
};

function isPlaying() {
    return playback.interval !== null;
}

function startPlayback() {
    if (isPlaying() || state.allDates.length === 0) return;

    // If already at the end, wrap back to start
    if (state.currentDateIndex >= state.allDates.length - 1) {
        state.currentDateIndex = 0;
    }

    document.getElementById('play-btn').textContent = '⏸ Pause';

    playback.interval = setInterval(() => {
        if (state.currentDateIndex >= state.allDates.length - 1) {
            stopPlayback();
            return;
        }
        state.currentDateIndex++;
        document.getElementById('date-slider').value = state.currentDateIndex;
        updateDateDisplay();
        updateMapColors();
    }, 1000 / playback.fps);
}

function stopPlayback() {
    clearInterval(playback.interval);
    playback.interval = null;
    document.getElementById('play-btn').textContent = '▶ Play';
}

function stepDate(direction) {
    // direction: +1 (forward) or -1 (backward)
    if (state.allDates.length === 0) return;
    stopPlayback(); // arrow keys cancel playback

    state.currentDateIndex = Math.max(0,
        Math.min(state.allDates.length - 1, state.currentDateIndex + direction)
    );

    document.getElementById('date-slider').value = state.currentDateIndex;
    updateDateDisplay();
    updateMapColors();
}

// ============================================
// INITIALIZATION
// ============================================

async function init() {
    console.log('Starting application...');

    showLoading();

    initMap();           // synchronous — just builds the SVG
    await loadBoundary();
    await loadClusters();

    hideLoading();

    document.querySelectorAll('.year-checkbox').forEach(cb =>
        cb.addEventListener('change', handleYearCheckboxChange)
    );

    document.getElementById('date-slider')
        .addEventListener('input', handleSliderChange);

    document.querySelectorAll('input[name="temp-type"]').forEach(radio =>
        radio.addEventListener('change', handleTempTypeChange)
    );
    document.getElementById('play-btn')
        .addEventListener('click', () => isPlaying() ? stopPlayback() : startPlayback());

    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); stepDate(+1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); stepDate(-1); }
    });

    // Also stop playback if the user manually drags the slider
    document.getElementById('date-slider')
        .addEventListener('mousedown', stopPlayback);

    console.log('Application ready!');
}

document.addEventListener('DOMContentLoaded', init);