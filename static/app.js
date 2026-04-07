/* BirdWeather Data Explorer — Frontend */

let currentTab = "rhythm";
let currentSpeciesId = null;
let speciesList = [];
let leafletMap = null;

// --- Language support ---
let currentLang = "en";
let translations = {};  // scientific_name -> {en, nl, fr, it}

function getSpeciesName(sp) {
    if (!sp) return "";
    if (currentLang === "la") return sp.scientific_name;
    const t = translations[sp.scientific_name];
    if (t && t[currentLang]) return t[currentLang];
    return sp.common_name;  // fallback to English
}

function getSpeciesNameById(speciesId) {
    const sp = speciesList.find(s => s.species_id == speciesId);
    return sp ? getSpeciesName(sp) : "";
}

async function setLang(lang) {
    currentLang = lang;
    document.querySelectorAll(".lang-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.lang === lang);
    });
    // Re-render species list and info card
    renderSpeciesList(document.getElementById("species-search").value);
    renderSpeciesInfo();
    // Re-render current tab to update chart titles
    renderCurrentTab();
}
let mapMarkers = null;
let predictMap = null;
let predictMarker = null;
let predictMode = "point";  // "point" or "density"
let densityRectangles = [];  // L.rectangle layers for density map
let ecologyData = null;
let mapMode = "stations";  // "stations" or "density"
let densityData = null;
let densityMarkers = null;

// Track sub-plot IDs for cleanup to prevent WebGL context exhaustion
let activePlotIds = [];
let ecoHoverPlotIds = [];

// AbortController: cancel in-flight API requests on tab/species switch
let currentController = null;

// Debounce timer for species selection
let renderDebounceTimer = null;

// Render generation counter — prevents stale async renders from writing to DOM
let renderGen = 0;

// Debounce timer for ecology hover panel
let ecoHoverTimer = null;

// Mode switching state
let currentMode = "overview";
let lastExplorerTab = "rhythm";
let lastOverviewTab = "ecology";
const EXPLORER_TABS = new Set(["rhythm","daily","heatmap","insights","weather","correlations","map","migration","fp"]);
const OVERVIEW_TABS = new Set(["ecology","predict","methodology"]);

// --- Tab info tooltips ---
const TAB_INFO = {
    rhythm: {
        title: "Activity Rhythm",
        text: "Shows when a species is most active relative to sunrise. Detections are binned into 15-minute intervals centered on each station's local sunrise time (computed from latitude/longitude and date). The curve represents the mean proportion of daily detections per bin, averaged across all station-days. The shaded band shows \u00b11 standard deviation.",
    },
    daily: {
        title: "Daily Detection Counts",
        text: "Total number of acoustic detections per day across all stations in the Netherlands. Reflects both actual bird activity and station availability \u2014 drops may indicate station outages rather than true absence. No normalization is applied.",
    },
    heatmap: {
        title: "Detection Heatmap",
        text: "A date \u00d7 hour-of-day matrix where color intensity encodes detection counts. Reveals seasonal shifts in daily activity patterns \u2014 e.g., dawn chorus timing moving earlier in spring, or nocturnal activity peaks. Each cell sums detections across all stations.",
    },
    insights: {
        title: "ML Insights",
        text: "Feature importance from two LightGBM models trained per species: a binary classifier (detection present/absent per station-day) and a count model (detection volume). Features include hour of day, month, temperature, wind, cloud cover, solar radiation, population density, and land use. The radar chart groups features by category. Hourly and monthly patterns show raw aggregated activity.",
    },
    weather: {
        title: "Weather Overlay",
        text: "Daily detection counts plotted alongside daily-averaged weather variables from the Open-Meteo historical archive, spatially averaged across a grid covering the Netherlands. Variables: temperature (\u00b0C), precipitation (mm), wind speed (m/s), cloud cover (%), and solar radiation (W/m\u00b2).",
    },
    correlations: {
        title: "Weather Correlations",
        text: "Weather variables binned into 20 equal-width intervals (trimmed at the 2nd and 98th percentiles). For each bin, the mean and median daily detection count is shown. This reveals non-linear relationships \u2014 e.g., some species may peak at intermediate temperatures. No causal inference is implied; confounding by season is expected.",
    },
    map: {
        title: "Station Map",
        text: "Each circle represents a BirdWeather station. Circle size is proportional to detection count; color encodes population density from the GHS-POP dataset at 1\u2009km resolution. Switch to Density mode to see total detection volume per station across all species. Station locations are as reported by BirdWeather.",
    },
    migration: {
        title: "Migration & Phenology",
        text: "Spatial detection rates animated week by week. The Netherlands is divided into a 0.1\u00b0\u00d70.1\u00b0 grid. Detection rate = detections / active stations per cell per week, normalizing for uneven station density. The 12 monthly panels show the same metric averaged per month. Useful for tracking arrival/departure timing and spatial spread of migratory species.",
    },
    fp: {
        title: "False Positive Analysis",
        text: "Co-occurrence analysis to detect potential BirdNET misidentifications. For each species pair, we compute: PMI (pointwise mutual information \u2014 how much more often they co-occur than expected), dependency ratio (fraction of species B detections that co-occur with species A within a \u00b160s window), and asymmetry. High PMI + high dependency + low confidence suggest species B may be a systematic misidentification of species A.",
    },
    ecology: {
        title: "Behavioral Clustering",
        text: "Each species is represented by a behavioral profile: 24 hourly activity values, 12 monthly activity values, nocturnality, dawn focus, seasonality, and urban affinity. Profiles are standardized and projected to 2D via UMAP (or PCA). Hierarchical clustering groups species with similar temporal niches. Hover over a point to see the species' activity patterns and spatial distribution across stations.",
    },
    predict: {
        title: "Species Prediction",
        text: "Uses per-species LightGBM models to estimate the probability of detecting each species at a given location and time, incorporating live weather data. Available only in the full (local) version of the application.",
    },
    methodology: {
        title: "Methodology",
        text: "Detailed documentation of all data processing, analysis methods, and visualizations used in this explorer.",
    },
};

function showTabInfo() {
    const info = TAB_INFO[currentTab];
    if (!info) return;
    const el = document.getElementById("tab-info-tooltip");
    el.innerHTML = `<h4>${info.title}</h4><p>${info.text}</p><span class="tip-link" onclick="goToMethodology()">Full methodology \u2192</span>`;
    el.classList.add("visible");
}

function hideTabInfo() {
    document.getElementById("tab-info-tooltip").classList.remove("visible");
}

function goToMethodology() {
    hideTabInfo();
    switchMode("overview");
    switchTab("methodology");
}

function purgeActivePlots() {
    for (const id of activePlotIds) {
        const el = document.getElementById(id);
        if (el) { try { Plotly.purge(el); } catch (_) {} }
    }
    activePlotIds = [];
    purgeEcoHoverPlots();
}

function purgeEcoHoverPlots() {
    for (const id of ecoHoverPlotIds) {
        const el = document.getElementById(id);
        if (el) { try { Plotly.purge(el); } catch (_) {} }
    }
    ecoHoverPlotIds = [];
}

// Solar position helpers — centered on noon (0.5), axis range [-0.5, 1.5]
// 0=Sunrise, 0.5=Noon, 1.0=Sunset, -0.5/1.5=Midnight
const SOLAR_TICK_VALS = [-0.5, -0.25, 0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5];
const SOLAR_TICK_TEXT = ["Midnight","","Sunrise","","Noon","","Sunset","","Midnight"];
const SOLAR_TICK_VALS_SHORT = [-0.5, 0, 0.5, 1.0, 1.5];
const SOLAR_TICK_TEXT_SHORT = ["Midnt","Rise","Noon","Set","Midnt"];
const SOLAR_RANGE = [-0.5, 1.5];
function solarCenter(pos) { return pos >= 1.5 ? pos - 2.0 : pos; }
function solarCenterArray(arr) { return arr.map(solarCenter); }
function solarCenterSorted(xArr, yArr) {
    const pairs = xArr.map((x, i) => [solarCenter(x), yArr[i]]);
    pairs.sort((a, b) => a[0] - b[0]);
    return { x: pairs.map(p => p[0]), y: pairs.map(p => p[1]) };
}
function solarLabel(pos) {
    const p = pos >= 1.5 ? pos - 2.0 : pos;
    if (Math.abs(p) < 0.05 || Math.abs(p - 2.0) < 0.05) return "Sunrise";
    if (Math.abs(p - 0.5) < 0.05) return "Noon";
    if (Math.abs(p - 1.0) < 0.05) return "Sunset";
    if (Math.abs(p - 1.5) < 0.05 || Math.abs(p + 0.5) < 0.05) return "Midnight";
    if (p >= 0 && p < 1) return `Day ${(p*100).toFixed(0)}%`;
    if (p >= 1) return `Night ${((p-1)*100).toFixed(0)}%`;
    return `Night ${((p+1)*100).toFixed(0)}%`;
}

const plotLayout = {
    margin: { t: 40, r: 30, b: 60, l: 60 },
    font: { family: "-apple-system, BlinkMacSystemFont, sans-serif" },
};

// --- Intro modal ---

function closeIntro() {
    document.getElementById("intro-overlay").classList.add("hidden");
    sessionStorage.setItem("intro-seen", "1");
    // Start in overview mode
    switchMode("overview");
}

function openIntro() {
    document.getElementById("intro-overlay").classList.remove("hidden");
}

// --- Init ---

async function init() {
    // Show intro on first visit per session
    if (sessionStorage.getItem("intro-seen")) {
        document.getElementById("intro-overlay").classList.add("hidden");
    }
    // Load translations
    try {
        translations = await (await fetch("data/translations.json")).json();
    } catch (_) {}
    const status = await fetchJSON("/api/status");
    updateStatus(status);
    if (status.has_data) {
        await loadSpecies();
        // Start in overview mode
        switchMode("overview");
    }
}

function updateStatus(status) {
    const el = document.getElementById("status-text");
    const summary = document.getElementById("data-summary");
    const summaryText = document.getElementById("summary-text");

    if (status.has_data) {
        el.textContent = `${status.species_count} species, ${status.detection_count.toLocaleString()} detections`;

        const parts = [];
        parts.push(`${status.station_count} stations`);
        parts.push(`${status.day_count} days`);
        if (status.date_min && status.date_max) {
            parts.push(`${status.date_min} to ${status.date_max}`);
        }
        if (status.last_updated) {
            const d = new Date(status.last_updated);
            parts.push(`last updated ${d.toLocaleString()}`);
        }
        summaryText.textContent = parts.join("  \u00b7  ");
        summary.style.display = "block";
    } else {
        el.textContent = "No data yet \u2014 run download_data.py to fetch from BirdWeather";
        summary.style.display = "none";
    }
}

// --- Species list ---

async function loadSpecies() {
    speciesList = await fetchJSON("/api/species");
    renderSpeciesList();
    if (speciesList.length > 0) {
        selectSpecies(speciesList[0].species_id);
    }
}

function renderSpeciesList(filter = "") {
    const container = document.getElementById("species-list");
    const lowerFilter = filter.toLowerCase();

    let html = `<div class="species-item all-species${currentSpeciesId === 'all' ? ' active' : ''}" onclick="selectSpecies('all')">
        <div class="species-thumb-placeholder">\u2261</div>
        <div class="species-item-text">
            <div class="species-item-name">All species overlay</div>
            <div class="species-item-count">Rhythm comparison</div>
        </div>
    </div>`;

    for (const sp of speciesList) {
        const displayName = getSpeciesName(sp);
        if (lowerFilter && !displayName.toLowerCase().includes(lowerFilter)
            && !sp.common_name.toLowerCase().includes(lowerFilter)
            && !sp.scientific_name.toLowerCase().includes(lowerFilter)) {
            continue;
        }
        const isActive = currentSpeciesId === sp.species_id;
        const noData = !sp.has_local_data;
        const thumbHtml = sp.image_path
            ? `<img class="species-thumb" src="${sp.image_path}" alt="" loading="lazy">`
            : `<div class="species-thumb-placeholder">\ud83d\udc26</div>`;
        html += `<div class="species-item${isActive ? ' active' : ''}${noData ? ' no-local-data' : ''}" onclick="selectSpecies(${sp.species_id})">
            ${thumbHtml}
            <div class="species-item-text">
                <div class="species-item-name">${displayName}</div>
                <div class="species-item-count">${sp.detection_count.toLocaleString()} detections${noData ? ' (API only)' : ''}</div>
            </div>
        </div>`;
    }
    container.innerHTML = html;
}

function filterSpecies() {
    const query = document.getElementById("species-search").value;
    renderSpeciesList(query);
}

function selectSpecies(id) {
    currentController?.abort();
    currentSpeciesId = id;
    // Purge chart immediately to free WebGL contexts before re-render
    try { Plotly.purge("chart"); } catch (_) {}
    document.getElementById("chart").innerHTML = "";
    purgeActivePlots();
    renderSpeciesList(document.getElementById("species-search").value);
    renderSpeciesInfo();
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(renderCurrentTab, 150);
}

function renderSpeciesInfo() {
    const card = document.getElementById("species-info");
    if (currentMode === "overview" || currentSpeciesId === "all" || !currentSpeciesId) {
        card.style.display = "none";
        return;
    }
    const sp = speciesList.find(s => s.species_id === currentSpeciesId);
    if (!sp) { card.style.display = "none"; return; }

    card.style.display = "flex";
    const img = document.getElementById("species-img");
    if (sp.image_path) {
        img.src = sp.image_path;
        img.style.display = "block";
    } else {
        img.style.display = "none";
    }
    document.getElementById("species-common-name").textContent = getSpeciesName(sp);
    document.getElementById("species-scientific-name").textContent = currentLang === "la" ? sp.common_name : sp.scientific_name;
    document.getElementById("species-count").textContent = `${sp.detection_count.toLocaleString()} detections`;

    const summaryEl = document.getElementById("species-wiki-summary");
    const linkEl = document.getElementById("species-wiki-link");
    if (sp.wikipedia_summary) {
        summaryEl.textContent = sp.wikipedia_summary;
        summaryEl.style.display = "block";
    } else {
        summaryEl.style.display = "none";
    }
    if (sp.wikipedia_url) {
        linkEl.href = sp.wikipedia_url;
        linkEl.style.display = "inline";
    } else {
        linkEl.style.display = "none";
    }
}

