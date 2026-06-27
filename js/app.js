(function () {
  "use strict";

  const GEOCODE_DELAY_MS = 1100;
  const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";

  const state = {
    mode: "pickup",
    stops: [],
    nextId: 1,
    map: null,
    layer: null,
    lastRoute: null
  };

  const elements = {};

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function distanceKm(a, b) {
    const radiusKm = 6371;
    const toRad = (degree) => degree * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const x = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * radiusKm * Math.asin(Math.sqrt(x));
  }

  function routeDistance(facility, ordered, returnToStart) {
    let total = 0;
    let current = facility;
    ordered.forEach((point) => {
      total += distanceKm(current, point);
      current = point;
    });
    if (returnToStart && ordered.length > 0) {
      total += distanceKm(current, facility);
    }
    return total;
  }

  function optimizeRoute(facility, points, returnToStart) {
    const remaining = points.slice();
    const ordered = [];
    let current = facility;

    while (remaining.length > 0) {
      let bestIndex = 0;
      let bestDistance = Infinity;
      remaining.forEach((point, index) => {
        const candidateDistance = distanceKm(current, point);
        if (candidateDistance < bestDistance) {
          bestDistance = candidateDistance;
          bestIndex = index;
        }
      });
      current = remaining[bestIndex];
      ordered.push(current);
      remaining.splice(bestIndex, 1);
    }

    const path = [facility, ...ordered, ...(returnToStart ? [facility] : [])];
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 1; i < path.length - 2; i += 1) {
        for (let k = i + 1; k < path.length - 1; k += 1) {
          const before = distanceKm(path[i - 1], path[i]) + distanceKm(path[k], path[k + 1]);
          const after = distanceKm(path[i - 1], path[k]) + distanceKm(path[i], path[k + 1]);
          if (before > after + 1e-9) {
            reverseSegment(path, i, k);
            improved = true;
          }
        }
      }
    }

    return path.slice(1, returnToStart ? path.length - 1 : path.length);
  }

  function reverseSegment(path, start, end) {
    let left = start;
    let right = end;
    while (left < right) {
      const tmp = path[left];
      path[left] = path[right];
      path[right] = tmp;
      left += 1;
      right -= 1;
    }
  }

  async function geocodeAddress(address) {
    const url = new URL(NOMINATIM_ENDPOINT);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", "jp");
    url.searchParams.set("accept-language", "ja");
    url.searchParams.set("q", address);

    const response = await window.fetch(url.toString(), {
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) {
      throw new Error("geocode_network_error");
    }
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }
    return {
      lat: Number.parseFloat(data[0].lat),
      lng: Number.parseFloat(data[0].lon)
    };
  }

  function buildGoogleMapsUrl(facility, ordered, returnToStart) {
    const coord = (point) => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
    const origin = coord(facility);
    const destination = returnToStart ? coord(facility) : coord(ordered[ordered.length - 1]);
    const waypoints = returnToStart ? ordered : ordered.slice(0, -1);
    const params = new URLSearchParams({
      api: "1",
      origin,
      destination,
      travelmode: "driving"
    });
    if (waypoints.length > 0) {
      params.set("waypoints", waypoints.map(coord).join("|"));
    }
    return `https://www.google.com/maps/dir/?${params.toString()}`;
  }

  function init() {
    cacheElements();
    if (!hasRequiredElements()) {
      return;
    }
    bindEvents();
    addStop();
    addStop();
    addStop();
  }

  function cacheElements() {
    elements.facilityAddress = document.getElementById("facility-address");
    elements.returnToStart = document.getElementById("return-to-start");
    elements.stops = document.getElementById("stops");
    elements.addStop = document.getElementById("add-stop");
    elements.calculateRoute = document.getElementById("calculate-route");
    elements.progress = document.getElementById("progress");
    elements.progressText = document.getElementById("progress-text");
    elements.formMessage = document.getElementById("form-message");
    elements.modePickup = document.getElementById("mode-pickup");
    elements.modeDropoff = document.getElementById("mode-dropoff");
    elements.stopsKicker = document.getElementById("stops-kicker");
    elements.placeholder = document.getElementById("placeholder");
    elements.result = document.getElementById("result");
    elements.resultTitle = document.getElementById("result-title");
    elements.summaryStopCount = document.getElementById("summary-stop-count");
    elements.summaryDistance = document.getElementById("summary-distance");
    elements.routeList = document.getElementById("route-list");
    elements.failedAddresses = document.getElementById("failed-addresses");
    elements.googleMapLink = document.getElementById("google-map-link");
    elements.printRoute = document.getElementById("print-route");
    elements.printTitle = document.getElementById("print-title");
    elements.printBody = document.getElementById("print-body");
    elements.printNote = document.getElementById("print-note");
  }

  function hasRequiredElements() {
    return Object.values(elements).every(Boolean);
  }

  function bindEvents() {
    elements.addStop.addEventListener("click", () => addStop());
    elements.calculateRoute.addEventListener("click", calculateRoute);
    elements.printRoute.addEventListener("click", () => window.print());
    elements.modePickup.addEventListener("click", () => setMode("pickup"));
    elements.modeDropoff.addEventListener("click", () => setMode("dropoff"));
  }

  function setMode(mode) {
    state.mode = mode;
    elements.modePickup.classList.toggle("is-active", mode === "pickup");
    elements.modeDropoff.classList.toggle("is-active", mode === "dropoff");
    elements.modePickup.setAttribute("aria-pressed", String(mode === "pickup"));
    elements.modeDropoff.setAttribute("aria-pressed", String(mode === "dropoff"));
    elements.stopsKicker.textContent = mode === "pickup" ? "お迎えする利用者" : "お送りする利用者";
    if (state.lastRoute) {
      renderPrintSheet(state.lastRoute.facilityAddress, state.lastRoute.ordered, state.lastRoute.returnToStart);
      elements.resultTitle.textContent = `${mode === "pickup" ? "お迎え" : "お送り"}の最適ルート`;
    }
  }

  function addStop(name = "", address = "") {
    state.stops.push({
      id: state.nextId,
      name,
      address,
      lat: null,
      lng: null
    });
    state.nextId += 1;
    renderStops();
  }

  function removeStop(id) {
    state.stops = state.stops.filter((stop) => stop.id !== id);
    if (state.stops.length === 0) {
      addStop();
      return;
    }
    renderStops();
  }

  function renderStops() {
    elements.stops.innerHTML = "";
    state.stops.forEach((stop, index) => {
      const row = document.createElement("div");
      row.className = "stop-row";
      row.dataset.id = String(stop.id);
      row.innerHTML = `
        <div class="stop-number">${index + 1}</div>
        <input class="stop-name" type="text" value="${escapeHtml(stop.name)}" placeholder="お名前" aria-label="${index + 1}番目の名前">
        <input class="stop-address" type="text" value="${escapeHtml(stop.address)}" placeholder="住所（市町村から）" aria-label="${index + 1}番目の住所">
        <button class="delete-stop" type="button" aria-label="${index + 1}番目の立ち寄り先を削除">×</button>
        <div class="stop-error" hidden>住所が見つかりません。番地や市町村名を確認してください。</div>
      `;

      row.querySelector(".stop-name").addEventListener("input", (event) => {
        stop.name = event.target.value;
      });
      row.querySelector(".stop-address").addEventListener("input", (event) => {
        stop.address = event.target.value;
        clearRowError(row);
      });
      row.querySelector(".delete-stop").addEventListener("click", () => removeStop(stop.id));
      elements.stops.appendChild(row);
    });
  }

  async function calculateRoute() {
    const facilityAddress = elements.facilityAddress.value.trim();
    const activeStops = state.stops
      .map((stop) => ({ ...stop, name: stop.name.trim(), address: stop.address.trim() }))
      .filter((stop) => stop.address.length > 0);

    hideFormMessage();
    clearAddressErrors();

    if (!facilityAddress) {
      showFormMessage("事業所の住所を入力してください。");
      elements.facilityAddress.focus();
      return;
    }

    if (activeStops.length === 0) {
      showFormMessage("立ち寄り先の住所を1件以上入力してください。");
      return;
    }

    setBusy(true);
    try {
      setProgressText("事業所の場所を調べています...");
      const facility = await geocodeAddress(facilityAddress);
      if (!facility) {
        showFormMessage("事業所の住所が見つかりませんでした。市町村名や番地を確認してください。");
        elements.facilityAddress.focus();
        return;
      }

      const foundStops = [];
      const failedStops = [];
      for (let index = 0; index < activeStops.length; index += 1) {
        const stop = activeStops[index];
        setProgressText(`住所を調べています... ${index + 1} / ${activeStops.length}件`);
        let location = null;
        try {
          location = await geocodeAddress(stop.address);
        } catch (error) {
          location = null;
        }

        if (location) {
          foundStops.push({ ...stop, lat: location.lat, lng: location.lng });
        } else {
          failedStops.push(stop);
          markAddressError(stop.id);
        }

        if (index < activeStops.length - 1) {
          await sleep(GEOCODE_DELAY_MS);
        }
      }

      if (foundStops.length === 0) {
        showFormMessage("立ち寄り先の住所が1件も見つかりませんでした。赤色の行を修正してください。");
        return;
      }

      const returnToStart = elements.returnToStart.checked;
      const ordered = optimizeRoute(facility, foundStops, returnToStart);
      renderResult(facility, facilityAddress, ordered, returnToStart, failedStops);
    } catch (error) {
      showFormMessage("ルートを計算できませんでした。通信環境を確認して、もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  function setBusy(isBusy) {
    elements.calculateRoute.disabled = isBusy;
    elements.progress.classList.toggle("is-visible", isBusy);
  }

  function setProgressText(text) {
    elements.progressText.textContent = text;
  }

  function showFormMessage(message) {
    elements.formMessage.textContent = message;
    elements.formMessage.classList.add("is-visible");
  }

  function hideFormMessage() {
    elements.formMessage.textContent = "";
    elements.formMessage.classList.remove("is-visible");
  }

  function clearAddressErrors() {
    document.querySelectorAll(".stop-row").forEach(clearRowError);
  }

  function clearRowError(row) {
    row.classList.remove("is-error");
    const error = row.querySelector(".stop-error");
    if (error) {
      error.hidden = true;
    }
  }

  function markAddressError(id) {
    const row = document.querySelector(`.stop-row[data-id="${id}"]`);
    if (!row) {
      return;
    }
    row.classList.add("is-error");
    const error = row.querySelector(".stop-error");
    if (error) {
      error.hidden = false;
    }
  }

  function renderResult(facility, facilityAddress, ordered, returnToStart, failedStops) {
    state.lastRoute = { facility, facilityAddress, ordered, returnToStart };
    elements.placeholder.hidden = true;
    elements.result.hidden = false;
    elements.resultTitle.textContent = `${state.mode === "pickup" ? "お迎え" : "お送り"}の最適ルート`;
    elements.summaryStopCount.textContent = String(ordered.length);
    elements.summaryDistance.textContent = `${routeDistance(facility, ordered, returnToStart).toFixed(1)} km`;

    renderRouteList(facilityAddress, ordered, returnToStart);
    renderFailedAddresses(failedStops);
    renderGoogleMapLink(facility, ordered, returnToStart);
    renderMap(facility, ordered, returnToStart);
    renderPrintSheet(facilityAddress, ordered, returnToStart);
    elements.result.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderRouteList(facilityAddress, ordered, returnToStart) {
    elements.routeList.innerHTML = "";
    elements.routeList.appendChild(createRouteItem("発", "事業所", facilityAddress, true));
    ordered.forEach((stop, index) => {
      elements.routeList.appendChild(createRouteItem(String(index + 1), stop.name || "名前なし", stop.address, false));
    });
    if (returnToStart) {
      elements.routeList.appendChild(createRouteItem("着", "事業所", facilityAddress, true));
    }
  }

  function createRouteItem(order, name, address, isFacility) {
    const item = document.createElement("li");
    item.innerHTML = `
      <span class="route-badge${isFacility ? " is-facility" : ""}">${escapeHtml(order)}</span>
      <span>
        <span class="route-name">${escapeHtml(name)}</span>
        <span class="route-address">${escapeHtml(address)}</span>
      </span>
    `;
    return item;
  }

  function renderFailedAddresses(failedStops) {
    if (failedStops.length === 0) {
      elements.failedAddresses.textContent = "";
      elements.failedAddresses.classList.remove("is-visible");
      return;
    }

    elements.failedAddresses.innerHTML = `<strong>${failedStops.length}件の住所が見つかりませんでした。</strong> 赤色の行を修正して、もう一度計算してください。<br>${failedStops
      .map((stop) => `・${escapeHtml(stop.name || "名前なし")}：${escapeHtml(stop.address)}`)
      .join("<br>")}`;
    elements.failedAddresses.classList.add("is-visible");
  }

  function renderGoogleMapLink(facility, ordered, returnToStart) {
    const url = buildGoogleMapsUrl(facility, ordered, returnToStart);
    elements.googleMapLink.href = url;
    const waypointCount = returnToStart ? ordered.length : Math.max(ordered.length - 1, 0);
    if (waypointCount > 9) {
      elements.googleMapLink.title = "立ち寄り先が多いため、Googleマップ側で一部が表示されない場合があります。";
    } else {
      elements.googleMapLink.removeAttribute("title");
    }
  }

  function renderMap(facility, ordered, returnToStart) {
    if (!window.L) {
      showFormMessage("地図ライブラリを読み込めませんでした。ネットワーク環境を確認してください。");
      return;
    }

    if (!state.map) {
      state.map = window.L.map("map", { scrollWheelZoom: false });
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap contributors"
      }).addTo(state.map);
    }

    if (state.layer) {
      state.map.removeLayer(state.layer);
    }
    state.layer = window.L.layerGroup().addTo(state.map);

    const points = [];
    const facilityIcon = createMarkerIcon("発", true);
    window.L.marker([facility.lat, facility.lng], { icon: facilityIcon })
      .addTo(state.layer)
      .bindPopup("事業所");
    points.push([facility.lat, facility.lng]);

    ordered.forEach((stop, index) => {
      window.L.marker([stop.lat, stop.lng], { icon: createMarkerIcon(String(index + 1), false) })
        .addTo(state.layer)
        .bindPopup(`${escapeHtml(stop.name || "名前なし")}<br>${escapeHtml(stop.address)}`);
      points.push([stop.lat, stop.lng]);
    });

    if (returnToStart) {
      points.push([facility.lat, facility.lng]);
    }

    window.L.polyline(points, {
      color: "#d86f2a",
      weight: 4,
      opacity: 0.86,
      dashArray: "2 8",
      lineCap: "round"
    }).addTo(state.layer);

    state.map.fitBounds(window.L.latLngBounds(points).pad(0.18));
    window.setTimeout(() => state.map.invalidateSize(), 120);
  }

  function createMarkerIcon(label, isFacility) {
    return window.L.divIcon({
      className: "",
      html: `<div class="route-marker${isFacility ? " is-facility" : ""}"><span>${escapeHtml(label)}</span></div>`,
      iconSize: [31, 31],
      iconAnchor: [15, 15]
    });
  }

  function renderPrintSheet(facilityAddress, ordered, returnToStart) {
    elements.printTitle.textContent = `送迎ルート表（${state.mode === "pickup" ? "お迎え" : "お送り"}）`;
    elements.printBody.innerHTML = "";
    elements.printBody.appendChild(createPrintRow("-", "発", "事業所（出発）", facilityAddress));
    ordered.forEach((stop, index) => {
      elements.printBody.appendChild(createPrintRow("□", String(index + 1), stop.name || "名前なし", stop.address));
    });
    if (returnToStart) {
      elements.printBody.appendChild(createPrintRow("-", "着", "事業所（帰着）", facilityAddress));
    }
    elements.printNote.textContent = "順番は直線距離をもとにした目安です。道路状況や安全確認を優先して運転してください。";
  }

  function createPrintRow(check, order, name, address) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="print-check">${escapeHtml(check)}</td>
      <td class="print-order">${escapeHtml(order)}</td>
      <td>${escapeHtml(name)}</td>
      <td>${escapeHtml(address)}</td>
    `;
    return row;
  }

  window.RouteMakerUtils = {
    distanceKm,
    routeDistance,
    optimizeRoute,
    buildGoogleMapsUrl
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
