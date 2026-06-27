(() => {
  'use strict';

  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
  const REQUEST_INTERVAL_MS = 1050;
  const DEFAULT_CENTER = [35.681236, 139.767125];
  const state = { map: null, layer: null, route: null };
  const $ = (id) => document.getElementById(id);

  const elements = {
    form: $('route-form'), stopsBody: $('stops-body'), addStop: $('add-stop'), sample: $('sample-data'),
    status: $('status'), summary: $('summary'), resultList: $('result-list'), openGoogle: $('open-google'),
    printRoute: $('print-route'), printTitle: $('print-title'), printBody: $('print-body'), routeType: $('route-type'),
    officeAddress: $('office-address'), returnToOffice: $('return-to-office')
  };

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    initMap();
    addStopRow('', '');
    addStopRow('', '');
    elements.addStop.addEventListener('click', () => addStopRow('', ''));
    elements.sample.addEventListener('click', fillSampleData);
    elements.form.addEventListener('submit', calculateRoute);
    elements.openGoogle.addEventListener('click', openGoogleMaps);
    elements.printRoute.addEventListener('click', () => window.print());
  }

  function initMap() {
    state.map = L.map('map').setView(DEFAULT_CENTER, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(state.map);
    state.layer = L.layerGroup().addTo(state.map);
  }

  function addStopRow(name = '', address = '') {
    const tr = document.createElement('tr');
    tr.className = 'stop-row';
    tr.innerHTML = `<td><input type="text" class="stop-name" aria-label="利用者名" placeholder="例：山田様"></td><td><input type="text" class="stop-address" aria-label="立ち寄り先住所" placeholder="例：東京都..."><div class="row-error" aria-live="polite"></div></td><td><button type="button" class="secondary remove-stop">削除</button></td>`;
    tr.querySelector('.stop-name').value = name;
    tr.querySelector('.stop-address').value = address;
    tr.querySelector('.remove-stop').addEventListener('click', () => tr.remove());
    elements.stopsBody.appendChild(tr);
  }

  function fillSampleData() {
    elements.officeAddress.value = '東京都千代田区丸の内1丁目';
    elements.stopsBody.innerHTML = '';
    addStopRow('利用者A', '東京都中央区銀座4丁目');
    addStopRow('利用者B', '東京都港区芝公園4丁目2-8');
    addStopRow('利用者C', '東京都文京区後楽1丁目3-61');
    setStatus('サンプルを入力しました。必要に応じて住所を変更してください。');
  }

  async function calculateRoute(event) {
    event.preventDefault();
    resetErrors();
    elements.openGoogle.disabled = true;
    elements.printRoute.disabled = true;
    const officeAddress = elements.officeAddress.value.trim();
    const stops = getStops();
    if (!officeAddress || stops.length === 0) {
      setStatus('事業所住所と、1件以上の立ち寄り先住所を入力してください。', 'error');
      return;
    }
    try {
      setStatus('住所を順番に検索しています（無料サービス配慮のため約1秒間隔）。');
      const office = await geocodeWithDelay({ name: '事業所', address: officeAddress, type: 'office' }, 0);
      const geocodedStops = [];
      const failures = [];
      for (let i = 0; i < stops.length; i += 1) {
        const result = await geocodeWithDelay(stops[i], i + 1);
        if (result) geocodedStops.push(result); else failures.push(stops[i]);
      }
      if (!office || failures.length) {
        markFailures(failures, !office);
        setStatus('見つからない住所があります。赤く表示された行を修正してから再計算してください。', 'error');
        return;
      }
      const orderedStops = optimizeRoute(office, geocodedStops, elements.returnToOffice.checked);
      const points = [office, ...orderedStops];
      if (elements.returnToOffice.checked) points.push({ ...office, name: '事業所（帰着）' });
      state.route = { office, orderedStops, points, distance: totalDistance(points), routeType: elements.routeType.value };
      renderRoute(state.route);
      setStatus('ルートを計算しました。概算距離と順番を確認してください。', 'success');
    } catch (error) {
      console.error(error);
      setStatus('処理中にエラーが発生しました。通信状況を確認して再度お試しください。', 'error');
    }
  }

  function getStops() {
    return [...elements.stopsBody.querySelectorAll('.stop-row')].map((row, index) => ({
      row, index, name: row.querySelector('.stop-name').value.trim() || `立ち寄り先${index + 1}`,
      address: row.querySelector('.stop-address').value.trim(), type: 'stop'
    })).filter((stop) => stop.address);
  }

  async function geocodeWithDelay(place, order) {
    if (order > 0) await wait(REQUEST_INTERVAL_MS);
    const params = new URLSearchParams({ format: 'json', q: place.address, limit: '1', countrycodes: 'jp', addressdetails: '1' });
    const response = await fetch(`${NOMINATIM_URL}?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Nominatim error: ${response.status}`);
    const data = await response.json();
    if (!data.length) return null;
    return { ...place, lat: Number(data[0].lat), lng: Number(data[0].lon), displayName: data[0].display_name };
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function optimizeRoute(office, stops, returnToOffice) {
    const remaining = [...stops];
    const route = [];
    let current = office;
    while (remaining.length) {
      let bestIndex = 0;
      let bestDistance = Infinity;
      remaining.forEach((stop, index) => {
        const distance = haversine(current, stop);
        if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
      });
      current = remaining.splice(bestIndex, 1)[0];
      route.push(current);
    }
    return twoOpt(route, office, returnToOffice);
  }

  function twoOpt(route, office, returnToOffice) {
    if (route.length < 4) return route;
    let improved = true;
    let best = [...route];
    while (improved) {
      improved = false;
      for (let i = 0; i < best.length - 2; i += 1) {
        for (let k = i + 2; k < best.length; k += 1) {
          const candidate = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
          if (scoreRoute(office, candidate, returnToOffice) < scoreRoute(office, best, returnToOffice)) {
            best = candidate;
            improved = true;
          }
        }
      }
    }
    return best;
  }

  function haversine(a, b) {
    const rad = Math.PI / 180;
    const earthKm = 6371;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const lat1 = a.lat * rad;
    const lat2 = b.lat * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * earthKm * Math.asin(Math.sqrt(h));
  }

  const pathDistance = (points) => points.slice(1).reduce((sum, point, index) => sum + haversine(points[index], point), 0);
  const scoreRoute = (office, stops, returnToOffice) => pathDistance(returnToOffice ? [office, ...stops, office] : [office, ...stops]);
  const totalDistance = pathDistance;

  function renderRoute(route) {
    renderMap(route.points);
    elements.summary.textContent = `立ち寄り件数：${route.orderedStops.length}件 / 概算距離：${route.distance.toFixed(1)}km（直線ベースの目安）`;
    elements.resultList.innerHTML = route.points.map((point, index) => `<li><strong>${labelFor(index, route.points.length)} ${escapeHtml(point.name)}</strong><br>${escapeHtml(point.address)}</li>`).join('');
    elements.printTitle.textContent = `${route.routeType} ルート表`;
    elements.printBody.innerHTML = route.points.map((point, index) => `<tr><td>□</td><td>${labelFor(index, route.points.length)}</td><td>${escapeHtml(point.name)}</td><td>${escapeHtml(point.address)}</td></tr>`).join('');
    elements.openGoogle.disabled = false;
    elements.printRoute.disabled = false;
  }

  function renderMap(points) {
    state.layer.clearLayers();
    const latLngs = points.map((p) => [p.lat, p.lng]);
    points.forEach((point, index) => {
      L.marker([point.lat, point.lng], { icon: markerIcon(index, points.length) }).bindPopup(`<strong>${escapeHtml(labelFor(index, points.length))} ${escapeHtml(point.name)}</strong><br>${escapeHtml(point.address)}`).addTo(state.layer);
    });
    L.polyline(latLngs, { color: '#146c94', weight: 5, opacity: 0.8 }).addTo(state.layer);
    state.map.fitBounds(L.latLngBounds(latLngs).pad(0.18));
  }

  function markerIcon(index, total) {
    const isOffice = index === 0 || (index === total - 1 && elements.returnToOffice.checked);
    return L.divIcon({ className: '', html: `<span class="marker-label ${isOffice ? 'office' : ''}" style="width:34px;height:34px">${index === 0 ? '発' : (isOffice ? '着' : index)}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] });
  }

  function labelFor(index, total) {
    if (index === 0) return '発（事業所）';
    if (index === total - 1 && elements.returnToOffice.checked) return '着（事業所）';
    return `${index}`;
  }

  function openGoogleMaps() {
    if (!state.route) return;
    const points = state.route.points;
    const origin = encodeURIComponent(points[0].address);
    const destination = encodeURIComponent(points[points.length - 1].address);
    const waypoints = points.slice(1, -1).map((p) => p.address).join('|');
    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving${waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : ''}`;
    window.open(url, '_blank', 'noopener');
  }

  function resetErrors() {
    elements.officeAddress.classList.remove('address-error');
    elements.stopsBody.querySelectorAll('.stop-row').forEach((row) => { row.classList.remove('not-found'); row.querySelector('.row-error').textContent = ''; });
  }

  function markFailures(failures, officeFailed) {
    if (officeFailed) elements.officeAddress.classList.add('address-error');
    failures.forEach((failure) => { failure.row.classList.add('not-found'); failure.row.querySelector('.row-error').textContent = '住所が見つかりません。表記を確認してください。'; });
  }

  function setStatus(message, type = '') {
    elements.status.className = `status ${type}`.trim();
    elements.status.textContent = message;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }
})();