// --- Mode switching ---

function switchMode(mode) {
    currentMode = mode;
    // Toggle active button
    document.querySelectorAll("#mode-nav .mode-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    // Show/hide tab groups
    document.getElementById("tabs-explorer").style.display = mode === "explorer" ? "flex" : "none";
    document.getElementById("tabs-overview").style.display = mode === "overview" ? "flex" : "none";
    // Toggle layout class for full-width in overview mode
    document.getElementById("layout").classList.toggle("layout-overview", mode === "overview");
    // Hide species info card and sidebar in overview mode (override inline styles)
    document.getElementById("species-panel").style.display = mode === "overview" ? "none" : "";
    document.getElementById("species-info").style.display = mode === "overview" ? "none" : "";
    // Pick the right tab
    const tab = mode === "explorer" ? lastExplorerTab : lastOverviewTab;
    switchTab(tab);
    // Restore species info card when switching back to explorer
    if (mode === "explorer") renderSpeciesInfo();
}

// --- Tabs ---

function switchTab(tab) {
    // Cancel any in-flight API requests from previous tab
    currentController?.abort();
    // Bump render generation to invalidate any in-flight async renders
    renderGen++;
    // Cancel any pending debounce from selectSpecies
    clearTimeout(renderDebounceTimer);
    currentTab = tab;
    // Track last active tab per mode
    if (EXPLORER_TABS.has(tab)) lastExplorerTab = tab;
    if (OVERVIEW_TABS.has(tab)) lastOverviewTab = tab;
    // Stop migration animation if leaving that tab
    if (migrationAnimTimer) {
        clearInterval(migrationAnimTimer);
        migrationAnimTimer = null;
    }
    // Purge all Plotly plots from previous tab to free WebGL contexts
    try { Plotly.purge("chart"); } catch (_) {}
    purgeActivePlots();
    // Reset chart container height (insights sets it to "auto")
    const chartReset = document.getElementById("chart");
    if (chartReset) chartReset.style.height = "";
    // Free cached data when leaving heavy tabs
    if (tab !== "ecology") {
        ecologyData = null;
        if (ecoDensityMap) { ecoDensityMap.remove(); ecoDensityMap = null; ecoDensityLayer = null; ecoStationLayer = null; }
    }
    if (tab !== "map") densityData = null;
    // Destroy migration Leaflet map when leaving that tab
    if (tab !== "migration" && migAnimMap) {
        migAnimMap.remove();
        migAnimMap = null;
        migAnimLayer = null;
    }
    document.querySelectorAll(".tab").forEach(el => {
        el.classList.toggle("active", el.dataset.tab === tab);
    });

    // Toggle chart vs map vs predict vs ecology vs migration visibility
    const chartEl = document.getElementById("chart");
    const mapEl = document.getElementById("map-container");
    const predictEl = document.getElementById("predict-container");
    const ecologyEl = document.getElementById("ecology-container");
    const migrationEl = document.getElementById("migration-container");
    const methodEl = document.getElementById("methodology-container");
    chartEl.style.display = "none";
    mapEl.style.display = "none";
    predictEl.style.display = "none";
    ecologyEl.style.display = "none";
    migrationEl.style.display = "none";
    methodEl.style.display = "none";
    if (tab === "map") {
        mapEl.style.display = "block";
    } else if (tab === "predict") {
        predictEl.style.display = "block";
    } else if (tab === "ecology") {
        ecologyEl.style.display = "block";
    } else if (tab === "migration") {
        migrationEl.style.display = "block";
    } else if (tab === "methodology") {
        methodEl.style.display = "block";
    } else {
        chartEl.style.display = "block";
    }

    renderCurrentTab();
}

async function renderCurrentTab() {
    // Overview tabs don't need a species selection
    if (!currentSpeciesId && !OVERVIEW_TABS.has(currentTab)) return;

    // "All species" only works for rhythm, ecology, and FP tabs
    if (currentSpeciesId === "all" && currentTab !== "rhythm" && currentTab !== "fp" && currentTab !== "ecology") {
        if (speciesList.length > 0) {
            selectSpecies(speciesList[0].species_id);
        }
        return;
    }

    try {
        switch (currentTab) {
            case "rhythm": return await plotRhythm();
            case "daily": return await plotDaily();
            case "heatmap": return await plotHeatmap();
            case "insights": return await plotInsights();
            case "weather": return await plotWeather();
            case "correlations": return await plotCorrelations();
            case "map": return await plotMap();
            case "migration": return await plotMigration();
            case "ecology": return await plotEcology();
            case "predict": return await initPredict();
            case "fp": return await plotFalsePositives();
            case "methodology": return renderMethodology();
        }
    } catch (e) {
        if (e.name === "AbortError") return; // Request cancelled by tab switch — ignore
        const target = currentTab === "map" ? "map-container" :
                       currentTab === "ecology" ? "ecology-container" :
                       currentTab === "migration" ? "migration-container" : "chart";
        document.getElementById(target).innerHTML = `<p style="padding:2rem;color:#e74c3c;">${e.message}</p>`;
    }
}

// --- Charts ---

async function plotRhythm() {
    Plotly.purge("chart");
    const solarAxis = {
        title: "Solar position",
        range: SOLAR_RANGE,
        tickvals: SOLAR_TICK_VALS,
        ticktext: SOLAR_TICK_TEXT,
    };
    const sunShapes = [
        { type: "line", x0: 0, x1: 0, y0: 0, y1: 1, yref: "paper", line: { color: "orange", dash: "dash", width: 2 } },
        { type: "line", x0: 1.0, x1: 1.0, y0: 0, y1: 1, yref: "paper", line: { color: "#9b59b6", dash: "dash", width: 2 } },
    ];
    if (currentSpeciesId === "all") {
        const data = await fetchJSON("/api/rhythm-all");
        const traces = [];
        for (const [sid, r] of Object.entries(data)) {
            const color = r.color || "#333";
            const sorted = solarCenterSorted(r.solar_bin_centers || [], r.solar_pattern || []);
            traces.push({
                x: sorted.x, y: sorted.y,
                name: `${getSpeciesNameById(sid) || r.common_name}`,
                type: "scatter", mode: "lines",
                line: { color, width: 2 },
            });
        }
        Plotly.newPlot("chart", traces, {
            ...plotLayout,
            title: "Solar Activity \u2014 All Species",
            xaxis: solarAxis,
            yaxis: { title: "Relative activity" },
            shapes: sunShapes,
        }, { responsive: true });
    } else {
        const data = await fetchJSON(`/api/insights/${currentSpeciesId}`);
        const name = getSpeciesNameById(currentSpeciesId);
        const sorted = solarCenterSorted(data.solar_bin_centers || [], data.solar_pattern || []);
        const peak = solarCenter(data.metrics?.peak_solar_pos ?? 0);
        Plotly.newPlot("chart", [{
            x: sorted.x, y: sorted.y,
            type: "scatter", mode: "lines",
            fill: "tozeroy", fillcolor: "rgba(41,128,185,0.15)",
            line: { color: "#2980b9", width: 2.5 },
            name: name,
        }], {
            ...plotLayout,
            title: `Solar Activity \u2014 ${name}`,
            xaxis: solarAxis,
            yaxis: { title: "Relative activity" },
            shapes: [...sunShapes,
                { type: "line", x0: peak, x1: peak, y0: 0, y1: 1, yref: "paper",
                  line: { color: "#e74c3c", dash: "dash", width: 1.5 } }],
            annotations: [{ x: peak, y: 1.05, yref: "paper",
                text: `Peak: ${solarLabel(data.metrics?.peak_solar_pos ?? 0)}`,
                showarrow: false, font: { size: 11, color: "#e74c3c" } }],
        }, { responsive: true });
    }
}

async function plotDaily() {
    Plotly.purge("chart");
    const data = await fetchJSON(`/api/daily/${currentSpeciesId}`);
    const name = getSpeciesNameById(currentSpeciesId);
    Plotly.newPlot("chart", [{
        x: data.dates,
        y: data.counts,
        type: "bar",
        marker: { color: "#2980b9" },
    }], {
        ...plotLayout,
        title: `Daily Detection Counts \u2014 ${name}`,
        xaxis: { title: "Date" },
        yaxis: { title: "Number of detections" },
    }, { responsive: true });
}

async function plotHeatmap() {
    Plotly.purge("chart");
    const data = await fetchJSON(`/api/heatmap/${currentSpeciesId}`);
    const name = getSpeciesNameById(currentSpeciesId);
    Plotly.newPlot("chart", [{
        x: data.dates,
        y: data.hours,
        z: data.values.map(row => row),
        type: "heatmap",
        colorscale: "YlOrRd",
        transpose: true,
    }], {
        ...plotLayout,
        title: `Detection Heatmap \u2014 ${name}`,
        xaxis: { title: "Date" },
        yaxis: { title: "Hour of day (UTC)", dtick: 3 },
    }, { responsive: true });
}

// --- Insights (ML feature importance) ---

async function plotInsights() {
    const data = await fetchJSON(`/api/insights/${currentSpeciesId}`);
    const name = getSpeciesNameById(currentSpeciesId) || data.common_name || "";
    const fi = data.feature_importance;
    const radar = data.radar;
    const metrics = data.metrics;

    const chartEl = document.getElementById("chart");
    // Purge any existing Plotly instances in this container
    purgeActivePlots();
    chartEl.style.height = "auto";
    chartEl.innerHTML = `
        <div id="insights-metrics"></div>
        <div id="insights-grid">
            <div id="insights-butterfly"></div>
            <div id="insights-radar"></div>
            <div id="insights-hourly"></div>
            <div id="insights-monthly"></div>
        </div>`;
    activePlotIds = ["insights-butterfly", "insights-radar", "insights-hourly", "insights-monthly"];

    // Metrics banner
    const metricsHtml = [
        `<div class="metric-card"><span class="metric-val">${solarLabel(metrics.peak_solar_pos)}</span><span class="metric-label">Peak Activity</span></div>`,
        `<div class="metric-card"><span class="metric-val">${(metrics.nocturnality * 100).toFixed(0)}%</span><span class="metric-label">Nocturnality</span></div>`,
        `<div class="metric-card"><span class="metric-val">${(metrics.dawn_focus * 100).toFixed(0)}%</span><span class="metric-label">Dawn Focus</span></div>`,
        `<div class="metric-card"><span class="metric-val">${metrics.seasonality.toFixed(1)}x</span><span class="metric-label">Seasonality</span></div>`,
        `<div class="metric-card"><span class="metric-val">${metrics.active_months}</span><span class="metric-label">Active Months</span></div>`,
        `<div class="metric-card"><span class="metric-val">${Math.round(metrics.urban_affinity)}</span><span class="metric-label">Urban Affinity</span></div>`,
    ].join("");
    document.getElementById("insights-metrics").innerHTML = metricsHtml;

    // 1. Butterfly chart (binary left, count right)
    const featureLabels = fi.binary_features.map(f => f.replace(/_/g, " "));
    const butterflyTraces = [
        {
            y: featureLabels, x: fi.binary_pct.map(v => -v),
            type: "bar", orientation: "h", name: "Binary (presence)",
            marker: { color: fi.binary_group_colors },
            hovertemplate: "%{y}: %{customdata:.1f}%<extra>Binary</extra>",
            customdata: fi.binary_pct,
        },
    ];
    // Count model has fewer features - pad to align
    const countY = [], countX = [], countColors = [];
    for (let i = 0; i < fi.binary_features.length; i++) {
        const ci = fi.count_features.indexOf(fi.binary_features[i]);
        countY.push(featureLabels[i]);
        countX.push(ci >= 0 ? fi.count_pct[ci] : 0);
        countColors.push(ci >= 0 ? "#e67e22" : "#ddd");
    }
    butterflyTraces.push({
        y: countY, x: countX,
        type: "bar", orientation: "h", name: "Count (activity)",
        marker: { color: countColors },
        hovertemplate: "%{y}: %{x:.1f}%<extra>Count</extra>",
    });

    const maxPct = Math.max(...fi.binary_pct, ...fi.count_pct, 1);
    Plotly.newPlot("insights-butterfly", butterflyTraces, {
        ...plotLayout,
        title: { text: `Feature Importance \u2014 ${name}`, font: { size: 14 } },
        barmode: "overlay",
        xaxis: { title: "Importance (%)", range: [-maxPct * 1.1, maxPct * 1.1],
            tickvals: [-maxPct, -maxPct/2, 0, maxPct/2, maxPct].map(v => Math.round(v)),
            ticktext: [maxPct, maxPct/2, 0, maxPct/2, maxPct].map(v => Math.abs(Math.round(v)) + "%") },
        yaxis: { automargin: true },
        height: 380,
        annotations: [
            { x: -maxPct * 0.5, y: 1.06, xref: "x", yref: "paper", text: "<b>Binary (presence)</b>", showarrow: false, font: { size: 11, color: "#e74c3c" } },
            { x: maxPct * 0.5, y: 1.06, xref: "x", yref: "paper", text: "<b>Count (activity)</b>", showarrow: false, font: { size: 11, color: "#e67e22" } },
        ],
        showlegend: false,
        margin: { ...plotLayout.margin, l: 140 },
    }, { responsive: true });

    // 2. Radar chart
    const radarTraces = [
        {
            type: "scatterpolar", name: "Binary",
            r: [...radar.binary_values, radar.binary_values[0]],
            theta: [...radar.groups, radar.groups[0]],
            fill: "toself", fillcolor: "rgba(231,76,60,0.15)",
            line: { color: "#e74c3c", width: 2 },
        },
        {
            type: "scatterpolar", name: "Count",
            r: [...radar.count_values, radar.count_values[0]],
            theta: [...radar.groups, radar.groups[0]],
            fill: "toself", fillcolor: "rgba(230,126,34,0.15)",
            line: { color: "#e67e22", width: 2 },
        },
    ];
    Plotly.newPlot("insights-radar", radarTraces, {
        ...plotLayout,
        title: { text: "Feature Group Importance", font: { size: 14 } },
        polar: { radialaxis: { visible: true, range: [0, 1] } },
        showlegend: true, legend: { x: 0.8, y: 0.05 },
        height: 380,
    }, { responsive: true });

    // 3. Solar activity pattern
    const insSorted = solarCenterSorted(data.solar_bin_centers || Array.from({ length: data.solar_pattern.length }, (_, i) => i * 2 / data.solar_pattern.length), data.solar_pattern);
    const peakC = solarCenter(metrics.peak_solar_pos);
    Plotly.newPlot("insights-hourly", [{
        x: insSorted.x, y: insSorted.y,
        type: "scatter", mode: "lines",
        fill: "tozeroy", fillcolor: "rgba(41,128,185,0.15)",
        line: { color: "#2980b9", width: 2 },
    }], {
        ...plotLayout,
        title: { text: "Solar Activity Pattern", font: { size: 14 } },
        xaxis: {
            title: "Solar position",
            range: SOLAR_RANGE,
            tickvals: SOLAR_TICK_VALS,
            ticktext: SOLAR_TICK_TEXT,
        },
        yaxis: { title: "Relative activity" },
        height: 300,
        shapes: [
            { type: "line", x0: peakC, x1: peakC,
              y0: 0, y1: 1, yref: "paper", line: { color: "#e74c3c", dash: "dash", width: 1.5 } },
            { type: "line", x0: 0, x1: 0,
              y0: 0, y1: 1, yref: "paper", line: { color: "orange", dash: "dot", width: 1 } },
            { type: "line", x0: 1.0, x1: 1.0,
              y0: 0, y1: 1, yref: "paper", line: { color: "#9b59b6", dash: "dot", width: 1 } },
        ],
        annotations: [{ x: peakC, y: 1.05, yref: "paper",
            text: `Peak: ${solarLabel(metrics.peak_solar_pos)}`, showarrow: false, font: { size: 10, color: "#e74c3c" } }],
    }, { responsive: true });

    // 4. Monthly pattern
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    Plotly.newPlot("insights-monthly", [{
        x: monthNames, y: data.monthly_pattern,
        type: "bar",
        marker: { color: data.monthly_pattern.map(v => {
            const t = v / Math.max(...data.monthly_pattern, 0.001);
            return `rgba(46,204,113,${0.3 + t * 0.7})`;
        }) },
    }], {
        ...plotLayout,
        title: { text: "Monthly Activity Pattern", font: { size: 14 } },
        xaxis: { title: "Month" },
        yaxis: { title: "Relative activity" },
        height: 300,
    }, { responsive: true });
}

// --- Ecology (behavioral clustering) ---

function renderMethodology() {
    const el = document.getElementById("methodology-container");
    el.innerHTML = `
<div class="method-page">

<h1>Methodology</h1>
<p class="method-intro">This page describes the data sources, processing pipeline, and analytical methods behind every visualization in the BirdWeather Explorer. The goal is full transparency: every number on a chart can be traced back to a concrete computation described here.</p>

<section class="method-section">
<h2>1. Data Collection</h2>
<h3>Source</h3>
<p>All detections come from the <a href="https://www.birdweather.com" target="_blank" rel="noopener">BirdWeather</a> network. Citizen-science stations running <a href="https://www.birdweather.com/birdnetpi" target="_blank" rel="noopener">BirdNET-Pi</a> record ambient audio 24/7 and classify bird sounds using the <a href="https://birdnet.cornell.edu" target="_blank" rel="noopener">BirdNET</a> deep learning model (developed by Stefan Kahl et al. at the Cornell Lab of Ornithology and Chemnitz University of Technology).</p>

<h3>Spatial &amp; temporal scope</h3>
<ul>
<li><strong>Region:</strong> The Netherlands (bounding box ~50.7–53.6°N, 3.3–7.2°E).</li>
<li><strong>Period:</strong> March 2025 – March 2026 (one full year).</li>
<li><strong>Stations:</strong> 851 unique stations contributed data during this period.</li>
<li><strong>Volume:</strong> Over 36 million individual detections.</li>
</ul>

<h3>Species filtering</h3>
<p>Of the hundreds of species flagged by BirdNET, 116 were retained based on having a sufficient number of detections across multiple stations and days. Rare vagrants and species with very few detections were excluded to ensure statistical robustness.</p>

<h3>Confidence threshold</h3>
<p>Each BirdNET detection includes a confidence score (0–1). Only detections above the station's configured threshold (typically ≥0.7) are recorded by BirdWeather. No additional confidence filtering is applied in this explorer, but the FP Analysis tab investigates potential misidentifications.</p>
</section>

<section class="method-section">
<h2>2. Activity Rhythm (Solar Position)</h2>
<p>The rhythm chart shows when a species vocalizes relative to the sun's position, revealing whether it is a dawn singer, dusk caller, or active throughout the day.</p>

<h3>Normalized Solar Position</h3>
<p>Instead of raw clock hours or minutes-from-sunrise, all temporal activity is expressed as a <strong>Normalized Solar Position</strong> on a [0, 2) cycle:</p>
<ul>
<li><strong>0.0</strong> = Sunrise</li>
<li><strong>0.5</strong> = Solar noon (midpoint of daylight)</li>
<li><strong>1.0</strong> = Sunset</li>
<li><strong>1.5</strong> = Solar midnight (midpoint of darkness)</li>
<li><strong>2.0</strong> = Next sunrise (wraps to 0.0)</li>
</ul>
<p>This normalization accounts for variable day and night length across seasons. In June, sunrise in the Netherlands is ~3:15 UTC and sunset ~21:00; in December, sunrise is ~8:45 and sunset ~16:30. A dawn-chorus species always peaks near solar position 0.0–0.05, whether in summer or winter, eliminating the ~5-hour seasonal smear that clock-hour binning would produce.</p>

<h3>Formula</h3>
<p>For each detection, sunrise and sunset times are computed from the station's coordinates and date using the <a href="https://sffjunkie.github.io/astral/" target="_blank" rel="noopener">Astral</a> library. Then:</p>
<ul>
<li>If the detection falls between sunrise and sunset: <code>solar_pos = (minutes since sunrise) / day_length</code> → range [0, 1)</li>
<li>If it falls between sunset and the next sunrise: <code>solar_pos = 1.0 + (minutes since sunset) / night_length</code> → range [1, 2)</li>
</ul>

<h3>Binning &amp; aggregation</h3>
<ol>
<li>Solar positions are binned into 48 equal-width bins (each spanning 1/48 of the cycle ≈ 30 minutes equivalent).</li>
<li>For each station-day, bin counts are normalized to sum to 1.</li>
<li>The mean normalized profile is computed across all station-days.</li>
</ol>

<h3>Chart axis</h3>
<p>The chart is centered on solar noon (0.5) with midnight at both edges, so the x-axis runs from −0.5 to 1.5. Vertical reference lines mark sunrise (0.0) and sunset (1.0). This layout places daytime activity in the center and nighttime activity at the margins, giving an intuitive left-to-right reading of dawn → day → dusk → night.</p>

<p>The "All species" overlay shows solar activity curves for all species simultaneously, making it easy to compare dawn chorus timing, diurnal vs. nocturnal patterns, and dusk activity.</p>
</section>

<section class="method-section">
<h2>3. Daily Detection Counts</h2>
<p>A simple time series of how many times a species was detected each day across all stations.</p>

<h3>Computation</h3>
<p>Sum all detections of the species across all stations for each calendar day. No normalization for station count is applied — if more stations are active on a given day, counts will be higher even without a true change in bird activity.</p>

<h3>Caveats</h3>
<p>Drops in the time series may reflect station outages rather than true absence. Seasonal patterns in station availability (e.g., power failures in winter) can introduce artifacts. Compare with the migration tab (which normalizes by active stations) for a corrected view.</p>
</section>

<section class="method-section">
<h2>4. Detection Heatmap</h2>
<p>A date × hour-of-day matrix where color intensity encodes detection counts, revealing how daily activity patterns shift across seasons.</p>

<h3>Computation</h3>
<p>Detections are binned by calendar date (x-axis) and UTC hour of day (0–23, y-axis). Each cell contains the total detection count across all stations for that date–hour combination. The color scale is linear within the species' range.</p>

<h3>Why UTC hours here?</h3>
<p>Unlike the Rhythm tab (which uses normalized solar position), the heatmap deliberately uses raw UTC clock hours. This is a practical choice for birding: it lets you see <em>what time to set your alarm</em> for a species in a given month. The visible shift of the dawn chorus band from ~3:00 UTC in summer to ~8:00 UTC in winter is itself an informative pattern.</p>

<h3>Interpretation</h3>
<p>Look for the dawn chorus band shifting earlier from winter to summer, evening activity windows, and nocturnal peaks. Migratory species show distinct blocks of activity during passage periods.</p>
</section>

<section class="method-section">
<h2>5. ML Insights</h2>
<p>Machine learning models reveal which environmental and temporal factors best predict a species' occurrence and abundance.</p>

<h3>Models</h3>
<p>Two <a href="https://lightgbm.readthedocs.io/" target="_blank" rel="noopener">LightGBM</a> gradient-boosted tree models are trained per species:</p>
<ol>
<li><strong>Binary classifier</strong> — predicts whether at least one detection occurs at a given station on a given day (presence/absence).</li>
<li><strong>Count regressor</strong> — predicts the number of detections at a station-day.</li>
</ol>

<h3>Features</h3>
<table>
<thead><tr><th>Category</th><th>Features</th></tr></thead>
<tbody>
<tr><td>Temporal</td><td>Solar position (normalized [0,2) cycle), day of year, month</td></tr>
<tr><td>Weather</td><td>Temperature (°C), precipitation (mm), wind speed (m/s), cloud cover (%), solar radiation (W/m²)</td></tr>
<tr><td>Spatial</td><td>Latitude, longitude, population density (GHS-POP at 1 km)</td></tr>
<tr><td>Land use</td><td>Fraction of urban, agricultural, forest, water, and natural land within a buffer around the station</td></tr>
</tbody>
</table>

<h3>Feature importance</h3>
<p>Importance is measured by LightGBM's "gain" metric — the total reduction in the loss function contributed by splits on each feature. The bar chart shows raw gain values; the radar chart groups features by category (temporal, weather, spatial, land use) and normalizes per category.</p>

<h3>Solar &amp; monthly patterns</h3>
<p>The "Solar Activity" sub-chart shows the mean detection rate per solar position bin (48 bins across the [0, 2) cycle), averaged across all station-days — the same data as the Rhythm tab. The "Monthly pattern" sub-chart shows the mean detection count per month. These are descriptive summaries, not model outputs.</p>
</section>

<section class="method-section">
<h2>6. Weather Overlay</h2>
<p>Daily detection counts co-plotted with weather variables, enabling visual inspection of correlations.</p>

<h3>Weather data source</h3>
<p>Daily weather variables are retrieved from the <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> historical weather API. Values are spatially averaged across a grid of points covering the Netherlands, giving a single national daily value per variable.</p>

<h3>Variables</h3>
<ul>
<li>Mean temperature (°C)</li>
<li>Total precipitation (mm)</li>
<li>Mean wind speed at 10m (m/s)</li>
<li>Mean cloud cover (%)</li>
<li>Mean solar radiation (W/m²)</li>
</ul>

<p>Both the detection count and the weather variable are plotted on dual y-axes. No statistical smoothing is applied.</p>
</section>

<section class="method-section">
<h2>7. Weather Correlations</h2>
<p>Non-linear response curves showing how detection counts vary with each weather variable.</p>

<h3>Computation</h3>
<ol>
<li>The range of each weather variable is trimmed at the 2nd and 98th percentiles to remove outliers.</li>
<li>The trimmed range is divided into 20 equal-width bins.</li>
<li>For each bin, compute the mean and median daily detection count across all days falling in that bin.</li>
</ol>

<h3>Interpretation</h3>
<p>These curves reveal non-linear relationships — e.g., a species may be most vocal at intermediate temperatures and quiet at both extremes. However, <strong>no causal inference should be drawn</strong>: weather variables are strongly correlated with season, so a peak at 15°C may reflect spring migration timing rather than a temperature preference. The ML Insights tab provides a more controlled analysis via feature importance.</p>
</section>

<section class="method-section">
<h2>8. Station Map</h2>
<p>A geographic view of where detections were recorded.</p>

<h3>Species mode</h3>
<p>Each circle marks a BirdWeather station that detected the selected species. Circle radius is proportional to the detection count at that station. Circle color encodes population density from the <a href="https://ghsl.jrc.ec.europa.eu/ghs_pop2023.php" target="_blank" rel="noopener">GHS-POP</a> dataset (Global Human Settlement Layer, 1 km resolution), indicating whether the station is in an urban or rural area.</p>

<h3>Density mode</h3>
<p>A heatmap showing total detection volume across all species per station, useful for identifying station coverage hotspots and gaps.</p>
</section>

<section class="method-section">
<h2>9. Migration &amp; Phenology</h2>
<p>Animated spatial maps showing how a species' presence shifts geographically across the year.</p>

<h3>Computation</h3>
<ol>
<li>The Netherlands is divided into a grid of 0.1° × 0.1° cells (~7 × 11 km).</li>
<li>For each cell and each week, compute: <code>detection rate = detections / active stations</code>. A station is "active" in a week if it reported at least one detection of any species.</li>
<li>This normalization corrects for uneven station density — a cell with 1 station and 10 detections ranks higher than a cell with 100 stations and 50 detections.</li>
<li>The animation steps through weeks, coloring each grid cell by its normalized detection rate.</li>
</ol>

<h3>Monthly panels</h3>
<p>The 12 monthly summary panels show the same metric averaged per calendar month, giving a static overview of spatial phenology.</p>

<h3>Interpretation</h3>
<p>For migratory species, watch for the wave of detections arriving from the south in spring and departing in autumn. For residents, the pattern should be relatively stable year-round, with seasonal modulation in vocal activity.</p>
</section>

<section class="method-section">
<h2>10. False Positive Analysis</h2>
<p>A statistical approach to identifying species pairs where BirdNET may systematically confuse one species for another.</p>

<h3>Rationale</h3>
<p>Acoustic ML classifiers sometimes produce systematic false positives — e.g., consistently labeling a Marsh Tit call as a Willow Tit. If two species are truly independent, their detections should not co-occur more than expected by chance. Excess co-occurrence within short time windows may indicate confusion.</p>

<h3>Metrics</h3>
<ul>
<li><strong>PMI (Pointwise Mutual Information):</strong> Measures how much more often two species co-occur at the same station within a ±60-second window than expected by chance. <code>PMI = log₂(P(A,B) / (P(A) · P(B)))</code>. A PMI of 0 means independence; higher values indicate excess co-occurrence.</li>
<li><strong>Dependency ratio:</strong> The fraction of species B's detections that co-occur with species A. If 90% of "Willow Tit" detections happen within 60 seconds of a "Marsh Tit" detection, species B may be a ghost artifact of species A.</li>
<li><strong>Asymmetry:</strong> Difference in dependency ratios. High asymmetry (one species strongly depends on the other, but not vice versa) is a strong indicator of one-directional misidentification.</li>
</ul>

<h3>Suspect pairs</h3>
<p>Pairs are flagged as "suspect" when they have high PMI, high dependency, and high asymmetry simultaneously. The threshold is heuristic and intentionally conservative — flagged pairs warrant manual review of spectrograms, not automatic dismissal.</p>

<h3>Per-species view</h3>
<p>For each species, a chart shows all other species ranked by their co-occurrence metrics, helping identify which species are most likely to be confused with the selected one.</p>
</section>

<section class="method-section">
<h2>11. Behavioral Clustering (Ecology)</h2>
<p>A dimensionality reduction and clustering analysis grouping species by behavioral similarity.</p>

<h3>Feature vector</h3>
<p>Each species is represented by a profile of 60+ features:</p>
<ul>
<li>48 solar activity values (mean detection proportion per solar position bin across the [0, 2) cycle)</li>
<li>12 monthly activity values (mean detection proportion per month)</li>
<li>Nocturnality index (fraction of detections with solar position in [1.0, 2.0) — the night portion)</li>
<li>Dawn focus (fraction of detections with solar position in [0.0, 0.1) — first 10% of daylight)</li>
<li>Dusk focus (fraction of detections with solar position in [0.9, 1.0) — last 10% of daylight)</li>
<li>Seasonality (coefficient of variation of monthly counts)</li>
<li>Urban affinity (correlation between detection rate and population density across stations)</li>
</ul>

<h3>Standardization &amp; projection</h3>
<p>Features are z-score standardized (mean 0, SD 1) to prevent any single feature from dominating. The standardized vectors are projected to 2D using two methods:</p>
<ul>
<li><strong>UMAP</strong> (Uniform Manifold Approximation and Projection) — a non-linear method that preserves local neighborhood structure, revealing clusters of behaviorally similar species.</li>
<li><strong>PCA</strong> (Principal Component Analysis) — a linear method that maximizes explained variance, useful for interpreting which features drive the main axes of variation.</li>
</ul>

<h3>Hierarchical clustering</h3>
<p>Ward's linkage hierarchical clustering is applied to the full-dimensional profiles (not the 2D projections). The dendrogram is cut to produce clusters, which are assigned colors in the scatter plot. Cluster membership groups species with similar temporal niches — e.g., dawn-chorus songbirds, nocturnal owls, year-round urban birds.</p>

<h3>Hover details</h3>
<p>Hovering over a species point shows its hourly and monthly activity curves and its station map, giving immediate context for why it clusters where it does.</p>
</section>

<section class="method-section">
<h2>12. Species Prediction (Full Version Only)</h2>
<p>The prediction feature is available only in the local (full) version of the application, not on this static GitHub Pages deployment.</p>

<h3>How it works</h3>
<p>Per-species LightGBM models predict the probability of detecting each species at a given location and time. Inputs: latitude, longitude, date, time, and real-time weather data fetched from Open-Meteo. The output is a ranked list of species with their predicted detection probabilities.</p>
<p>In "density map" mode, a single species' probability is computed across a grid covering the Netherlands, producing a spatial probability heatmap.</p>
</section>

<section class="method-section">
<h2>13. Technical Stack</h2>
<ul>
<li><strong>Backend (full version):</strong> Python, FastAPI, SQLite, LightGBM, scikit-learn, UMAP</li>
<li><strong>Frontend:</strong> Vanilla JavaScript, <a href="https://plotly.com/javascript/" target="_blank" rel="noopener">Plotly.js</a> (charts), <a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a> (maps)</li>
<li><strong>Static deployment:</strong> All analysis results are precomputed and served as JSON files via GitHub Pages. No server-side computation is required for the public version.</li>
<li><strong>Weather data:</strong> <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> historical weather API</li>
<li><strong>Land use / population:</strong> <a href="https://ghsl.jrc.ec.europa.eu/" target="_blank" rel="noopener">GHSL</a> (Global Human Settlement Layer) at 1 km resolution</li>
</ul>
</section>

<section class="method-section method-footer">
<h2>Citation &amp; Contact</h2>
<p>If you use data or visualizations from this explorer, please credit BirdWeather for the detection data and BirdNET for the classification model. This explorer is an independent project and is not affiliated with BirdWeather or Cornell University.</p>
</section>

</div>
`;
}

async function plotEcology() {
    const container = document.getElementById("ecology-container");

    if (!ecologyData) {
        container.innerHTML = '<p style="padding:2rem;color:#888;">Loading ecology data...</p>';
        ecologyData = await fetchJSON("/api/ecology");
    }

    const data = ecologyData;
    const hasUmap = data.species[0] && data.species[0].umap;

    container.innerHTML = `
        <div id="ecology-controls">
            <button class="eco-toggle${hasUmap ? ' active' : ''}" onclick="toggleEcoView('umap')" id="eco-umap-btn">UMAP</button>
            <button class="eco-toggle${!hasUmap ? ' active' : ''}" onclick="toggleEcoView('pca')" id="eco-pca-btn">PCA</button>
            <span style="margin-left:1rem;font-size:0.8rem;color:#888;">Color: </span>
            <button class="eco-toggle active" onclick="toggleEcoColor('cluster')" id="eco-cluster-btn">Cluster</button>
            <button class="eco-toggle" onclick="toggleEcoColor('order')" id="eco-order-btn">Order</button>
        </div>
        <div class="eco-scatter-wrapper">
            <div class="eco-col eco-col-scatter">
                <div id="ecology-scatter"></div>
            </div>
            <div class="eco-col eco-col-card" id="ecology-card-panel">
                <div class="eco-card-placeholder">Hover over a species<br>in the scatter plot</div>
            </div>
            <div class="eco-col eco-col-map">
                <div class="eco-map-controls">
                    <span class="eco-map-label">Spatial abundance</span>
                </div>
                <div id="eco-density-map"></div>
                <div id="eco-map-legend" class="eco-map-legend">
                    <div class="eco-legend-bar"></div>
                    <div class="eco-legend-labels">
                        <span id="eco-legend-min">0%</span>
                        <span id="eco-legend-max">100%</span>
                    </div>
                </div>
            </div>
        </div>
        <div id="ecology-clusters"></div>`;

    window._ecoView = hasUmap ? "umap" : "pca";
    window._ecoColor = "cluster";
    window._ecoSpeciesMap = new Map(data.species.map(s => [s.species_id, s]));
    activePlotIds = ["ecology-scatter"];
    renderEcologyScatter();
    renderEcologyClusters();
    initEcoDensityMap();
}

function toggleEcoView(view) {
    window._ecoView = view;
    document.getElementById("eco-umap-btn").classList.toggle("active", view === "umap");
    document.getElementById("eco-pca-btn").classList.toggle("active", view === "pca");
    renderEcologyScatter();
}

function toggleEcoColor(mode) {
    window._ecoColor = mode;
    document.getElementById("eco-cluster-btn").classList.toggle("active", mode === "cluster");
    document.getElementById("eco-order-btn").classList.toggle("active", mode === "order");
    renderEcologyScatter();
}

function updateEcoHoverPanel(sp) {
    const panel = document.getElementById("ecology-card-panel");
    if (!panel) return;
    purgeEcoHoverPlots();

    // Find wikipedia info from speciesList
    const spMeta = speciesList.find(s => s.species_id === sp.species_id);
    const wikiSummary = spMeta?.wikipedia_summary || "";
    const wikiUrl = spMeta?.wikipedia_url || "";
    const wikiHtml = wikiSummary
        ? `<div class="eco-card-wiki">${wikiSummary}${wikiUrl ? ` <a href="${wikiUrl}" target="_blank">Wikipedia →</a>` : ""}</div>`
        : (wikiUrl ? `<div class="eco-card-wiki"><a href="${wikiUrl}" target="_blank">Wikipedia →</a></div>` : "");

    panel.innerHTML = `<div class="eco-card-content">
        <div class="eco-card-top">
            <img src="${sp.image_path}" class="eco-card-img" onerror="this.style.display='none'">
            <div class="eco-card-text">
                <div class="eco-card-name">${getSpeciesNameById(sp.species_id) || sp.common_name}</div>
                <div class="eco-card-taxonomy">${sp.order || ""} · ${sp.family || ""}</div>
                <div class="eco-card-detail">Peak: ${solarLabel(sp.peak_solar_pos)} · Nocturnal: ${(sp.nocturnality*100).toFixed(0)}%<br>Seasonality: ${sp.seasonality}x · Urban: ${Math.round(sp.urban_affinity)}</div>
                ${wikiHtml}
            </div>
        </div>
        <div class="eco-card-charts">
            <div class="eco-card-chart" id="eco-hover-hourly"></div>
            <div class="eco-card-chart" id="eco-hover-monthly"></div>
        </div>
    </div>`;
    ecoHoverPlotIds = ["eco-hover-hourly", "eco-hover-monthly"];

    // Solar rhythm
    const ecoSorted = solarCenterSorted(ecologyData.solar_bin_centers || Array.from({length: sp.solar_profile.length}, (_, i) => i * 2 / sp.solar_profile.length), sp.solar_profile);
    Plotly.newPlot("eco-hover-hourly", [{
        x: ecoSorted.x, y: ecoSorted.y,
        type: "scatter", mode: "lines",
        fill: "tozeroy", fillcolor: "rgba(41,128,185,0.15)",
        line: { color: "#2980b9", width: 1.5 },
    }], {
        margin: { t: 6, r: 8, b: 28, l: 36 },
        xaxis: { range: SOLAR_RANGE, tickvals: SOLAR_TICK_VALS_SHORT, ticktext: SOLAR_TICK_TEXT_SHORT, tickfont: { size: 8 }, title: { text: "Solar pos.", font: { size: 9 } } },
        yaxis: { tickfont: { size: 7 }, title: { text: "Activity", font: { size: 9 } } },
        showlegend: false,
    }, { staticPlot: true, displayModeBar: false, responsive: true });

    // Yearly pattern
    const months = ["J","F","M","A","M","J","J","A","S","O","N","D"];
    Plotly.newPlot("eco-hover-monthly", [{
        x: months, y: sp.monthly,
        type: "bar",
        marker: { color: "#2ecc71" },
    }], {
        margin: { t: 6, r: 8, b: 28, l: 36 },
        xaxis: { tickfont: { size: 8 }, title: { text: "Month", font: { size: 9 } } },
        yaxis: { tickfont: { size: 7 }, title: { text: "Activity", font: { size: 9 } } },
        showlegend: false,
    }, { staticPlot: true, displayModeBar: false, responsive: true });

    // Update density map overlay
    updateEcoDensityOverlay(sp);
}

function resetEcoHoverPanel() {
    purgeEcoHoverPlots();
    const panel = document.getElementById("ecology-card-panel");
    if (!panel) return;
    panel.innerHTML = '<div class="eco-card-placeholder">Hover over a species<br>in the scatter plot</div>';
    clearEcoDensityOverlay();
}

// --- Ecology density map (Leaflet-based) ---

let ecoDensityMap = null;
let ecoDensityLayer = null;
let ecoStationLayer = null;
let ecoMapMode = "abundance";
let ecoCurrentHoverSp = null; // track current hovered species for re-render on mode switch
let ecoGlobalMax = 0; // precomputed max smoothed value across all species

function initEcoDensityMap() {
    if (ecoDensityMap) { ecoDensityMap.remove(); ecoDensityMap = null; }

    // Compute bounds from actual station positions
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const sp of ecologyData.species) {
        for (const [lat, lon] of sp.locations || []) {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
        }
    }
    const bounds = [[minLat, minLon], [maxLat, maxLon]];

    ecoDensityMap = L.map("eco-density-map", {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        touchZoom: false,
    });
    ecoDensityMap.fitBounds(bounds, { padding: [10, 10] });

    // OpenStreetMap tiles — shows forests, rivers, coastlines, cities
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        opacity: 0.7,
    }).addTo(ecoDensityMap);

    // Station markers (small black crosses) — shown always
    ecoStationLayer = L.layerGroup().addTo(ecoDensityMap);
    const stationIcon = L.divIcon({
        className: "eco-station-cross",
        html: "+",
        iconSize: [10, 10],
        iconAnchor: [5, 5],
    });
    // Collect unique station positions from all species
    const stationSet = new Set();
    for (const sp of ecologyData.species) {
        for (const [lat, lon] of sp.locations || []) {
            const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
            if (!stationSet.has(key)) {
                stationSet.add(key);
                L.marker([lat, lon], { icon: stationIcon, interactive: false }).addTo(ecoStationLayer);
            }
        }
    }

    ecoDensityLayer = L.layerGroup().addTo(ecoDensityMap);

    // Precompute global max for abundance mode
    precomputeGlobalMax();
}

