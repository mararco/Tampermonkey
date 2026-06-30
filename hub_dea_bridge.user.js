// ==UserScript==
// @name         Hub DEA Bridge - Quality
// @namespace    package-detail-quality
// @version      2.0
// @description  Cruza paquetes Store del Sort Planning con fallos DEA. Fetch estacion a estacion, descarta no-DEA y muestra resultado con bucket/sub_bucket.
// @author       mararco
// @match        https://eu.sort.planning.last-mile.a2z.com/*
// @updateURL    https://raw.githubusercontent.com/mararco/tampermonkey/main/hub_dea_bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/mararco/tampermonkey/main/hub_dea_bridge.user.js
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const SORT_API_BASE = 'https://ppj1bqrabh.execute-api.eu-west-1.amazonaws.com/ws/api';
  const ROUTE_API_BASE = 'https://wqhfwnv4ee.execute-api.eu-west-1.amazonaws.com/ws/api';
  const STORE_KEY = 'hubDeaBridgeResults';

  const NETWORK_STATIONS = [
    'DAS1','DCT4','DCT7','DCT9','DCZ3','DCZ4','DGA1','DGA2','DGP1','DIC1',
    'DMA3','DMA4','DMA6','DMZ2','DMZ4','DQA3','DQA4','DQA7','DQA8','DQB2',
    'DQB5','DQB6','DQB9','DQE2','DQL2','DQM5','DQV2','DQV6','DQV8','DZG2',
    'EGP1','EHM1','EHM2','EHM4','EHM5','EHM7','EHM8','EHM9','EQA2','EQA5',
    'EQA7','EQB1','EQB2','EQB3','EQB6','EQB9','EQE2','EQL2','EQV2','EQV8',
    'EQW7','EQZ3','OCB4','OCL2','OCL3','OCL4','OCL5','OCM1','OCM2','OCM4',
    'OCN1','OCN2','OGA5','OML1','OQA3','OQA4','OQA6','OQV7'
  ];

  // ─── BRAND COLORS ─────────────────────────────────────────────────────────
  const C = {
    primary: '#4a6d8c',
    primaryHover: '#3d5c77',
    primaryLight: '#e8eff5',
    dark: '#232f3e',
    darkHover: '#37475a',
    red: '#c62828',
    redHover: '#a51d1d',
    redLight: '#fce4ec',
    grey: '#d5d9d9',
    greyHover: '#bbb',
    text: '#232f3e',
    textMuted: '#565959',
    white: '#ffffff',
    border: '#d5d9d9',
    rowHover: '#eef3f7',
  };

  // ─── DATE HELPERS ─────────────────────────────────────────────────────────
  function getDateRange(startStr, endStr) {
    const dates = [];
    const [sy, sm, sd] = startStr.split('-').map(Number);
    const [ey, em, ed] = endStr.split('-').map(Number);
    const start = new Date(Date.UTC(sy, sm - 1, sd));
    const end = new Date(Date.UTC(ey, em - 1, ed));
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
  }

  // ─── DATA STORE ────────────────────────────────────────────────────────────
  function getStoredResults() {
    try { return JSON.parse(sessionStorage.getItem(STORE_KEY)) || []; }
    catch (e) { return []; }
  }
  function setStoredResults(data) { sessionStorage.setItem(STORE_KEY, JSON.stringify(data)); }
  function clearStoredResults() { sessionStorage.removeItem(STORE_KEY); }

  // ─── DEA DATA (parsed from uploaded file, kept in memory) ─────────────────
  let deaData = null; // { trackingMap: Map<trackingId, {bucket, sub_bucket, num_items}> }

  function parseDeaCSV(text) {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return null;
    const headers = lines[0].split(',').map(h => h.trim());
    const tidIdx = headers.indexOf('tracking_id');
    const bucketIdx = headers.indexOf('bucket');
    const subBucketIdx = headers.indexOf('sub_bucket');
    if (tidIdx === -1) return null;

    // Count occurrences per tracking_id and store bucket/sub_bucket from first occurrence
    const countMap = new Map(); // trackingId -> count
    const infoMap = new Map(); // trackingId -> {bucket, sub_bucket}
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const tid = values[tidIdx] || '';
      if (!tid) continue;
      countMap.set(tid, (countMap.get(tid) || 0) + 1);
      if (!infoMap.has(tid)) {
        infoMap.set(tid, {
          bucket: bucketIdx !== -1 ? (values[bucketIdx] || '') : '',
          sub_bucket: subBucketIdx !== -1 ? (values[subBucketIdx] || '') : '',
        });
      }
    }

    // Build final map: trackingId -> {bucket, sub_bucket, num_items}
    const trackingMap = new Map();
    for (const [tid, count] of countMap) {
      const info = infoMap.get(tid);
      trackingMap.set(tid, { ...info, num_items: count });
    }
    return { trackingMap, totalRows: lines.length - 1, uniqueIds: trackingMap.size };
  }

  // ─── CSV PARSER (for sort plan) ────────────────────────────────────────────
  function parseCSV(text) {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return { headers: [], rows: [] };
    const headers = lines[0].split(',').map(h => h.trim());
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      rows.push(values);
    }
    return { headers, rows };
  }

  // ─── NATIVE API ──────────────────────────────────────────────────────────
  async function apiFetch(url) {
    if (document.hasStorageAccess && !(await document.hasStorageAccess())) {
      try { await document.requestStorageAccess(); } catch (e) { /* ignore */ }
    }
    const res = await fetch(url, {
      method: 'GET', credentials: 'include',
      headers: { 'Accept': 'application/json, text/plain, */*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiFetchText(url) {
    if (document.hasStorageAccess && !(await document.hasStorageAccess())) {
      try { await document.requestStorageAccess(); } catch (e) { /* ignore */ }
    }
    const res = await fetch(url, {
      method: 'GET', credentials: 'include',
      headers: { 'Accept': 'application/json, text/plain, */*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    if (text.startsWith('"') && text.endsWith('"')) {
      try { return JSON.parse(text); } catch (e) { /* fall through */ }
    }
    return text.trim();
  }

  async function fetchPresignedContent(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: url,
        onload: function(response) {
          if (response.status >= 200 && response.status < 300) resolve(response.responseText);
          else reject(new Error(`HTTP ${response.status} fetching CSV from S3`));
        },
        onerror: function() { reject(new Error('Network error fetching CSV from S3')); },
        ontimeout: function() { reject(new Error('Timeout fetching CSV from S3')); }
      });
    });
  }

  // ─── SORT PLAN CSV (Sort-to-Route stations) ───────────────────────────────
  async function fetchSortPlanCSV(station, planDate) {
    try {
      const config = await apiFetch(`${SORT_API_BASE}/routingConfig/${station}?planDate=${planDate}`);
      if (!config.supportedCycles || config.supportedCycles.length === 0) return null;
      const cycle1 = config.supportedCycles.find(c => c.cycleName === 'CYCLE_1');
      if (!cycle1) return null;

      const sortPlans = await apiFetch(
        `${SORT_API_BASE}/sortPlans/${station}/${cycle1.cycleId}/${planDate}?activeOnly=true`
      );
      if (!sortPlans || sortPlans.length === 0) return null;

      const activePlan = sortPlans.find(p => p.isActivePlan) || sortPlans[0];
      const planId = activePlan.planId || activePlan.id;
      if (!planId) return null;

      const csvUrl = await apiFetchText(
        `${SORT_API_BASE}/sortPlanCSV/${station}/${planDate}/${planId}`
      );
      if (!csvUrl || !csvUrl.startsWith('http')) return null;

      const csvText = await fetchPresignedContent(csvUrl);
      const { headers, rows } = parseCSV(csvText);

      const modeIdx = headers.indexOf('Mode of transportation');
      const nodeIdIdx = headers.indexOf('Node id');
      const nodeNameIdx = headers.indexOf('Node name');
      const shipmentIdx = headers.indexOf('Shipment id');
      if (modeIdx === -1 || shipmentIdx === -1) return null;

      const results = [];
      for (const row of rows) {
        if (row[modeIdx] === 'Store') {
          results.push({
            station,
            planDate,
            storeName: row[nodeNameIdx] || '',
            storeId: row[nodeIdIdx] || '',
            trackingId: row[shipmentIdx] || '',
          });
        }
      }
      return results.length > 0 ? results : null;
    } catch (e) {
      console.log(`[HubDEA] ${station}/${planDate}: Sort Plan failed:`, e.message);
      return null;
    }
  }

  // ─── NODE PLAN EXPORT (Sort-to-Zone stations) ─────────────────────────────
  async function fetchNodePlanExport(station, planDate) {
    const config = await apiFetch(`${ROUTE_API_BASE}/routingConfig/${station}?planDate=${planDate}`);
    if (!config.supportedCycles || config.supportedCycles.length === 0) {
      throw new Error(`[${station}/${planDate}] No cycles found.`);
    }
    const cycle1 = config.supportedCycles.find(c => c.cycleName === 'CYCLE_1');
    if (!cycle1) throw new Error(`[${station}/${planDate}] CYCLE_1 not found.`);

    const allocData = await apiFetch(
      `${ROUTE_API_BASE}/nodeAllocations/${station}/${cycle1.cycleId}?planDate=${planDate}`
    );
    if (!allocData || allocData.length === 0) {
      throw new Error(`[${station}/${planDate}] No node allocations.`);
    }

    let planId = null;
    for (const planEntry of allocData) {
      if (!planEntry.cycles) continue;
      const successEvent = [...planEntry.cycles].reverse().find(e => e.status === 'SUCCESS');
      if (successEvent) { planId = planEntry.planId || planEntry.id; break; }
    }
    if (!planId) throw new Error(`[${station}/${planDate}] No successful plan found.`);

    const csvUrl = await apiFetchText(
      `${ROUTE_API_BASE}/nodePlan/export/${station}/${cycle1.cycleId}/${planId}/packages?planDate=${planDate}`
    );
    if (!csvUrl || !csvUrl.startsWith('http')) {
      throw new Error(`[${station}/${planDate}] nodePlan/export did not return a valid URL.`);
    }

    const csvText = await fetchPresignedContent(csvUrl);
    const { headers, rows } = parseCSV(csvText);

    const trackingIdx = headers.indexOf('Tracking ID');
    const storeIdIdx = headers.indexOf('Store ID');
    const storeNameIdx = headers.indexOf('Store Name');
    if (trackingIdx === -1) throw new Error(`[${station}/${planDate}] CSV missing Tracking ID column.`);

    const results = [];
    for (const row of rows) {
      results.push({
        station, planDate,
        storeName: row[storeNameIdx] || '',
        storeId: row[storeIdIdx] || '',
        trackingId: row[trackingIdx] || '',
      });
    }
    if (results.length === 0) throw new Error(`[${station}/${planDate}] No package data.`);
    return results;
  }

  // ─── UNIFIED FETCH (try Sort Plan first, fallback to Node Plan) ───────────
  async function fetchPackageData(station, planDate) {
    const sortResult = await fetchSortPlanCSV(station, planDate);
    if (sortResult && sortResult.length > 0) return sortResult;
    console.log(`[HubDEA] ${station}/${planDate}: Sort Plan empty, trying Node Plan...`);
    const nodeResult = await fetchNodePlanExport(station, planDate);
    return nodeResult;
  }

  // ─── CROSS WITH DEA (station by station) ──────────────────────────────────
  // For each station: fetch sort plan, filter Store, cross with DEA, keep only matches
  async function fetchAndCrossStation(station, dates, deaTrackingMap, onProgress) {
    const matches = [];
    for (const date of dates) {
      onProgress(`${station} / ${date}...`);
      try {
        const storePackages = await fetchPackageData(station, date);
        if (!storePackages) continue;

        // Cross: only keep packages whose trackingId is in DEA
        const seen = new Set(); // deduplicate within this station/date
        for (const pkg of storePackages) {
          const tid = pkg.trackingId;
          if (!tid || seen.has(tid)) continue;
          const deaInfo = deaTrackingMap.get(tid);
          if (deaInfo) {
            seen.add(tid);
            matches.push({
              station: pkg.station,
              trackingId: tid,
              hubPartner: pkg.storeName,
              bucket: deaInfo.bucket,
              subBucket: deaInfo.sub_bucket,
              numItems: deaInfo.num_items,
            });
          }
        }
      } catch (e) {
        console.warn(`[HubDEA] ${station}/${date}: ${e.message}`);
      }
    }
    return matches;
  }

  // ─── MAIN FETCH & CROSS LOGIC ─────────────────────────────────────────────
  async function fetchAndCrossAll(stations, dates, statusEl) {
    if (!deaData) {
      statusEl.textContent = 'Sube primero el archivo DEA CSV.';
      statusEl.style.color = C.red;
      return null;
    }

    const allMatches = [];
    const errors = [];
    const total = stations.length;
    let count = 0;

    for (const station of stations) {
      count++;
      statusEl.textContent = `Procesando ${station} (${count}/${total})...`;
      statusEl.style.color = C.textMuted;
      try {
        const matches = await fetchAndCrossStation(station, dates, deaData.trackingMap, (msg) => {
          statusEl.textContent = `[${count}/${total}] ${msg}`;
        });
        allMatches.push(...matches);
      } catch (e) {
        errors.push(`${station}: ${e.message}`);
      }
    }

    if (errors.length > 0) console.warn('[HubDEA] Errors:', errors);

    if (allMatches.length === 0) {
      statusEl.textContent = `No se encontraron coincidencias DEA en paquetes Store.${errors.length ? ' Errores: ' + errors.length : ''}`;
      statusEl.style.color = C.red;
      return null;
    }

    // Store results
    setStoredResults(allMatches);
    const totalItems = allMatches.reduce((sum, r) => sum + r.numItems, 0);
    statusEl.textContent = `Completado: ${allMatches.length} paquetes (${totalItems} items) con fallo DEA en Hub Partners.`;
    statusEl.style.color = C.primary;
    return allMatches;
  }

  // ─── DOWNLOAD CSV ─────────────────────────────────────────────────────────
  function downloadResultsCSV(data, filename) {
    const headers = ['Estacion','Tracking ID','Hub Partner','Bucket','Sub-bucket','Items'];
    const rows = data.map(r => [
      r.station,
      r.trackingId,
      `"${(r.hubPartner || '').replace(/"/g, '""')}"`,
      r.bucket,
      r.subBucket,
      r.numItems
    ].join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename || `DEA_HubPartners_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  // ─── RESULTS OVERLAY ──────────────────────────────────────────────────────
  function createResultsOverlay(data) {
    const existing = document.getElementById('pd-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'pd-overlay';

    // Summary calculations
    const totalItems = data.reduce((sum, r) => sum + r.numItems, 0);
    const stations = [...new Set(data.map(r => r.station))];

    // Group by hub partner
    const byHub = {};
    data.forEach(r => {
      if (!byHub[r.hubPartner]) byHub[r.hubPartner] = { paq: 0, items: 0 };
      byHub[r.hubPartner].paq++;
      byHub[r.hubPartner].items += r.numItems;
    });
    const hubSorted = Object.entries(byHub).sort((a, b) => b[1].paq - a[1].paq);

    // Group by bucket
    const byBucket = {};
    data.forEach(r => {
      const key = `${r.bucket} / ${r.subBucket}`;
      if (!byBucket[key]) byBucket[key] = { paq: 0, items: 0 };
      byBucket[key].paq++;
      byBucket[key].items += r.numItems;
    });
    const bucketSorted = Object.entries(byBucket).sort((a, b) => b[1].paq - a[1].paq);

    // Summary HTML
    const summaryHubRows = hubSorted.map(([name, v]) =>
      `<tr><td>${name}</td><td style="text-align:right">${v.paq}</td><td style="text-align:right">${v.items}</td></tr>`
    ).join('');
    const summaryBucketRows = bucketSorted.map(([name, v]) =>
      `<tr><td>${name}</td><td style="text-align:right">${v.paq}</td><td style="text-align:right">${v.items}</td></tr>`
    ).join('');

    // Detail table (cap at 5000 for display)
    const displayCap = 5000;
    const displayData = data.slice(0, displayCap);
    const tableRows = displayData.map(r =>
      `<tr><td>${r.station}</td><td>${r.trackingId}</td>` +
      `<td title="${r.hubPartner}">${r.hubPartner.length > 30 ? r.hubPartner.substring(0,30)+'\u2026' : r.hubPartner}</td>` +
      `<td>${r.bucket}</td><td>${r.subBucket}</td><td style="text-align:right">${r.numItems}</td></tr>`
    ).join('');
    const capNote = data.length > displayCap
      ? `<div style="padding:8px;font-size:11px;color:${C.red};">Mostrando ${displayCap} de ${data.length} filas. Exporta CSV para ver todo.</div>`
      : '';

    overlay.innerHTML = `
      <style>
        #pd-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(35,47,62,0.5);backdrop-filter:blur(4px);z-index:999998;display:flex;align-items:center;justify-content:center;font-family:'Amazon Ember',Arial,sans-serif;}
        #pd-overlay .pd-card{background:${C.white};border-radius:10px;padding:24px;max-width:95vw;max-height:90vh;width:1100px;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,0.25);}
        #pd-overlay .pd-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-shrink:0;}
        #pd-overlay .pd-header h2{margin:0;font-size:16px;color:${C.text};font-weight:600;}
        #pd-overlay .pd-header .pd-acts{display:flex;gap:8px;}
        #pd-overlay .pd-btn{padding:6px 14px;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;transition:background 0.15s;}
        #pd-overlay .pd-btn-dark{background:${C.dark};color:${C.white};}
        #pd-overlay .pd-btn-dark:hover{background:${C.darkHover};}
        #pd-overlay .pd-btn-red{background:${C.red};color:${C.white};}
        #pd-overlay .pd-btn-red:hover{background:${C.redHover};}
        #pd-overlay .pd-btn-ghost{background:${C.grey};color:${C.text};}
        #pd-overlay .pd-btn-ghost:hover{background:${C.greyHover};}
        #pd-overlay .pd-tabs{display:flex;gap:0;margin-bottom:12px;border-bottom:2px solid ${C.border};}
        #pd-overlay .pd-tab{padding:8px 16px;font-size:12px;font-weight:600;cursor:pointer;border:none;background:none;color:${C.textMuted};border-bottom:2px solid transparent;margin-bottom:-2px;transition:all 0.15s;}
        #pd-overlay .pd-tab.active{color:${C.primary};border-bottom-color:${C.primary};}
        #pd-overlay .pd-tab:hover{color:${C.primary};}
        #pd-overlay .pd-panel{display:none;overflow:auto;flex:1;border:1px solid ${C.border};border-radius:4px;}
        #pd-overlay .pd-panel.active{display:block;}
        #pd-overlay table{width:100%;border-collapse:collapse;font-size:12px;}
        #pd-overlay thead{position:sticky;top:0;z-index:1;}
        #pd-overlay th{background:${C.primary};color:${C.white};padding:8px 10px;text-align:left;white-space:nowrap;font-weight:600;}
        #pd-overlay td{padding:6px 10px;border-bottom:1px solid #f0f0f0;white-space:nowrap;}
        #pd-overlay tr:hover td{background:${C.rowHover};}
        #pd-overlay .pd-footer{margin-top:10px;font-size:12px;color:${C.textMuted};flex-shrink:0;}
        #pd-overlay .pd-summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:12px;}
        #pd-overlay .pd-summary-section h3{margin:0 0 8px;font-size:13px;color:${C.text};}
        #pd-overlay .pd-summary-section table th{background:${C.dark};}
      </style>
      <div class="pd-card">
        <div class="pd-header">
          <h2>Fallos DEA en Hub Partners: ${data.length} paquetes | ${totalItems} items</h2>
          <div class="pd-acts">
            <button class="pd-btn pd-btn-dark" id="pd-csv-btn">Exportar CSV</button>
            <button class="pd-btn pd-btn-red" id="pd-clear-btn">Limpiar</button>
            <button class="pd-btn pd-btn-ghost" id="pd-close-btn">\u2715</button>
          </div>
        </div>
        <div class="pd-tabs">
          <button class="pd-tab active" data-panel="summary">Resumen</button>
          <button class="pd-tab" data-panel="detail">Detalle</button>
        </div>
        <div class="pd-panel active" id="panel-summary">
          <div class="pd-summary-grid">
            <div class="pd-summary-section">
              <h3>Por Hub Partner</h3>
              <table><thead><tr><th>Hub Partner</th><th>Paquetes</th><th>Items</th></tr></thead>
              <tbody>${summaryHubRows}
              <tr style="font-weight:bold;border-top:2px solid ${C.border}"><td>TOTAL</td><td style="text-align:right">${data.length}</td><td style="text-align:right">${totalItems}</td></tr>
              </tbody></table>
            </div>
            <div class="pd-summary-section">
              <h3>Por Bucket / Sub-bucket</h3>
              <table><thead><tr><th>Bucket / Sub-bucket</th><th>Paquetes</th><th>Items</th></tr></thead>
              <tbody>${summaryBucketRows}</tbody></table>
            </div>
          </div>
        </div>
        <div class="pd-panel" id="panel-detail">
          <table><thead><tr><th>Estacion</th><th>Tracking ID</th><th>Hub Partner</th><th>Bucket</th><th>Sub-bucket</th><th>Items</th></tr></thead>
          <tbody>${tableRows}</tbody></table>
          ${capNote}
        </div>
        <div class="pd-footer">Estaciones: ${stations.join(', ')}</div>
      </div>`;

    document.body.appendChild(overlay);

    // Tab switching
    overlay.querySelectorAll('.pd-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        overlay.querySelectorAll('.pd-tab').forEach(t => t.classList.remove('active'));
        overlay.querySelectorAll('.pd-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        overlay.querySelector(`#panel-${tab.dataset.panel}`).classList.add('active');
      });
    });

    overlay.querySelector('#pd-close-btn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#pd-csv-btn').addEventListener('click', () => downloadResultsCSV(data));
    overlay.querySelector('#pd-clear-btn').addEventListener('click', () => { clearStoredResults(); overlay.remove(); });
  }

  // ─── GLOBAL STYLES (modal) ────────────────────────────────────────────────
  function injectGlobalStyles() {
    if (document.getElementById('pd-global-styles')) return;
    const style = document.createElement('style');
    style.id = 'pd-global-styles';
    style.textContent = `
      #pd-modal-backdrop{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(35,47,62,0.5);backdrop-filter:blur(4px);z-index:99998;display:flex;align-items:center;justify-content:center;font-family:'Amazon Ember',Arial,sans-serif;font-size:13px;}
      #pd-modal{background:${C.white};border-radius:10px;padding:28px 32px;width:420px;max-width:90vw;box-shadow:0 12px 48px rgba(0,0,0,0.25);display:flex;flex-direction:column;gap:16px;}
      #pd-modal .pd-modal-header{display:flex;justify-content:space-between;align-items:center;}
      #pd-modal .pd-modal-header h2{margin:0;font-size:16px;font-weight:600;color:${C.text};}
      #pd-modal .pd-modal-header .pd-close{width:28px;height:28px;border:none;border-radius:4px;background:${C.grey};color:${C.text};font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s;}
      #pd-modal .pd-modal-header .pd-close:hover{background:${C.greyHover};}
      #pd-modal label{display:block;margin-bottom:4px;font-weight:600;color:${C.darkHover};font-size:12px;}
      #pd-modal .pd-input{width:100%;padding:8px 10px;border:1px solid ${C.border};border-radius:4px;font-size:13px;box-sizing:border-box;transition:border-color 0.15s,box-shadow 0.15s;}
      #pd-modal .pd-input:focus{outline:none;border-color:${C.primary};box-shadow:0 0 0 2px rgba(74,109,140,0.15);}
      #pd-modal .pd-dd{position:relative;}
      #pd-modal .pd-dd-trigger{width:100%;padding:8px 10px;border:1px solid ${C.border};border-radius:4px;font-size:12px;background:${C.white};cursor:pointer;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;transition:border-color 0.15s;}
      #pd-modal .pd-dd-trigger:hover{border-color:${C.primary};}
      #pd-modal .pd-dd-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:${C.text};}
      #pd-modal .pd-dd-arrow{margin-left:8px;font-size:9px;color:${C.textMuted};}
      #pd-modal .pd-dd-popup{display:none;position:absolute;bottom:calc(100% + 4px);left:0;right:0;background:${C.white};border:1px solid ${C.border};border-radius:6px;box-shadow:0 -4px 20px rgba(0,0,0,0.12);max-height:260px;z-index:100000;flex-direction:column;overflow:hidden;}
      #pd-modal .pd-dd-popup.open{display:flex;}
      #pd-modal .pd-dd-search{padding:8px 10px;border:none;border-bottom:1px solid #eee;font-size:12px;outline:none;}
      #pd-modal .pd-dd-bar{display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid #eee;}
      #pd-modal .pd-dd-bar button{flex:1;padding:4px 8px;font-size:10px;font-weight:600;border:none;border-radius:3px;cursor:pointer;transition:background 0.15s;}
      #pd-modal .pd-dd-bar .pd-dd-all{background:${C.primaryLight};color:${C.primary};}
      #pd-modal .pd-dd-bar .pd-dd-all:hover{background:#d0dfe9;}
      #pd-modal .pd-dd-bar .pd-dd-clr{background:${C.redLight};color:${C.red};}
      #pd-modal .pd-dd-bar .pd-dd-clr:hover{background:#f8c8c8;}
      #pd-modal .pd-dd-bar .pd-dd-ok{background:${C.primary};color:${C.white};}
      #pd-modal .pd-dd-bar .pd-dd-ok:hover{background:${C.primaryHover};}
      #pd-modal .pd-dd-list{overflow-y:auto;max-height:180px;}
      #pd-modal .pd-dd-item{padding:5px 10px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:8px;transition:background 0.1s;}
      #pd-modal .pd-dd-item:hover{background:#f5f7f9;}
      #pd-modal .pd-dd-item input[type="checkbox"]{margin:0;accent-color:${C.primary};}
      #pd-modal .pd-other-row{display:flex;gap:6px;align-items:center;}
      #pd-modal .pd-other-toggle{padding:6px 12px;border:1px solid ${C.border};border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;background:${C.white};color:${C.primary};transition:all 0.15s;white-space:nowrap;}
      #pd-modal .pd-other-toggle:hover{background:${C.primaryLight};}
      #pd-modal .pd-other-toggle.active{background:${C.primary};color:${C.white};border-color:${C.primary};}
      #pd-modal .pd-date-row{display:flex;gap:10px;}
      #pd-modal .pd-date-row > div{flex:1;}
      #pd-modal .pd-actions{display:flex;gap:8px;}
      #pd-modal .pd-btn{flex:1;padding:10px;border:none;border-radius:4px;font-size:13px;font-weight:600;cursor:pointer;transition:background 0.15s;}
      #pd-modal .pd-btn-fetch{background:${C.primary};color:${C.white};}
      #pd-modal .pd-btn-fetch:hover{background:${C.primaryHover};}
      #pd-modal .pd-btn-fetch:disabled{background:${C.grey};color:${C.textMuted};cursor:not-allowed;}
      #pd-modal .pd-btn-view{background:${C.dark};color:${C.white};}
      #pd-modal .pd-btn-view:hover{background:${C.darkHover};}
      #pd-modal .pd-status{font-size:11px;color:${C.textMuted};min-height:16px;line-height:1.4;}
      #pd-modal .pd-separator{height:1px;background:linear-gradient(to right,transparent,${C.border},transparent);margin:4px 0;}
      #pd-modal .pd-drop-section{display:flex;flex-direction:column;gap:8px;}
      #pd-modal .pd-dropzone{border:2px dashed ${C.border};border-radius:8px;padding:20px;text-align:center;cursor:pointer;transition:all 0.2s;background:${C.white};}
      #pd-modal .pd-dropzone:hover{border-color:${C.primary};background:${C.primaryLight};}
      #pd-modal .pd-dropzone.dragover{border-color:${C.primary};background:${C.primaryLight};transform:scale(1.01);}
      #pd-modal .pd-dropzone.loaded{border-color:#2e7d32;background:#e8f5e9;}
      #pd-modal .pd-dropzone-icon{font-size:28px;margin-bottom:6px;opacity:0.7;}
      #pd-modal .pd-dropzone-text{font-size:13px;font-weight:600;color:${C.text};}
      #pd-modal .pd-dropzone-hint{font-size:11px;color:${C.textMuted};margin-top:2px;}
      #pd-modal .pd-drop-status{font-size:11px;color:${C.textMuted};min-height:14px;}
    `;
    document.head.appendChild(style);
  }

  // ─── MODAL UI ─────────────────────────────────────────────────────────────
  function showModal() {
    if (document.getElementById('pd-modal-backdrop')) return;
    injectGlobalStyles();

    const today = new Date().toISOString().split('T')[0];
    // Default: yesterday (sort plan del dia anterior)
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    let selectedStations = new Set();
    let showOtherInput = false;

    const backdrop = document.createElement('div');
    backdrop.id = 'pd-modal-backdrop';
    backdrop.innerHTML = `
      <div id="pd-modal">
        <div class="pd-modal-header">
          <h2>Hub DEA Bridge</h2>
          <button class="pd-close" id="pd-modal-close">\u2715</button>
        </div>
        <div class="pd-drop-section">
          <label>1. Archivo DEA (Dive Deep Data Last Mile)</label>
          <div class="pd-dropzone${deaData ? ' loaded' : ''}" id="pd-dropzone">
            <div class="pd-dropzone-icon">${deaData ? '\u2705' : '\uD83D\uDCC4'}</div>
            <div class="pd-dropzone-text">${deaData ? 'DEA cargado: ' + deaData.uniqueIds + ' tracking IDs' : 'Arrastra el CSV de DEA aqui'}</div>
            <div class="pd-dropzone-hint">${deaData ? 'Click para cambiar archivo' : 'o haz click para seleccionar'}</div>
            <input type="file" id="pd-file-input" accept=".csv" style="display:none;" />
          </div>
          <div class="pd-drop-status" id="pd-drop-status"></div>
        </div>
        <div class="pd-separator"></div>
        <div>
          <label>2. Estaciones</label>
          <div class="pd-dd" id="pd-dd">
            <div class="pd-dd-trigger" id="pd-dd-trigger">
              <span class="pd-dd-text">Selecciona estaciones...</span>
              <span class="pd-dd-arrow">\u25BC</span>
            </div>
            <div class="pd-dd-popup" id="pd-dd-popup">
              <input type="text" class="pd-dd-search" id="pd-dd-search" placeholder="Buscar estacion..." />
              <div class="pd-dd-bar">
                <button class="pd-dd-all" id="pd-dd-all">TODAS</button>
                <button class="pd-dd-all" id="pd-dd-shared">SHARED</button>
                <button class="pd-dd-all" id="pd-dd-exclusive">EXCLUSIVE</button>
                <button class="pd-dd-clr" id="pd-dd-clr">NINGUNA</button>
                <button class="pd-dd-ok" id="pd-dd-ok">APLICAR</button>
              </div>
              <div class="pd-dd-list" id="pd-dd-list"></div>
            </div>
          </div>
        </div>
        <div class="pd-other-row">
          <button class="pd-other-toggle" id="pd-other-toggle">+ Otras</button>
          <input type="text" class="pd-input" id="pd-other-input" placeholder="ej: XYZ1, ABC2" style="display:none;flex:1;" />
        </div>
        <div class="pd-date-row">
          <div><label>3. Fecha desde</label><input type="date" class="pd-input" id="pd-date-from" value="${yesterday}" /></div>
          <div><label>Fecha hasta</label><input type="date" class="pd-input" id="pd-date-to" value="${yesterday}" /></div>
        </div>
        <div class="pd-actions">
          <button class="pd-btn pd-btn-fetch" id="pd-fetch-btn">Cruzar datos</button>
          <button class="pd-btn pd-btn-view" id="pd-view-btn">Ver resultados</button>
        </div>
        <div class="pd-status" id="pd-status"></div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const modal = backdrop.querySelector('#pd-modal');
    const ddTrigger = modal.querySelector('#pd-dd-trigger');
    const ddPopup = modal.querySelector('#pd-dd-popup');
    const ddSearch = modal.querySelector('#pd-dd-search');
    const ddList = modal.querySelector('#pd-dd-list');
    const otherToggle = modal.querySelector('#pd-other-toggle');
    const otherInput = modal.querySelector('#pd-other-input');
    const statusEl = modal.querySelector('#pd-status');

    function closeModal() { backdrop.remove(); }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    modal.querySelector('#pd-modal-close').addEventListener('click', closeModal);

    // ─── DROPDOWN LOGIC ────────────────────────────────────────────────────
    function renderList(filter = '') {
      const f = filter.toUpperCase();
      ddList.innerHTML = NETWORK_STATIONS
        .filter(s => !f || s.includes(f))
        .map(s => `<label class="pd-dd-item"><input type="checkbox" value="${s}" ${selectedStations.has(s)?'checked':''}> ${s}</label>`)
        .join('');
    }

    function updateTriggerText() {
      const textEl = ddTrigger.querySelector('.pd-dd-text');
      const otherVals = otherInput.value.trim().toUpperCase().split(',').map(s=>s.trim()).filter(s=>s);
      const count = selectedStations.size + otherVals.length;
      if (count === 0) textEl.textContent = 'Selecciona estaciones...';
      else if (count <= 4) textEl.textContent = [...selectedStations, ...otherVals].join(', ');
      else textEl.textContent = `${count} estaciones seleccionadas`;
    }

    ddTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = ddPopup.classList.contains('open');
      if (isOpen) { ddPopup.classList.remove('open'); updateTriggerText(); }
      else { ddPopup.classList.add('open'); renderList(); ddSearch.value = ''; ddSearch.focus(); }
    });

    ddSearch.addEventListener('input', () => renderList(ddSearch.value));
    ddSearch.addEventListener('click', (e) => e.stopPropagation());

    ddList.addEventListener('change', (e) => {
      if (e.target.type === 'checkbox') {
        if (e.target.checked) selectedStations.add(e.target.value);
        else selectedStations.delete(e.target.value);
      }
    });

    modal.querySelector('#pd-dd-all').addEventListener('click', (e) => {
      e.stopPropagation();
      NETWORK_STATIONS.forEach(s => selectedStations.add(s));
      renderList(ddSearch.value);
    });

    modal.querySelector('#pd-dd-shared').addEventListener('click', (e) => {
      e.stopPropagation();
      selectedStations.clear();
      NETWORK_STATIONS.filter(s => s.startsWith('D') || s.startsWith('O')).forEach(s => selectedStations.add(s));
      renderList(ddSearch.value);
    });

    modal.querySelector('#pd-dd-exclusive').addEventListener('click', (e) => {
      e.stopPropagation();
      selectedStations.clear();
      NETWORK_STATIONS.filter(s => s.startsWith('E')).forEach(s => selectedStations.add(s));
      renderList(ddSearch.value);
    });

    modal.querySelector('#pd-dd-clr').addEventListener('click', (e) => {
      e.stopPropagation();
      selectedStations.clear();
      renderList(ddSearch.value);
    });

    modal.querySelector('#pd-dd-ok').addEventListener('click', (e) => {
      e.stopPropagation();
      ddPopup.classList.remove('open');
      updateTriggerText();
    });

    modal.addEventListener('click', (e) => {
      if (!modal.querySelector('#pd-dd').contains(e.target)) {
        ddPopup.classList.remove('open');
        updateTriggerText();
      }
    });

    // ─── OTHER INPUT ───────────────────────────────────────────────────────
    otherToggle.addEventListener('click', () => {
      showOtherInput = !showOtherInput;
      otherInput.style.display = showOtherInput ? 'block' : 'none';
      otherToggle.classList.toggle('active', showOtherInput);
    });

    // ─── DEA FILE DROP/BROWSE ──────────────────────────────────────────────
    const dropzone = modal.querySelector('#pd-dropzone');
    const fileInput = modal.querySelector('#pd-file-input');
    const dropStatus = modal.querySelector('#pd-drop-status');

    function handleDeaFile(file) {
      if (!file || !file.name.endsWith('.csv')) {
        dropStatus.textContent = 'Por favor selecciona un archivo .csv';
        dropStatus.style.color = C.red;
        return;
      }
      dropStatus.textContent = 'Procesando...';
      dropStatus.style.color = C.textMuted;

      const reader = new FileReader();
      reader.onload = function(e) {
        const parsed = parseDeaCSV(e.target.result);
        if (!parsed) {
          dropStatus.textContent = 'Error: no se encontro la columna tracking_id en el CSV.';
          dropStatus.style.color = C.red;
          return;
        }
        deaData = parsed;
        dropzone.classList.add('loaded');
        dropzone.querySelector('.pd-dropzone-icon').textContent = '\u2705';
        dropzone.querySelector('.pd-dropzone-text').textContent = `DEA cargado: ${parsed.uniqueIds} tracking IDs unicos (${parsed.totalRows} filas)`;
        dropzone.querySelector('.pd-dropzone-hint').textContent = 'Click para cambiar archivo';
        dropStatus.textContent = `${file.name} (${(file.size/1024).toFixed(1)} KB) cargado correctamente.`;
        dropStatus.style.color = '#2e7d32';
      };
      reader.readAsText(file);
    }

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      handleDeaFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', (e) => handleDeaFile(e.target.files[0]));

    // ─── FETCH/CROSS BUTTON ────────────────────────────────────────────────
    modal.querySelector('#pd-fetch-btn').addEventListener('click', async () => {
      const dateFrom = modal.querySelector('#pd-date-from').value;
      const dateTo = modal.querySelector('#pd-date-to').value;
      const btn = modal.querySelector('#pd-fetch-btn');

      const otherVals = otherInput.value.trim().toUpperCase()
        .split(',').map(s => s.trim()).filter(s => s.length > 0);
      const allStations = [...new Set([...selectedStations, ...otherVals])];

      if (!deaData) { statusEl.textContent = 'Primero sube el archivo DEA.'; statusEl.style.color = C.red; return; }
      if (allStations.length === 0) { statusEl.textContent = 'Selecciona al menos una estacion.'; statusEl.style.color = C.red; return; }
      if (!dateFrom || !dateTo) { statusEl.textContent = 'Rellena las fechas.'; statusEl.style.color = C.red; return; }
      if (dateTo < dateFrom) { statusEl.textContent = 'Fecha hasta debe ser >= fecha desde.'; statusEl.style.color = C.red; return; }

      const dates = getDateRange(dateFrom, dateTo);
      if (dates.length > 14) { statusEl.textContent = 'Maximo 14 dias por ejecucion.'; statusEl.style.color = C.red; return; }

      btn.disabled = true;
      statusEl.style.color = C.textMuted;
      const data = await fetchAndCrossAll(allStations, dates, statusEl);
      btn.disabled = false;

      if (data && data.length > 0) {
        closeModal();
        createResultsOverlay(data);
      }
    });

    // ─── VIEW RESULTS BUTTON ───────────────────────────────────────────────
    modal.querySelector('#pd-view-btn').addEventListener('click', () => {
      const data = getStoredResults();
      if (data.length === 0) {
        statusEl.textContent = 'No hay resultados. Ejecuta el cruce primero.';
        statusEl.style.color = C.red;
        return;
      }
      closeModal();
      createResultsOverlay(data);
    });

    renderList();
    updateTriggerText();
  }

  // ─── NAV BUTTON INJECTION ─────────────────────────────────────────────────
  function injectNavButton() {
    const actionsDiv = document.querySelector('nav.css-1pnuvvh [mdn-masthead-actions]');
    if (!actionsDiv) return false;
    if (document.getElementById('pd-nav-btn')) return true;

    const btn = document.createElement('button');
    btn.id = 'pd-nav-btn';
    btn.type = 'button';
    btn.className = 'css-1dpkyuf';
    btn.innerHTML = '<span>Hub DEA Bridge</span>';
    btn.addEventListener('click', showModal);

    actionsDiv.insertBefore(btn, actionsDiv.firstChild);
    return true;
  }

  // ─── INIT ──────────────────────────────────────────────────────────────────
  function waitForNav() {
    if (injectNavButton()) return;
    const observer = new MutationObserver(() => {
      if (injectNavButton()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForNav);
  } else {
    waitForNav();
  }

})();