function precomputeGlobalMax() {
    const bbox = ecologyData.bbox;
    const waterSet = new Set((ecologyData.water_cells || []).map(c => `${c[0]},${c[1]}`));
    const nLat = 50, nLon = 50;
    const latStep = (bbox.lat_max - bbox.lat_min) / nLat;
    const lonStep = (bbox.lon_max - bbox.lon_min) / nLon;
    ecoGlobalMax = 0;
    for (const sp of ecologyData.species) {
        const locs = (sp.locations || []).filter(loc => {
            const gLat = Math.round(loc[0] * 10) / 10;
            const gLon = Math.round(loc[1] * 10) / 10;
            return !waterSet.has(`${gLat},${gLon}`);
        });
        for (const [lat, lon, cnt] of locs) {
            const li = Math.floor((lat - bbox.lat_min) / latStep);
            const lj = Math.floor((lon - bbox.lon_min) / lonStep);
            if (li >= 0 && li < nLat && lj >= 0 && lj < nLon) {
                if (cnt > ecoGlobalMax) ecoGlobalMax = cnt;
            }
        }
    }
    ecoGlobalMax = Math.log10(ecoGlobalMax + 1);
}

function setEcoMapMode(mode) {
    ecoMapMode = mode;
    document.getElementById("eco-map-rel-btn").classList.toggle("active", mode === "relative");
    document.getElementById("eco-map-abs-btn").classList.toggle("active", mode === "abundance");
    if (ecoCurrentHoverSp) updateEcoDensityOverlay(ecoCurrentHoverSp);
}

// Multi-stop color ramp: blue → cyan → green → yellow → orange → red
function densityColor(t) {
    // t in [0, 1]
    const stops = [
        [0.0,  44, 123, 182],  // blue
        [0.2,  73, 188, 207],  // cyan
        [0.4, 115, 195, 120],  // green
        [0.6, 215, 215,  60],  // yellow
        [0.8, 240, 150,  40],  // orange
        [1.0, 215,  48,  39],  // red
    ];
    for (let i = 0; i < stops.length - 1; i++) {
        if (t <= stops[i + 1][0]) {
            const f = (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
            const r = Math.round(stops[i][1] + f * (stops[i + 1][1] - stops[i][1]));
            const g = Math.round(stops[i][2] + f * (stops[i + 1][2] - stops[i][2]));
            const b = Math.round(stops[i][3] + f * (stops[i + 1][3] - stops[i][3]));
            return `rgb(${r},${g},${b})`;
        }
    }
    return "rgb(215,48,39)";
}

function updateEcoDensityOverlay(sp) {
    if (!ecoDensityMap || !ecoDensityLayer) return;
    ecoDensityLayer.clearLayers();
    ecoCurrentHoverSp = sp;

    const locs = sp.locations || [];
    if (locs.length === 0) return;

    const bbox = ecologyData.bbox;
    const waterSet = new Set((ecologyData.water_cells || []).map(c => `${c[0]},${c[1]}`));

    // Filter water cells
    const landLocs = locs.filter(loc => {
        const gLat = Math.round(loc[0] * 10) / 10;
        const gLon = Math.round(loc[1] * 10) / 10;
        return !waterSet.has(`${gLat},${gLon}`);
    });
    if (landLocs.length === 0) return;

    // Build smoothed grid
    const nLat = 50, nLon = 50;
    const latStep = (bbox.lat_max - bbox.lat_min) / nLat;
    const lonStep = (bbox.lon_max - bbox.lon_min) / nLon;
    const grid = Array.from({length: nLat}, () => new Float64Array(nLon));
    for (const [lat, lon, cnt] of landLocs) {
        const li = Math.floor((lat - bbox.lat_min) / latStep);
        const lj = Math.floor((lon - bbox.lon_min) / lonStep);
        if (li >= 0 && li < nLat && lj >= 0 && lj < nLon) {
            grid[li][lj] += cnt;
        }
    }

    // Gaussian smoothing
    const sigma = 1.8, kSize = 4;
    const kernel = [];
    let kSum = 0;
    for (let di = -kSize; di <= kSize; di++) {
        kernel[di + kSize] = [];
        for (let dj = -kSize; dj <= kSize; dj++) {
            const w = Math.exp(-(di*di + dj*dj) / (2*sigma*sigma));
            kernel[di + kSize][dj + kSize] = w;
            kSum += w;
        }
    }
    const smoothed = Array.from({length: nLat}, () => new Float64Array(nLon));
    for (let i = 0; i < nLat; i++) {
        for (let j = 0; j < nLon; j++) {
            let val = 0;
            for (let di = -kSize; di <= kSize; di++) {
                for (let dj = -kSize; dj <= kSize; dj++) {
                    const ni = i + di, nj = j + dj;
                    if (ni >= 0 && ni < nLat && nj >= 0 && nj < nLon) {
                        val += grid[ni][nj] * kernel[di + kSize][dj + kSize];
                    }
                }
            }
            smoothed[i][j] = val / kSum;
        }
    }

    // Find per-species max
    let speciesMax = 0;
    for (let i = 0; i < nLat; i++)
        for (let j = 0; j < nLon; j++)
            if (smoothed[i][j] > speciesMax) speciesMax = smoothed[i][j];
    if (speciesMax === 0) return;

    // Determine normalization based on mode
    const isAbundance = ecoMapMode === "abundance";
    // For abundance: use log scale, normalize against global max
    // For relative: normalize against this species' max (always 0-100%)
    const totalDetections = landLocs.reduce((s, l) => s + l[2], 0);

    // Update legend labels
    const legendMin = document.getElementById("eco-legend-min");
    const legendMax = document.getElementById("eco-legend-max");
    if (isAbundance) {
        legendMin.textContent = "0";
        legendMax.textContent = totalDetections.toLocaleString() + " det.";
    } else {
        legendMin.textContent = "0%";
        legendMax.textContent = "100%";
    }

    // Draw colored rectangles on the map
    for (let i = 0; i < nLat; i++) {
        for (let j = 0; j < nLon; j++) {
            const raw = smoothed[i][j];
            if (raw < speciesMax * 0.02) continue;
            const lat0 = bbox.lat_min + i * latStep;
            const lat1 = lat0 + latStep;
            const lon0 = bbox.lon_min + j * lonStep;
            const lon1 = lon0 + lonStep;
            const gLat = Math.round((lat0 + latStep/2) * 10) / 10;
            const gLon = Math.round((lon0 + lonStep/2) * 10) / 10;
            if (waterSet.has(`${gLat},${gLon}`)) continue;

            // Color value: 0–1
            let t;
            if (isAbundance) {
                // Log-scaled, normalized to global max across all species
                t = Math.log10(raw + 1) / ecoGlobalMax;
            } else {
                t = raw / speciesMax;
            }
            t = Math.min(Math.max(t, 0), 1);
            const opacity = 0.2 + t * 0.5;

            L.rectangle([[lat0, lon0], [lat1, lon1]], {
                color: "transparent",
                fillColor: densityColor(t),
                fillOpacity: opacity,
                weight: 0,
                interactive: false,
            }).addTo(ecoDensityLayer);
        }
    }
}

function clearEcoDensityOverlay() {
    if (ecoDensityLayer) ecoDensityLayer.clearLayers();
    ecoCurrentHoverSp = null;
}

function renderEcologyScatter() {
    Plotly.purge("ecology-scatter");
    const data = ecologyData;
    const view = window._ecoView || "umap";
    const colorMode = window._ecoColor || "cluster";

    const clusterColors = ["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c","#e67e22","#34495e","#c0392b","#16a085"];

    // Group by color category
    const groups = {};
    for (const sp of data.species) {
        const coords = view === "umap" && sp.umap ? sp.umap : sp.pca;
        if (!coords) continue;
        const key = colorMode === "cluster" ? `Cluster ${sp.cluster}` : (sp.order || "Unknown");
        if (!groups[key]) groups[key] = { x: [], y: [], text: [], ids: [], color: null };
        groups[key].x.push(coords[0]);
        groups[key].y.push(coords[1]);
        groups[key].text.push(
            `<b>${getSpeciesNameById(sp.species_id) || sp.common_name}</b><br>` +
            `${sp.order || ""} \u00b7 ${sp.family || ""}<br>` +
            `Cluster ${sp.cluster}<br>` +
            `Peak: ${solarLabel(sp.peak_solar_pos)} \u00b7 Nocturnal: ${(sp.nocturnality*100).toFixed(0)}%<br>` +
            `Seasonality: ${sp.seasonality}x \u00b7 Urban: ${Math.round(sp.urban_affinity)}`
        );
        groups[key].ids.push(sp.species_id);
        if (!groups[key].color) {
            groups[key].color = colorMode === "cluster"
                ? clusterColors[sp.cluster % clusterColors.length]
                : (data.order_colors[sp.order] || "#999");
        }
    }

    const traces = [];
    for (const [name, g] of Object.entries(groups)) {
        traces.push({
            x: g.x, y: g.y, text: g.text, customdata: g.ids,
            type: "scatter", mode: "markers",
            marker: { size: 12, color: g.color, opacity: 0.85,
                line: { width: 1.5, color: "#fff" } },
            name: name,
            hovertemplate: "%{text}<extra></extra>",
        });
    }

    const axisLabel = view === "umap" ? "UMAP" : "PCA";
    const varianceText = view === "pca" && data.pca_variance
        ? ` (${(data.pca_variance[0]*100).toFixed(0)}% + ${(data.pca_variance[1]*100).toFixed(0)}%)`
        : "";

    // Compute data-driven axis limits with small padding
    let xAll = [], yAll = [];
    for (const t of traces) { xAll.push(...t.x); yAll.push(...t.y); }
    const xPad = (Math.max(...xAll) - Math.min(...xAll)) * 0.05;
    const yPad = (Math.max(...yAll) - Math.min(...yAll)) * 0.05;
    const xRange = [Math.min(...xAll) - xPad, Math.max(...xAll) + xPad];
    const yRange = [Math.min(...yAll) - yPad, Math.max(...yAll) + yPad];

    Plotly.newPlot("ecology-scatter", traces, {
        ...plotLayout,
        margin: { t: 30, r: 10, b: 40, l: 10 },
        title: { text: `Behavioral Clustering \u2014 ${data.species.length} species${varianceText}`, font: { size: 14 } },
        xaxis: { showgrid: true, gridcolor: "#f0f0f0", showticklabels: false, title: "", zeroline: false, range: xRange },
        yaxis: { showgrid: true, gridcolor: "#f0f0f0", showticklabels: false, title: "", zeroline: false, range: yRange },
        height: 470,
        hovermode: "closest",
        showlegend: true,
        legend: { font: { size: 8 }, itemsizing: "constant", orientation: "h",
                  x: 0.5, xanchor: "center", y: -0.05, yanchor: "top" },
    }, { responsive: true });

    // Event handlers
    const plotDiv = document.getElementById("ecology-scatter");

    plotDiv.removeAllListeners?.("plotly_hover");
    plotDiv.on("plotly_hover", (event) => {
        const pt = event.points?.[0];
        if (!pt?.customdata) return;
        const sp = window._ecoSpeciesMap.get(pt.customdata);
        if (!sp) return;
        clearTimeout(ecoHoverTimer);
        ecoHoverTimer = setTimeout(() => updateEcoHoverPanel(sp), 120);
    });

    plotDiv.removeAllListeners?.("plotly_unhover");
    plotDiv.on("plotly_unhover", () => {
        clearTimeout(ecoHoverTimer);
        resetEcoHoverPanel();
    });

    plotDiv.removeAllListeners?.("plotly_click");
    plotDiv.on("plotly_click", (event) => {
        if (event.points?.[0]?.customdata) {
            selectSpecies(event.points[0].customdata);
            switchMode("explorer");
            switchTab("insights");
        }
    });
}

function buildSpeciesDropdown(cl) {
    const items = cl.species_ids.map(sid => {
        const sp = window._ecoSpeciesMap.get(sid);
        if (!sp) return "";
        return `<div class="cluster-col-species-item">
            <span class="cluster-species-link" onclick="selectSpecies(${sid});switchMode('explorer');switchTab('insights')">${getSpeciesNameById(sid) || sp.common_name}</span>
            <span class="cluster-col-species-meta">${solarLabel(sp.peak_solar_pos)} ${(sp.nocturnality*100).toFixed(0)}%n</span>
        </div>`;
    }).join("");
    return `<details class="cluster-col-species">
        <summary>${cl.n_species} species</summary>
        <div class="cluster-col-species-list">${items}</div>
    </details>`;
}

function renderClusterChart(cl, type, colors) {
    const divId = `cm-${type}-${cl.id}`;
    activePlotIds.push(divId);
    const color = colors[cl.id % colors.length];
    const isSolar = type === "solar";
    const months = ["J","F","M","A","M","J","J","A","S","O","N","D"];

    let xArr, traces, xaxis;

    if (isSolar) {
        const rawX = ecologyData.solar_bin_centers || Array.from({length: cl.avg_solar_profile.length}, (_, i) => i * 2 / cl.avg_solar_profile.length);

        traces = cl.species_ids.map(sid => {
            const sp = window._ecoSpeciesMap.get(sid);
            if (!sp) return null;
            const s = solarCenterSorted(rawX, sp.solar_profile);
            return {
                x: s.x, y: s.y,
                type: "scatter", mode: "lines",
                line: { color: color, width: 1 },
                opacity: 0.2, showlegend: false, hoverinfo: "skip",
            };
        }).filter(Boolean);

        const avgS = solarCenterSorted(rawX, cl.avg_solar_profile);
        traces.push({
            x: avgS.x, y: avgS.y,
            type: "scatter", mode: "lines",
            fill: "tozeroy", fillcolor: color + "20",
            line: { color: color, width: 2.5 },
            showlegend: false,
            hovertemplate: "%{y:.4f}<extra></extra>",
        });

        xaxis = { range: SOLAR_RANGE, tickvals: SOLAR_TICK_VALS_SHORT, ticktext: SOLAR_TICK_TEXT_SHORT, tickfont: { size: 8 }, title: { text: "Solar pos.", font: { size: 9 } } };
    } else {
        xArr = Array.from({length: 12}, (_, i) => i);

        traces = cl.species_ids.map(sid => {
            const sp = window._ecoSpeciesMap.get(sid);
            if (!sp) return null;
            return {
                x: xArr, y: sp.monthly,
                type: "scatter", mode: "lines",
                line: { color: color, width: 1 },
                opacity: 0.2, showlegend: false, hoverinfo: "skip",
            };
        }).filter(Boolean);

        traces.push({
            x: xArr, y: cl.avg_monthly,
            type: "scatter", mode: "lines",
            fill: "tozeroy", fillcolor: color + "20",
            line: { color: color, width: 2.5 },
            showlegend: false,
            hovertemplate: "%{text}: %{y:.4f}<extra></extra>",
            text: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
        });

        xaxis = { tickvals: xArr, ticktext: months, tickfont: { size: 8 }, title: { text: "Month", font: { size: 9 } } };
    }

    Plotly.newPlot(divId, traces, {
        margin: { t: 4, r: 6, b: 28, l: 30 },
        xaxis: xaxis,
        yaxis: { tickfont: { size: 8 }, title: "" },
        height: 130, showlegend: false,
        font: { family: "-apple-system, BlinkMacSystemFont, sans-serif" },
    }, { responsive: true, displayModeBar: false, staticPlot: true });
}

function renderEcologyClusters() {
    const data = ecologyData;
    if (!data.clusters || data.clusters.length === 0) return;

    const clusterColors = ["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c","#e67e22","#34495e","#c0392b","#16a085"];
    const clusters = data.clusters.filter(cl => cl.n_species > 2).sort((a, b) => b.n_species - a.n_species);
    const container = document.getElementById("ecology-clusters");

    let html = '<h3 class="eco-section-title">Behavioral Clusters</h3>';
    html += '<div class="cluster-columns">';

    for (const cl of clusters) {
        const color = clusterColors[cl.id % clusterColors.length];
        const nocPct = (cl.avg_nocturnality * 100).toFixed(0);
        const peakLabel = solarLabel(cl.avg_peak_solar_pos);

        html += `<div class="cluster-col" style="border-top:3px solid ${color}">
            <div class="cluster-col-header">
                <span class="cluster-id" style="background:${color}">C${cl.id}</span>
                <span class="cluster-col-count">${cl.n_species} sp.</span>
                <span class="cluster-col-meta">${peakLabel} · ${nocPct}%n</span>
            </div>
            <div class="cluster-col-chart" id="cm-solar-${cl.id}"></div>
            <div class="cluster-col-chart" id="cm-monthly-${cl.id}"></div>
            ${buildSpeciesDropdown(cl)}
        </div>`;
    }
    html += '</div>';
    container.innerHTML = html;

    for (const cl of clusters) {
        renderClusterChart(cl, "solar", clusterColors);
        renderClusterChart(cl, "monthly", clusterColors);
    }
}

// --- Weather & Correlations ---

async function plotWeather() {
    Plotly.purge("chart");
    const data = await fetchJSON(`/api/weather/daily/${currentSpeciesId}`);
    const name = getSpeciesNameById(currentSpeciesId);

    if (!data.dates || data.dates.length === 0) {
        document.getElementById("chart").innerHTML = '<p style="padding:2rem;color:#888;">No weather data available. Run: download_data.py --weather</p>';
        return;
    }

    const panels = [
        { y: data.counts, label: "Detections", color: "rgba(41,128,185,0.7)", type: "bar" },
        { y: data.temperature, label: "Temperature (°C)", color: "#e74c3c", type: "line" },
        { y: data.precipitation, label: "Precipitation (mm)", color: "#3498db", type: "bar" },
        { y: data.cloudcover, label: "Cloud Cover (%)", color: "#7f8c8d", type: "line" },
        { y: data.radiation, label: "Solar Radiation (W/m²)", color: "#f39c12", type: "line" },
        { y: data.windspeed, label: "Wind Speed (m/s)", color: "#27ae60", type: "line" },
    ];

    const traces = [];
    const layout = {
        ...plotLayout,
        title: `Daily Counts & Weather \u2014 ${name}`,
        height: panels.length * 150 + 80,
        showlegend: false,
        grid: { rows: panels.length, columns: 1, pattern: "independent", ygap: 0.03 },
    };

    panels.forEach((p, i) => {
        const xaxis = i === 0 ? "x" : `x${i + 1}`;
        const yaxis = i === 0 ? "y" : `y${i + 1}`;

        const trace = {
            x: data.dates, y: p.y,
            xaxis: xaxis, yaxis: yaxis,
            showlegend: false,
        };
        if (p.type === "bar") {
            trace.type = "bar";
            trace.marker = { color: p.color };
        } else {
            trace.type = "scatter";
            trace.mode = "lines";
            trace.line = { color: p.color, width: 1.5 };
            trace.fill = "tozeroy";
            trace.fillcolor = p.color + "1a";
        }
        traces.push(trace);

        layout[yaxis === "y" ? "yaxis" : `yaxis${i + 1}`] = {
            title: { text: p.label, font: { size: 11 } },
            showgrid: true, gridcolor: "#f0f0f0",
        };
        layout[xaxis === "x" ? "xaxis" : `xaxis${i + 1}`] = {
            showticklabels: i === panels.length - 1,
            matches: i === 0 ? undefined : "x",
        };
    });

    Plotly.newPlot("chart", traces, layout, { responsive: true });
}

async function plotCorrelations() {
    Plotly.purge("chart");
    const data = await fetchJSON(`/api/weather/correlation/${currentSpeciesId}`);
    const name = getSpeciesNameById(currentSpeciesId);

    if (!data.n_days || data.n_days === 0) {
        document.getElementById("chart").innerHTML = '<p style="padding:2rem;color:#888;">No weather-detection matches. Ensure weather data is downloaded.</p>';
        return;
    }

    const vars = data.variables;
    const panels = [
        ["temperature", "Temperature (\u00b0C)", "#e74c3c"],
        ["radiation", "Solar Radiation (W/m\u00b2)", "#f39c12"],
        ["windspeed", "Wind Speed (m/s)", "#27ae60"],
        ["cloudcover", "Cloud Cover (%)", "#7f8c8d"],
        ["precipitation", "Precipitation (mm)", "#3498db"],
    ];

    const cols = 3;
    const rows = Math.ceil(panels.length / cols);
    const traces = [];
    const annotations = [];

    const layout = {
        ...plotLayout,
        title: `Weather vs Detections \u2014 ${name} (${data.n_days.toLocaleString()} days)`,
        grid: { rows: rows, columns: cols, pattern: "independent", xgap: 0.1, ygap: 0.15 },
        showlegend: false,
        height: rows * 300 + 80,
    };

    panels.forEach((p, i) => {
        const [key, label, color] = p;
        const v = vars[key];
        if (!v || !v.bin_centers || v.bin_centers.length === 0) return;

        const xaxis = i === 0 ? "x" : `x${i + 1}`;
        const yaxis = i === 0 ? "y" : `y${i + 1}`;

        // Mean detections as bars
        traces.push({
            x: v.bin_centers, y: v.mean_detections,
            type: "bar",
            marker: { color: color, opacity: 0.7 },
            xaxis: xaxis, yaxis: yaxis,
            showlegend: false,
            hovertemplate: `${label}: %{x}<br>Mean detections: %{y:.1f}<br><extra></extra>`,
            width: v.bin_centers.length > 1
                ? (v.bin_centers[1] - v.bin_centers[0]) * 0.85
                : undefined,
        });

        // Median as line overlay
        traces.push({
            x: v.bin_centers, y: v.median_detections,
            type: "scatter", mode: "lines+markers",
            line: { color: "#2c3e50", width: 2, dash: "dot" },
            marker: { size: 4, color: "#2c3e50" },
            xaxis: xaxis, yaxis: yaxis,
            showlegend: false,
            hovertemplate: `Median: %{y:.1f}<extra></extra>`,
        });

        layout[xaxis === "x" ? "xaxis" : `xaxis${i + 1}`] = {
            title: { text: label, font: { size: 10 } }, gridcolor: "#f0f0f0",
        };
        layout[yaxis === "y" ? "yaxis" : `yaxis${i + 1}`] = {
            title: { text: "Detections / day", font: { size: 10 } }, gridcolor: "#f0f0f0",
        };

        annotations.push({
            text: `<b>${label}</b>`,
            xref: `${xaxis} domain`, yref: `${yaxis} domain`,
            x: 0.5, y: 1.1, showarrow: false,
            font: { size: 11 },
        });
    });

    layout.annotations = annotations;
    Plotly.newPlot("chart", traces, layout, { responsive: true });
}

// --- False Positive Co-occurrence ---

async function plotFalsePositives() {
    let url, title;

    if (currentSpeciesId && currentSpeciesId !== "all") {
        url = `/api/fp/species/${currentSpeciesId}`;
        const name = getSpeciesNameById(currentSpeciesId);
        title = `Co-occurrence Pairs \u2014 ${name}`;
    } else {
        url = "/api/fp/pairs?suspect_only=false";
        title = "Co-occurrence Analysis \u2014 All Species";
    }

    let data;
    try {
        data = await fetchJSON(url);
    } catch (e) {
        document.getElementById("chart").innerHTML =
            '<p style="padding:2rem;color:#888;">No FP analysis data. Run:<br><code>python download_data.py --fp-data</code><br><code>python download_data.py --fp-analyze</code></p>';
        return;
    }

    if (!data || data.length === 0) {
        document.getElementById("chart").innerHTML =
            '<p style="padding:2rem;color:#888;">No co-occurrence pairs found for this species.</p>';
        return;
    }

    // Bubble scatter: x=PMI, y=dependency_ratio, size=cooccurrence_count
    const suspects = data.filter(p => p.is_suspect);
    const benign = data.filter(p => !p.is_suspect);

    const traces = [];
    if (benign.length > 0) {
        traces.push({
            x: benign.map(p => p.pmi),
            y: benign.map(p => p.dependency_ratio),
            text: benign.map(p => `${getSpeciesNameById(p.species_a_id) || p.species_a_name} \u2192 ${getSpeciesNameById(p.species_b_id) || p.species_b_name}<br>n=${p.cooccurrence_count}`),
            mode: "markers",
            type: "scatter",
            marker: {
                size: benign.map(p => Math.max(6, Math.sqrt(p.cooccurrence_count) * 2)),
                color: "rgba(52,152,219,0.5)",
                line: { width: 1, color: "rgba(52,152,219,0.8)" },
            },
            name: "Benign",
            hovertemplate: "%{text}<br>PMI=%{x:.2f}<br>Dep=%{y:.2f}<extra></extra>",
        });
    }
    if (suspects.length > 0) {
        traces.push({
            x: suspects.map(p => p.pmi),
            y: suspects.map(p => p.dependency_ratio),
            text: suspects.map(p => `${getSpeciesNameById(p.species_a_id) || p.species_a_name} \u2192 ${getSpeciesNameById(p.species_b_id) || p.species_b_name}<br>n=${p.cooccurrence_count}`),
            mode: "markers",
            type: "scatter",
            marker: {
                size: suspects.map(p => Math.max(8, Math.sqrt(p.cooccurrence_count) * 2)),
                color: "rgba(231,76,60,0.6)",
                line: { width: 1, color: "rgba(231,76,60,0.9)" },
                symbol: "diamond",
            },
            name: "Suspect FP",
            hovertemplate: "%{text}<br>PMI=%{x:.2f}<br>Dep=%{y:.2f}<extra></extra>",
        });
    }

    const chartEl = document.getElementById("chart");
    // Purge any existing Plotly instances and create container for chart + table
    purgeActivePlots();
    chartEl.innerHTML = '<div id="fp-chart"></div><div id="fp-table" style="max-height:300px;overflow-y:auto;margin-top:1rem;"></div>';
    activePlotIds = ["fp-chart"];

    Plotly.react("fp-chart", traces, {
        ...plotLayout,
        title: title,
        xaxis: { title: "PMI (pointwise mutual information)", zeroline: true },
        yaxis: { title: "Dependency Ratio (fraction of B co-occurring with A)", range: [0, 1] },
        height: 450,
        shapes: [
            { type: "line", x0: 2, x1: 2, y0: 0, y1: 1, line: { color: "#e74c3c", dash: "dot", width: 1 } },
            { type: "line", x0: -5, x1: 20, y0: 0.5, y1: 0.5, line: { color: "#e74c3c", dash: "dot", width: 1 } },
        ],
    });

    // Sortable table
    const sorted = [...data].sort((a, b) => b.dependency_ratio - a.dependency_ratio);
    let tableHtml = `<table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
        <thead><tr style="border-bottom:2px solid #ddd;text-align:left;">
            <th style="padding:4px 8px;">Common Species (A)</th>
            <th style="padding:4px 8px;">Suspect Species (B)</th>
            <th style="padding:4px 8px;">Co-occur</th>
            <th style="padding:4px 8px;">Dep. Ratio</th>
            <th style="padding:4px 8px;">PMI</th>
            <th style="padding:4px 8px;">Asymmetry</th>
            <th style="padding:4px 8px;">Conf \u0394</th>
            <th style="padding:4px 8px;">Verdict</th>
        </tr></thead><tbody>`;

    for (const p of sorted.slice(0, 50)) {
        const rowColor = p.is_suspect ? "rgba(231,76,60,0.08)" : "transparent";
        const verdict = p.is_suspect ? '<span style="color:#e74c3c;font-weight:bold;">SUSPECT</span>' : '<span style="color:#888;">ok</span>';
        tableHtml += `<tr style="border-bottom:1px solid #eee;background:${rowColor}">
            <td style="padding:4px 8px;">${getSpeciesNameById(p.species_a_id) || p.species_a_name}</td>
            <td style="padding:4px 8px;">${getSpeciesNameById(p.species_b_id) || p.species_b_name}</td>
            <td style="padding:4px 8px;">${p.cooccurrence_count}</td>
            <td style="padding:4px 8px;">${p.dependency_ratio.toFixed(3)}</td>
            <td style="padding:4px 8px;">${p.pmi.toFixed(2)}</td>
            <td style="padding:4px 8px;">${p.asymmetry.toFixed(1)}</td>
            <td style="padding:4px 8px;">${p.confidence_delta !== null ? p.confidence_delta.toFixed(3) : '-'}</td>
            <td style="padding:4px 8px;">${verdict}</td>
        </tr>`;
    }
    tableHtml += "</tbody></table>";
    document.getElementById("fp-table").innerHTML = tableHtml;
}

async function plotMap() {
    const mapEl = document.getElementById("map-container");

    if (!leafletMap) {
        leafletMap = L.map(mapEl).setView([52.15, 5.38], 7);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 18,
        }).addTo(leafletMap);
        mapMarkers = L.layerGroup().addTo(leafletMap);
        densityMarkers = L.layerGroup();

        // Add map mode toggle
        const toggleDiv = L.control({ position: "topleft" });
        toggleDiv.onAdd = () => {
            const div = L.DomUtil.create("div", "map-mode-toggle");
            div.innerHTML = `
                <button class="map-toggle-btn active" id="map-btn-stations" onclick="setMapMode('stations')">Stations</button>
                <button class="map-toggle-btn" id="map-btn-density" onclick="setMapMode('density')">Density</button>`;
            L.DomEvent.disableClickPropagation(div);
            return div;
        };
        toggleDiv.addTo(leafletMap);
    } else {
        setTimeout(() => leafletMap.invalidateSize(), 100);
    }

    if (mapMode === "density") {
        await renderDensityMap();
    } else {
        await renderStationsMap();
    }
}

async function setMapMode(mode) {
    mapMode = mode;
    document.getElementById("map-btn-stations")?.classList.toggle("active", mode === "stations");
    document.getElementById("map-btn-density")?.classList.toggle("active", mode === "density");
    if (mode === "density") {
        mapMarkers.clearLayers();
        await renderDensityMap();
    } else {
        densityMarkers.remove();
        await renderStationsMap();
    }
}

async function renderDensityMap() {
    if (!densityData) {
        densityData = await fetchJSON("/api/density");
    }

    densityMarkers.clearLayers();
    densityMarkers.addTo(leafletMap);
    mapMarkers.clearLayers();

    const stations = densityData.stations;
    if (!stations || stations.length === 0) return;

    const maxDet = Math.max(...stations.map(s => s.total_detections));

    function detectionColor(count) {
        const t = Math.log1p(count) / Math.log1p(maxDet);
        const r = Math.round(255 * t);
        const g = Math.round(255 * (1 - t * 0.7));
        const b = 50;
        return `rgb(${r},${g},${b})`;
    }

    for (const s of stations) {
        const radius = 6 + 18 * (Math.log1p(s.total_detections) / Math.log1p(maxDet));
        const marker = L.circleMarker([s.lat, s.lon], {
            radius,
            fillColor: detectionColor(s.total_detections),
            color: "rgba(0,0,0,0.2)",
            weight: 1,
            fillOpacity: 0.55,
        });
        marker.bindPopup(
            `<b>Station</b><br>` +
            `Detections: ${s.total_detections.toLocaleString()}<br>` +
            `Species: ${s.n_species}<br>` +
            `Pop. density: ${Math.round(s.population_density)} /km\u00b2`
        );
        densityMarkers.addLayer(marker);
    }

    // Update legend
    const legendEl = document.getElementById("map-legend");
    if (legendEl) {
        legendEl.querySelector("div").innerHTML = `
            <b>Detection density</b><br>
            <span style="background:rgb(50,255,50);width:12px;height:12px;display:inline-block;border-radius:50%;vertical-align:middle"></span> Low<br>
            <span style="background:rgb(200,200,50);width:12px;height:12px;display:inline-block;border-radius:50%;vertical-align:middle"></span> Medium<br>
            <span style="background:rgb(255,76,50);width:12px;height:12px;display:inline-block;border-radius:50%;vertical-align:middle"></span> High`;
    }
}

async function renderStationsMap() {
    if (currentSpeciesId === "all") return;

    const data = await fetchJSON(`/api/locations/${currentSpeciesId}`);
    const name = getSpeciesNameById(currentSpeciesId);

    mapMarkers.clearLayers();
    densityMarkers.remove();

    if (data.length === 0) return;

    const maxCount = Math.max(...data.map(d => d.count));

    function popDensityColor(pd) {
        if (pd == null) return "#95a5a6";
        if (pd < 100) return "#27ae60";
        if (pd < 500) return "#f39c12";
        if (pd < 2000) return "#e67e22";
        return "#c0392b";
    }

    for (const loc of data) {
        const radius = 5 + 20 * (loc.count / maxCount);
        const color = popDensityColor(loc.population_density);
        const marker = L.circleMarker([loc.lat, loc.lon], {
            radius,
            fillColor: color,
            color: "#333",
            weight: 1,
            fillOpacity: 0.65,
        });
        const pdText = loc.population_density != null
            ? `${Math.round(loc.population_density)} /km\u00b2`
            : "n/a";
        marker.bindPopup(`<b>${name}</b><br>Station: ${loc.station_id}<br>Detections: ${loc.count}<br>Avg confidence: ${loc.mean_confidence}<br>Pop. density: ${pdText}`);
        mapMarkers.addLayer(marker);
    }

    // Add legend
    if (!document.getElementById("map-legend")) {
        const legend = L.control({ position: "bottomright" });
        legend.onAdd = () => {
            const div = L.DomUtil.create("div", "map-legend");
            div.id = "map-legend";
            div.innerHTML = `
                <div style="background:white;padding:8px 10px;border-radius:6px;font-size:11px;line-height:1.6;box-shadow:0 1px 4px rgba(0,0,0,.3)">
                    <b>Pop. density</b><br>
                    <span style="background:#27ae60;width:12px;height:12px;display:inline-block;border-radius:50%;vertical-align:middle"></span> &lt;100 /km\u00b2<br>
                    <span style="background:#f39c12;width:12px;height:12px;display:inline-block;border-radius:50%;vertical-align:middle"></span> 100\u2013500<br>
                    <span style="background:#e67e22;width:12px;height:12px;display:inline-block;border-radius:50%;vertical-align:middle"></span> 500\u20132000<br>
                    <span style="background:#c0392b;width:12px;height:12px;display:inline-block;border-radius:50%;vertical-align:middle"></span> &gt;2000<br>
                    <span style="background:#95a5a6;width:12px;height:12px;display:inline-block;border-radius:50%;vertical-align:middle"></span> no data
                </div>`;
            return div;
        };
        legend.addTo(leafletMap);
    } else {
        // Reset legend for station mode
        const legendEl = document.getElementById("map-legend");
        legendEl.querySelector("div").innerHTML = `
            <b>Pop. density</b><br>
            <span style="background:#27ae60;width:12px;height:12px;display:inline-block;border-radius:50%;vertical-align:middle"></span> &lt;100 /km\u00b2<br>
            <span style="background:#f39c12;width:12px;height:12px;display:inline-block;border-radius:50%;vertical-align:middle"></span> 100\u2013500<br>
            <span style="background:#e67e22;width:12px;height:12px;display:inline-block;border-radius:50%;vertical-align:middle"></span> 500\u20132000<br>
            <span style="background:#c0392b;width:12px;height:12px;display:inline-block;border-radius:50%;vertical-align:middle"></span> &gt;2000<br>
            <span style="background:#95a5a6;width:12px;height:12px;display:inline-block;border-radius:50%;vertical-align:middle"></span> no data`;
    }

    // Fit bounds to markers
    const bounds = L.latLngBounds(data.map(d => [d.lat, d.lon]));
    leafletMap.fitBounds(bounds.pad(0.1));
}

// --- Predict ---

function setPredictMode(mode) {
    predictMode = mode;
    document.querySelectorAll(".predict-mode-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    document.getElementById("predict-help-point").style.display = mode === "point" ? "" : "none";
    document.getElementById("predict-help-density").style.display = mode === "density" ? "" : "none";
    document.getElementById("predict-point-inputs").style.display = mode === "point" ? "" : "none";
    document.getElementById("predict-density-inputs").style.display = mode === "density" ? "" : "none";
    document.getElementById("density-legend").style.display = "none";
    document.getElementById("predict-results").innerHTML = "";
    clearDensityRectangles();
}

function clearDensityRectangles() {
    densityRectangles.forEach(r => predictMap.removeLayer(r));
    densityRectangles = [];
}

async function initPredict() {
    const mapEl = document.getElementById("predict-map");

    // Set default datetime to now
    const dtInput = document.getElementById("predict-datetime");
    if (!dtInput.value) {
        const now = new Date();
        now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
        dtInput.value = now.toISOString().slice(0, 16);
    }

    // Populate species dropdown for density mode
    const select = document.getElementById("predict-species-select");
    if (select.options.length === 0 && speciesList.length > 0) {
        speciesList.forEach(sp => {
            const opt = document.createElement("option");
            opt.value = sp.species_id;
            opt.textContent = getSpeciesName(sp);
            select.appendChild(opt);
        });
        // Pre-select current species if available
        if (currentSpeciesId) select.value = currentSpeciesId;
    }

    if (!predictMap) {
        predictMap = L.map(mapEl).setView([52.15, 5.38], 7);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 18,
        }).addTo(predictMap);

        // Click on map to set location (point mode only)
        predictMap.on("click", (e) => {
            if (predictMode === "point") {
                document.getElementById("predict-lat").value = e.latlng.lat.toFixed(4);
                document.getElementById("predict-lon").value = e.latlng.lng.toFixed(4);
                runPrediction();
            }
        });
    } else {
        setTimeout(() => predictMap.invalidateSize(), 100);
    }
}

function _buildIsoStr(dtValue) {
    const dt = new Date(dtValue);
    const offset = -dt.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const hrs = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
    const mins = String(Math.abs(offset) % 60).padStart(2, "0");
    return dtValue + ":00" + sign + hrs + ":" + mins;
}

async function runPrediction() {
    document.getElementById("predict-results").innerHTML =
        '<div style="padding:2rem;text-align:center;color:#888;">' +
        '<p style="font-size:1.2rem;margin-bottom:0.5rem;">Prediction requires the full application</p>' +
        '<p>This feature uses live ML models and weather data that are not available in the static version.</p>' +
        '<p style="margin-top:1rem;font-size:0.9rem;color:#aaa;">Run the full BirdWeather Explorer locally to use predictions.</p>' +
        '</div>';
}

async function runPointPrediction(isoStr) {
    const lat = parseFloat(document.getElementById("predict-lat").value);
    const lon = parseFloat(document.getElementById("predict-lon").value);
    if (isNaN(lat) || isNaN(lon)) return;

    // Update marker on map
    if (predictMarker) predictMap.removeLayer(predictMarker);
    predictMarker = L.marker([lat, lon]).addTo(predictMap);
    predictMap.setView([lat, lon], Math.max(predictMap.getZoom(), 9));
    clearDensityRectangles();
    document.getElementById("density-legend").style.display = "none";

    const resultsEl = document.getElementById("predict-results");
    resultsEl.innerHTML = '<p style="padding:1rem;color:#888;">Loading predictions...</p>';

    try {
        const data = await fetchJSON(`/api/predict?lat=${lat}&lon=${lon}&datetime_str=${encodeURIComponent(isoStr)}`);
        renderPredictions(data);
    } catch (e) {
        resultsEl.innerHTML = `<p style="padding:1rem;color:#e74c3c;">${e.message}</p>`;
    }
}

async function runDensityPrediction(isoStr) {
    const speciesId = document.getElementById("predict-species-select").value;
    if (!speciesId) return;

    if (predictMarker) { predictMap.removeLayer(predictMarker); predictMarker = null; }
    clearDensityRectangles();

    const resultsEl = document.getElementById("predict-results");
    resultsEl.innerHTML = '<p style="padding:1rem;color:#888;">Computing density map...</p>';

    try {
        const data = await fetchJSON(`/api/predict/density/${speciesId}?datetime_str=${encodeURIComponent(isoStr)}`);
        renderDensityMap(data);
    } catch (e) {
        resultsEl.innerHTML = `<p style="padding:1rem;color:#e74c3c;">${e.message}</p>`;
    }
}

function probColor(prob) {
    // Green gradient: transparent at 0, deep green at 1
    const r = Math.round(255 * (1 - prob));
    const g = Math.round(100 + 155 * prob);
    const b = Math.round(80 * (1 - prob));
    return `rgb(${r},${g},${b})`;
}

function renderDensityMap(data) {
    const resultsEl = document.getElementById("predict-results");

    if (!data || !data.grid || data.grid.length === 0) {
        resultsEl.innerHTML = '<p style="padding:1rem;color:#888;">No density data available. Make sure models are trained.</p>';
        return;
    }

    if (data.error) {
        resultsEl.innerHTML = `<p style="padding:1rem;color:#e74c3c;">${data.error}</p>`;
        return;
    }

    const maxP = data.max_probability || 1;
    const sp = speciesList.find(s => s.species_id == data.species_id);
    const spName = sp ? getSpeciesName(sp) : `Species ${data.species_id}`;

    // Draw rectangles on map
    const halfRes = 0.05; // half of 0.1 degree grid resolution
    data.grid.forEach(cell => {
        const opacity = Math.max(0.05, cell.probability / Math.max(maxP, 0.01));
        const color = probColor(cell.probability);
        const rect = L.rectangle(
            [[cell.lat - halfRes, cell.lon - halfRes],
             [cell.lat + halfRes, cell.lon + halfRes]],
            {
                color: color,
                weight: 0.5,
                opacity: 0.6,
                fillColor: color,
                fillOpacity: opacity * 0.7,
            }
        ).addTo(predictMap);
        rect.bindPopup(`<b>${spName}</b><br>Probability: ${(cell.probability * 100).toFixed(1)}%`);
        densityRectangles.push(rect);
    });

    predictMap.setView([52.15, 5.38], 7);

    // Show legend
    document.getElementById("density-legend").style.display = "flex";

    // Summary
    const avgP = data.grid.reduce((s, c) => s + c.probability, 0) / data.grid.length;
    resultsEl.innerHTML = `
        <div style="padding:1rem">
            <h3>${spName} — Density Map</h3>
            <p>Max probability: <b>${(maxP * 100).toFixed(1)}%</b></p>
            <p>Mean probability: <b>${(avgP * 100).toFixed(1)}%</b></p>
            <p>Grid cells: ${data.grid.length}</p>
            <p style="color:#888;font-size:0.85em">Click a cell on the map for details.</p>
        </div>`;
}

function renderPredictions(predictions) {
    const el = document.getElementById("predict-results");
    if (!predictions || predictions.length === 0) {
        el.innerHTML = '<p style="padding:1rem;color:#888;">No predictions available for this location. Try a different spot in the Netherlands.</p>';
        return;
    }

    const maxProb = predictions[0].probability;
    let html = "";
    predictions.forEach((p, i) => {
        const pct = (p.probability * 100).toFixed(1);
        const barWidth = maxProb > 0 ? (p.probability / maxProb * 100) : 0;
        const thumbHtml = p.image_path
            ? `<img class="species-thumb" src="${p.image_path}" alt="" loading="lazy">`
            : `<div class="species-thumb-placeholder">\ud83d\udc26</div>`;
        html += `<div class="predict-item">
            <span class="predict-rank">${i + 1}</span>
            ${thumbHtml}
            <div class="species-item-text" style="flex:1">
                <div class="species-item-name">${getSpeciesNameById(p.species_id) || p.common_name}</div>
                <div class="predict-bar-bg"><div class="predict-bar" style="width:${barWidth}%"></div></div>
            </div>
            <span class="predict-pct">${pct}%</span>
        </div>`;
    });
    el.innerHTML = html;
}

// --- Migration Map ---

let migrationData = null;
let migrationAnimTimer = null;

async function plotMigration() {
    const container = document.getElementById("migration-container");
    container.innerHTML = '<p style="padding:2rem;">Loading migration data...</p>';

    const data = await fetchJSON(`/api/migration/${currentSpeciesId}`);
    migrationData = data;

    if (!data.weeks || data.weeks.length === 0) {
        container.innerHTML = '<p style="padding:2rem;color:#999;">No migration data available for this species.</p>';
        return;
    }

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    // Build HTML: animated map on top, 12 panels below
    container.innerHTML = `
        <div id="migration-anim" style="padding:1rem;">
            <h3 style="margin:0 0 0.5rem 0; font-size:1.1rem;">Weekly Migration — <span id="mig-week-label"></span></h3>
            <div style="display:flex; align-items:center; gap:0.75rem; margin-bottom:0.5rem;">
                <button id="mig-play-btn" onclick="toggleMigrationPlay()" style="padding:4px 12px; cursor:pointer;">Play</button>
                <input type="range" id="mig-slider" min="0" max="${data.weeks.length - 1}" value="0"
                       style="flex:1;" oninput="setMigrationWeek(+this.value)">
                <label style="font-size:0.8rem;">Speed:
                    <select id="mig-speed" style="font-size:0.8rem;">
                        <option value="800">Slow</option>
                        <option value="400" selected>Normal</option>
                        <option value="150">Fast</option>
                    </select>
                </label>
            </div>
            <div id="mig-anim-map" style="height:400px; border-radius:8px; overflow:hidden;"></div>
            <div id="mig-legend" style="display:flex; align-items:center; gap:0.5rem; margin-top:0.4rem; font-size:0.8rem;">
                <span>Low</span>
                <div style="width:200px; height:12px; border-radius:3px;
                     background:linear-gradient(to right, #ffffcc, #c2e699, #78c679, #31a354, #006837);"></div>
                <span>High</span>
                <span style="margin-left:1rem; color:#999;">(detection rate = detections / active stations)</span>
            </div>
        </div>
        <div id="migration-panels" style="padding:0 1rem 1rem;">
            <h3 style="margin:0 0 0.5rem 0; font-size:1.1rem;">Monthly Overview</h3>
            <div id="mig-grid" style="display:grid; grid-template-columns:repeat(4, 1fr); gap:6px;"></div>
        </div>
    `;

    // Initialize animated map
    initMigrationAnimMap(data);

    // Render 12 monthly panels using canvas
    renderMonthlyPanels(data, monthNames);
}

let migAnimMap = null;
let migAnimLayer = null;

function initMigrationAnimMap(data) {
    const el = document.getElementById("mig-anim-map");
    if (migAnimMap) { migAnimMap.remove(); migAnimMap = null; }

    migAnimMap = L.map(el, { zoomControl: true, attributionControl: false }).setView([52.15, 5.38], 7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 12, opacity: 0.4,
    }).addTo(migAnimMap);
    migAnimLayer = L.layerGroup().addTo(migAnimMap);

    setMigrationWeek(0);
}

function setMigrationWeek(idx) {
    if (!migrationData || !migrationData.weeks[idx]) return;
    const week = migrationData.weeks[idx];
    const maxRate = migrationData.max_weekly_rate || 1;

    document.getElementById("mig-slider").value = idx;
    document.getElementById("mig-week-label").textContent =
        `Week of ${week.week_start} (${week.cells.length} cells)`;

    migAnimLayer.clearLayers();
    for (const cell of week.cells) {
        const intensity = Math.min(cell.rate / maxRate, 1);
        const color = migrationColor(intensity);
        L.rectangle(
            [[cell.lat - 0.05, cell.lon - 0.05], [cell.lat + 0.05, cell.lon + 0.05]],
            { color: "none", fillColor: color, fillOpacity: 0.7, weight: 0 }
        ).bindPopup(`<b>Rate:</b> ${cell.rate.toFixed(1)}<br><b>Detections:</b> ${cell.count}<br><b>Stations:</b> ${cell.stations}/${cell.total_stations}`)
         .addTo(migAnimLayer);
    }
}

function toggleMigrationPlay() {
    const btn = document.getElementById("mig-play-btn");
    if (migrationAnimTimer) {
        clearInterval(migrationAnimTimer);
        migrationAnimTimer = null;
        btn.textContent = "Play";
        return;
    }
    btn.textContent = "Pause";
    const slider = document.getElementById("mig-slider");
    const speed = +document.getElementById("mig-speed").value;
    const maxIdx = migrationData.weeks.length - 1;

    migrationAnimTimer = setInterval(() => {
        let idx = +slider.value + 1;
        if (idx > maxIdx) idx = 0;
        setMigrationWeek(idx);
    }, speed);
}

function migrationColor(t) {
    // Green sequential: #ffffcc -> #c2e699 -> #78c679 -> #31a354 -> #006837
    const stops = [
        [255,255,204], [194,230,153], [120,198,121], [49,163,84], [0,104,55]
    ];
    t = Math.max(0, Math.min(1, t));
    const idx = t * (stops.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, stops.length - 1);
    const f = idx - lo;
    const r = Math.round(stops[lo][0] + f * (stops[hi][0] - stops[lo][0]));
    const g = Math.round(stops[lo][1] + f * (stops[hi][1] - stops[lo][1]));
    const b = Math.round(stops[lo][2] + f * (stops[hi][2] - stops[lo][2]));
    return `rgb(${r},${g},${b})`;
}

function renderMonthlyPanels(data, monthNames) {
    const grid = document.getElementById("mig-grid");
    const maxRate = data.max_monthly_rate || 1;

    // Netherlands bounds for canvas projection
    const bounds = { latMin: 50.75, latMax: 53.55, lonMin: 3.35, lonMax: 7.25 };
    const aspect = (bounds.lonMax - bounds.lonMin) / ((bounds.latMax - bounds.latMin) * Math.cos(52.15 * Math.PI / 180));
    const canvasH = 180;
    const canvasW = Math.round(canvasH * aspect);

    grid.innerHTML = "";
    for (let m = 1; m <= 12; m++) {
        const cells = data.monthly[String(m)] || [];
        const totalCount = cells.reduce((s, c) => s + c.count, 0);

        const panel = document.createElement("div");
        panel.style.cssText = "text-align:center; background:#1a1a2e; border-radius:6px; padding:4px;";

        const canvas = document.createElement("canvas");
        canvas.width = canvasW;
        canvas.height = canvasH;
        canvas.style.cssText = `width:100%; border-radius:4px; background:#0d1117;`;
        const ctx = canvas.getContext("2d");

        // Draw NL outline hint (simple rect)
        ctx.strokeStyle = "rgba(255,255,255,0.1)";
        ctx.strokeRect(0, 0, canvasW, canvasH);

        // Draw cells
        const cellW = canvasW / ((bounds.lonMax - bounds.lonMin) / 0.1);
        const cellH = canvasH / ((bounds.latMax - bounds.latMin) / 0.1);

        for (const cell of cells) {
            const x = (cell.lon - bounds.lonMin) / (bounds.lonMax - bounds.lonMin) * canvasW;
            const y = (1 - (cell.lat - bounds.latMin) / (bounds.latMax - bounds.latMin)) * canvasH;
            const intensity = Math.min(cell.rate / maxRate, 1);
            ctx.fillStyle = migrationColor(intensity);
            ctx.globalAlpha = 0.85;
            ctx.fillRect(x - cellW/2, y - cellH/2, cellW, cellH);
        }
        ctx.globalAlpha = 1.0;

        const label = document.createElement("div");
        label.style.cssText = "font-size:0.75rem; color:#ccc; margin-top:2px;";
        label.textContent = `${monthNames[m-1]} (${totalCount.toLocaleString()})`;

        panel.appendChild(canvas);
        panel.appendChild(label);
        grid.appendChild(panel);
    }
}

// --- Helpers ---

function apiUrlToStaticPath(url) {
    const [path, query] = url.split('?');
    const routes = [
        [/^\/api\/status$/, 'data/status.json'],
        [/^\/api\/species$/, 'data/species.json'],
        [/^\/api\/rhythm-all$/, 'data/rhythm_all.json'],
        [/^\/api\/rhythm\/(\d+)$/, (m) => `data/rhythm_${m[1]}.json`],
        [/^\/api\/daily\/(\d+)$/, (m) => `data/daily_${m[1]}.json`],
        [/^\/api\/heatmap\/(\d+)$/, (m) => `data/heatmap_${m[1]}.json`],
        [/^\/api\/insights\/(\d+)$/, (m) => `data/insights_${m[1]}.json`],
        [/^\/api\/locations\/(\d+)$/, (m) => `data/locations_${m[1]}.json`],
        [/^\/api\/migration\/(\d+)$/, (m) => `data/migration_${m[1]}.json`],
        [/^\/api\/weather\/daily\/(\d+)$/, (m) => `data/weather_daily_${m[1]}.json`],
        [/^\/api\/weather\/correlation\/(\d+)$/, (m) => `data/weather_correlation_${m[1]}.json`],
        [/^\/api\/weather\/hourly-pattern\/(\d+)$/, (m) => `data/weather_hourly_pattern_${m[1]}.json`],
        [/^\/api\/ecology$/, 'data/ecology_clustering.json'],
        [/^\/api\/density$/, 'data/density_heatmap.json'],
        [/^\/api\/fp\/pairs/, () => (query || '').includes('suspect_only=false') ? 'data/fp_pairs.json' : 'data/fp_pairs_suspect.json'],
        [/^\/api\/fp\/species\/(\d+)$/, (m) => `data/fp_species_${m[1]}.json`],
    ];
    for (const [pattern, resolver] of routes) {
        const match = path.match(pattern);
        if (match) return typeof resolver === 'function' ? resolver(match) : resolver;
    }
    return null;
}

async function fetchJSON(url, opts = {}) {
    const staticPath = apiUrlToStaticPath(url);
    if (!staticPath) {
        throw new Error('This feature is not available in the static version.');
    }
    const myGen = renderGen;
    const controller = new AbortController();
    currentController = controller;
    const res = await fetch(staticPath, { signal: controller.signal, ...opts });
    // If a new render started while we were waiting, discard this result
    if (myGen !== renderGen) throw new DOMException("Render cancelled", "AbortError");
    if (!res.ok) {
        throw new Error(`Data not available (${res.status})`);
    }
    return res.json();
}

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
    if (migrationAnimTimer) clearInterval(migrationAnimTimer);
    currentController?.abort();
});

// Boot
init();
