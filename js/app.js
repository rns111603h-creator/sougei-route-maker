(function () {
  "use strict";

  const GEOCODE_DELAY_MS = 1100;
  const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
  const OSRM_ROUTE_ENDPOINT = "https://router.project-osrm.org/route/v1/driving";
  const OSRM_TABLE_ENDPOINT = "https://router.project-osrm.org/table/v1/driving";
  const SAVED_FACILITY_KEY = "sougeiRouteMaker.savedFacilityLocation";

  const state = {
    mode: "pickup",
    stops: [],
    nextId: 1,
    map: null,
    layer: null,
    lastRoute: null,
    savedFacilityLocation: null,
    useSavedFacilityLocation: false
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

  function formatDistanceMeters(meters) {
    if (!Number.isFinite(meters)) {
      return "--";
    }
    if (meters < 1000) {
      return `${Math.round(meters)} m`;
    }
    return `${(meters / 1000).toFixed(1)} km`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) {
      return "--";
    }
    const roundedMinutes = Math.max(0, Math.round(seconds / 60));
    const hours = Math.floor(roundedMinutes / 60);
    const minutes = roundedMinutes % 60;
    if (hours > 0) {
      return `${hours}時間${String(minutes).padStart(2, "0")}分`;
    }
    return `${minutes}分`;
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

  function optimizeRouteByDurationMatrix(durationMatrix, points, returnToStart) {
    const remaining = points.map((point, index) => ({ point, matrixIndex: index + 1 }));
    const ordered = [];
    let currentIndex = 0;

    while (remaining.length > 0) {
      let bestIndex = 0;
      let bestDuration = Infinity;
      remaining.forEach((candidate, index) => {
        const duration = getMatrixDuration(durationMatrix, currentIndex, candidate.matrixIndex);
        if (duration < bestDuration) {
          bestDuration = duration;
          bestIndex = index;
        }
      });
      const next = remaining.splice(bestIndex, 1)[0];
      ordered.push(next);
      currentIndex = next.matrixIndex;
    }

    const path = [0, ...ordered.map((item) => item.matrixIndex), ...(returnToStart ? [0] : [])];
    let improved = true;
    while (improved) {
      improved = false;
      let bestCandidatePath = null;
      let bestCandidateDuration = routeDurationByMatrixPath(durationMatrix, path);
      const lastReversibleIndex = returnToStart ? path.length - 2 : path.length - 1;
      for (let i = 1; i < lastReversibleIndex; i += 1) {
        for (let k = i + 1; k <= lastReversibleIndex; k += 1) {
          const candidatePath = path.slice();
          reverseSegment(candidatePath, i, k);
          const after = routeDurationByMatrixPath(durationMatrix, candidatePath);
          if (bestCandidateDuration > after + 1e-9) {
            bestCandidatePath = candidatePath;
            bestCandidateDuration = after;
          }
        }
      }
      if (bestCandidatePath) {
        path.splice(0, path.length, ...bestCandidatePath);
        improved = true;
      }
    }

    return path
      .filter((matrixIndex) => matrixIndex > 0)
      .map((matrixIndex) => points[matrixIndex - 1]);
  }

  function getMatrixDuration(durationMatrix, fromIndex, toIndex) {
    const duration = durationMatrix[fromIndex] && durationMatrix[fromIndex][toIndex];
    return Number.isFinite(duration) ? duration : Infinity;
  }

  function routeDurationByMatrixPath(durationMatrix, path) {
    let total = 0;
    for (let index = 0; index < path.length - 1; index += 1) {
      total += getMatrixDuration(durationMatrix, path[index], path[index + 1]);
    }
    return total;
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
    const candidates = buildGeocodeCandidates(address);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (index > 0) {
        await sleep(GEOCODE_DELAY_MS);
      }
      const location = await searchNominatimCandidate(candidate);
      if (location) {
        return location;
      }
    }
    return null;
  }

  async function searchNominatimCandidate(candidate) {
    const url = new URL(NOMINATIM_ENDPOINT);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "3");
    url.searchParams.set("countrycodes", "jp");
    url.searchParams.set("accept-language", "ja");
    url.searchParams.set("q", candidate.query);

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
    const hit = pickNominatimHit(data, candidate);
    if (!hit) {
      return null;
    }
    return {
      lat: Number.parseFloat(hit.lat),
      lng: Number.parseFloat(hit.lon),
      displayName: hit.display_name || "",
      geocodeQuery: candidate.query,
      isApproximate: candidate.isApproximate
    };
  }

  function buildGeocodeCandidates(address) {
    const normalized = normalizeAddress(address);
    const candidates = [];
    addGeocodeCandidate(candidates, String(address || "").trim(), false);
    addGeocodeCandidate(candidates, normalized, false);

    const parts = parseJapaneseAddress(normalized);
    const chomeQuery = buildChomeFallbackQuery(parts);
    if (chomeQuery) {
      addGeocodeCandidate(candidates, chomeQuery, true, parts);
    }

    return candidates;
  }

  function addGeocodeCandidate(candidates, query, isApproximate, parts) {
    if (!query || candidates.some((candidate) => candidate.query === query)) {
      return;
    }
    candidates.push({ query, isApproximate, parts: parts || parseJapaneseAddress(query) });
  }

  function normalizeAddress(address) {
    return String(address || "")
      .normalize("NFKC")
      .replace(/〒?\s*\d{3}[-\s]?\d{4}/g, "")
      .replace(/[‐‑‒–—―ー−－]/g, "-")
      .replace(/[　\s]+/g, "")
      .replace(/番地/g, "番")
      .replace(/号室/g, "号")
      .trim();
  }

  function parseJapaneseAddress(address) {
    const normalized = normalizeAddress(address);
    const stateMatch = normalized.match(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/);
    const state = stateMatch ? stateMatch[1] : "";
    const restAfterState = state ? normalized.slice(state.length) : normalized;
    const cityMatch = restAfterState.match(/^(.+?[市区町村])/);
    const city = cityMatch ? cityMatch[1] : "";
    const rest = city ? restAfterState.slice(city.length) : restAfterState;
    const chomeMatch = rest.match(/^(.+?)(\d+)丁目/) || rest.match(/^(.+?)(\d+)-\d+/);
    return {
      state,
      city,
      town: chomeMatch ? chomeMatch[1] : "",
      chome: chomeMatch ? chomeMatch[2] : "",
      rest
    };
  }

  function buildChomeFallbackQuery(parts) {
    if (!parts || !parts.town || !parts.chome || (!parts.city && !parts.state)) {
      return "";
    }
    return `${parts.state}${parts.city}${parts.town}${parts.chome}丁目`;
  }

  function pickNominatimHit(results, candidate) {
    const matchingHit = results.find((result) => isPlausibleGeocodeHit(result, candidate.parts));
    if (matchingHit) {
      return matchingHit;
    }
    if (!hasAddressContext(candidate.parts)) {
      return results[0];
    }
    return null;
  }

  function hasAddressContext(parts) {
    return Boolean(parts && (parts.state || parts.city || parts.town));
  }

  function isPlausibleGeocodeHit(result, parts) {
    const displayName = result && result.display_name ? normalizeAddress(result.display_name) : "";
    if (!displayName) {
      return false;
    }
    if (parts.state && !displayName.includes(parts.state)) {
      return false;
    }
    if (parts.city && !displayName.includes(parts.city)) {
      return false;
    }
    if (parts.town && !displayName.includes(parts.town)) {
      return false;
    }
    return true;
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

  function buildOsrmRouteUrl(points) {
    const coordinates = points
      .map((point) => `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`)
      .join(";");
    const params = new URLSearchParams({
      overview: "full",
      geometries: "geojson",
      steps: "false",
      annotations: "duration,distance"
    });
    return `${OSRM_ROUTE_ENDPOINT}/${coordinates}?${params.toString()}`;
  }

  function buildOsrmTableUrl(points) {
    const coordinates = points
      .map((point) => `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`)
      .join(";");
    const params = new URLSearchParams({
      annotations: "duration"
    });
    return `${OSRM_TABLE_ENDPOINT}/${coordinates}?${params.toString()}`;
  }

  async function fetchDurationMatrix(points) {
    if (points.length < 2) {
      return null;
    }
    const response = await window.fetch(buildOsrmTableUrl(points), {
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) {
      throw new Error("osrm_table_network_error");
    }
    const data = await response.json();
    if (!Array.isArray(data.durations) || data.durations.length !== points.length) {
      throw new Error("osrm_table_invalid_response");
    }
    data.durations.forEach((row) => {
      if (!Array.isArray(row) || row.length !== points.length) {
        throw new Error("osrm_table_invalid_row");
      }
      row.forEach((duration) => {
        if (!Number.isFinite(duration)) {
          throw new Error("osrm_table_unreachable_point");
        }
      });
    });
    return data.durations;
  }

  async function fetchRoadRoute(points) {
    if (points.length < 2) {
      return null;
    }
    const response = await window.fetch(buildOsrmRouteUrl(points), {
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) {
      throw new Error("osrm_network_error");
    }
    const data = await response.json();
    if (!data.routes || !data.routes.length) {
      return null;
    }
    const route = data.routes[0];
    return {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      legs: route.legs.map((leg) => ({
        distanceMeters: leg.distance,
        durationSeconds: leg.duration
      })),
      geometry: route.geometry
    };
  }

  function buildArrivalSchedule(departureTime, legs, stopMinutes) {
    if (!departureTime || !legs.length) {
      return [];
    }
    const [hours, minutes] = departureTime.split(":").map((value) => Number.parseInt(value, 10));
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
      return [];
    }
    const stopSeconds = Math.max(0, Number(stopMinutes) || 0) * 60;
    let elapsedSeconds = 0;
    return legs.map((leg, index) => {
      elapsedSeconds += leg.durationSeconds;
      const arrivalTime = formatClockTime(hours, minutes, elapsedSeconds);
      const elapsedMinutes = Math.round(elapsedSeconds / 60);
      if (index < legs.length - 1) {
        elapsedSeconds += stopSeconds;
      }
      return {
        arrivalTime,
        elapsedMinutes,
        legDurationSeconds: leg.durationSeconds,
        legDistanceMeters: leg.distanceMeters
      };
    });
  }

  function formatClockTime(baseHours, baseMinutes, offsetSeconds) {
    const totalMinutes = baseHours * 60 + baseMinutes + Math.round(offsetSeconds / 60);
    const normalized = ((totalMinutes % 1440) + 1440) % 1440;
    const hours = Math.floor(normalized / 60);
    const minutes = normalized % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  function buildDurationEstimateRoute(facility, ordered, returnToStart, durationMatrix) {
    const pathIndexes = [0, ...ordered.map((stop) => stop.matrixIndex), ...(returnToStart ? [0] : [])];
    const legs = [];
    let totalDurationSeconds = 0;
    for (let index = 0; index < pathIndexes.length - 1; index += 1) {
      const durationSeconds = getMatrixDuration(durationMatrix, pathIndexes[index], pathIndexes[index + 1]);
      legs.push({
        durationSeconds,
        distanceMeters: null
      });
      totalDurationSeconds += durationSeconds;
    }
    return {
      distanceMeters: null,
      durationSeconds: totalDurationSeconds,
      legs,
      geometry: null,
      isDurationMatrixEstimate: true,
      straightLineDistanceKm: routeDistance(facility, ordered, returnToStart)
    };
  }

  function init() {
    cacheElements();
    if (!hasRequiredElements()) {
      return;
    }
    loadSavedFacilityLocation();
    bindEvents();
    addStop();
    addStop();
    addStop();
  }

  function cacheElements() {
    elements.facilityAddress = document.getElementById("facility-address");
    elements.returnToStart = document.getElementById("return-to-start");
    elements.saveCurrentLocation = document.getElementById("save-current-location");
    elements.useSavedLocation = document.getElementById("use-saved-location");
    elements.clearSavedLocation = document.getElementById("clear-saved-location");
    elements.locationStatus = document.getElementById("location-status");
    elements.departureTime = document.getElementById("departure-time");
    elements.stopMinutes = document.getElementById("stop-minutes");
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
    elements.summaryDuration = document.getElementById("summary-duration");
    elements.distanceNote = document.getElementById("distance-note");
    elements.routeList = document.getElementById("route-list");
    elements.schedule = document.getElementById("schedule");
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
    elements.saveCurrentLocation.addEventListener("click", saveCurrentLocationAsFacility);
    elements.useSavedLocation.addEventListener("click", useSavedFacilityLocation);
    elements.clearSavedLocation.addEventListener("click", clearSavedFacilityLocation);
  }

  function setMode(mode) {
    state.mode = mode;
    elements.modePickup.classList.toggle("is-active", mode === "pickup");
    elements.modeDropoff.classList.toggle("is-active", mode === "dropoff");
    elements.modePickup.setAttribute("aria-pressed", String(mode === "pickup"));
    elements.modeDropoff.setAttribute("aria-pressed", String(mode === "dropoff"));
    elements.stopsKicker.textContent = mode === "pickup" ? "お迎えする利用者" : "お送りする利用者";
    if (state.lastRoute) {
      renderPrintSheet(state.lastRoute.facilityAddress, state.lastRoute.ordered, state.lastRoute.returnToStart, state.lastRoute.schedule || []);
      elements.resultTitle.textContent = `${mode === "pickup" ? "お迎え" : "お送り"}の時間優先ルート`;
    }
  }

  function loadSavedFacilityLocation() {
    try {
      const raw = window.localStorage.getItem(SAVED_FACILITY_KEY);
      state.savedFacilityLocation = raw ? JSON.parse(raw) : null;
    } catch (error) {
      state.savedFacilityLocation = null;
    }
    updateLocationStatus();
  }

  function updateLocationStatus(message, type) {
    const saved = state.savedFacilityLocation;
    const baseMessage = saved
      ? `保存済みの事業所位置があります（${saved.lat.toFixed(5)}, ${saved.lng.toFixed(5)}）。`
      : "保存した事業所位置はありません。";
    elements.locationStatus.textContent = message || baseMessage;
    elements.locationStatus.classList.toggle("is-ready", Boolean(saved) && type !== "error");
    elements.locationStatus.classList.toggle("is-error", type === "error");
    elements.useSavedLocation.disabled = !saved;
    elements.clearSavedLocation.disabled = !saved;
  }

  function saveCurrentLocationAsFacility() {
    if (!window.navigator.geolocation) {
      updateLocationStatus("このブラウザでは現在地を取得できません。", "error");
      return;
    }
    elements.saveCurrentLocation.disabled = true;
    updateLocationStatus("現在地を取得しています...");
    window.navigator.geolocation.getCurrentPosition(
      (position) => {
        const saved = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          savedAt: new Date().toISOString()
        };
        state.savedFacilityLocation = saved;
        state.useSavedFacilityLocation = true;
        window.localStorage.setItem(SAVED_FACILITY_KEY, JSON.stringify(saved));
        elements.saveCurrentLocation.disabled = false;
        updateLocationStatus("現在地を事業所位置として保存しました。次回以降もこの端末で使えます。");
      },
      () => {
        elements.saveCurrentLocation.disabled = false;
        updateLocationStatus("現在地を取得できませんでした。ブラウザの位置情報許可を確認してください。", "error");
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }

  function useSavedFacilityLocation() {
    if (!state.savedFacilityLocation) {
      updateLocationStatus("保存した事業所位置がありません。", "error");
      return;
    }
    state.useSavedFacilityLocation = true;
    updateLocationStatus("住所欄が空の時、保存した事業所位置を出発・帰着地として使います。");
  }

  function clearSavedFacilityLocation() {
    state.savedFacilityLocation = null;
    state.useSavedFacilityLocation = false;
    window.localStorage.removeItem(SAVED_FACILITY_KEY);
    updateLocationStatus("保存した事業所位置を削除しました。");
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
        <div class="stop-error" hidden>住所が見つかりません。市町村名を入れる、施設名にする、または丁目までの住所に直してみてください。</div>
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
    const useSavedFacility = !facilityAddress && state.useSavedFacilityLocation && state.savedFacilityLocation;
    const facilityLabel = useSavedFacility ? "保存した事業所位置" : facilityAddress;
    const activeStops = state.stops
      .map((stop) => ({ ...stop, name: stop.name.trim(), address: stop.address.trim() }))
      .filter((stop) => stop.address.length > 0);

    hideFormMessage();
    clearAddressErrors();

    if (!facilityAddress && !useSavedFacility) {
      showFormMessage("事業所の住所を入力するか、保存した事業所位置を使ってください。");
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
      const facility = await resolveFacilityLocation(facilityAddress, useSavedFacility);
      if (!facility) {
        showFormMessage("事業所の住所が見つかりませんでした。市町村名を含める、施設名にする、または丁目までの住所に直してみてください。");
        elements.facilityAddress.focus();
        return;
      }
      if (!useSavedFacility && activeStops.length > 0) {
        await sleep(GEOCODE_DELAY_MS);
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
          foundStops.push({ ...stop, lat: location.lat, lng: location.lng, matrixIndex: foundStops.length + 1 });
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
      let durationMatrix = null;
      let ordered = null;
      let optimizationMode = "duration";
      try {
        setProgressText("道路時間を比較しています...");
        durationMatrix = await fetchDurationMatrix([facility, ...foundStops]);
        ordered = optimizeRouteByDurationMatrix(durationMatrix, foundStops, returnToStart);
      } catch (error) {
        optimizationMode = "straight-line";
        ordered = optimizeRoute(facility, foundStops, returnToStart);
      }
      setProgressText("道路ルートと走行時間を調べています...");
      const pathPoints = buildRoutePath(facility, ordered, returnToStart);
      let roadRoute = null;
      try {
        roadRoute = await fetchRoadRoute(pathPoints);
      } catch (error) {
        roadRoute = durationMatrix ? buildDurationEstimateRoute(facility, ordered, returnToStart, durationMatrix) : null;
      }
      renderResult(facility, facilityLabel, ordered, returnToStart, failedStops, roadRoute, optimizationMode);
    } catch (error) {
      showFormMessage("ルートを計算できませんでした。通信環境を確認して、もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  async function resolveFacilityLocation(facilityAddress, useSavedFacility) {
    if (useSavedFacility && state.savedFacilityLocation) {
      return {
        lat: state.savedFacilityLocation.lat,
        lng: state.savedFacilityLocation.lng
      };
    }
    if (!facilityAddress) {
      return null;
    }
    return geocodeAddress(facilityAddress);
  }

  function buildRoutePath(facility, ordered, returnToStart) {
    return [facility, ...ordered, ...(returnToStart ? [facility] : [])];
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

  function renderResult(facility, facilityAddress, ordered, returnToStart, failedStops, roadRoute, optimizationMode) {
    const departureTime = elements.departureTime.value;
    const stopMinutes = Number.parseInt(elements.stopMinutes.value, 10) || 0;
    const schedule = roadRoute ? buildArrivalSchedule(departureTime, roadRoute.legs, stopMinutes) : [];
    state.lastRoute = { facility, facilityAddress, ordered, returnToStart, roadRoute, schedule, optimizationMode };
    elements.placeholder.hidden = true;
    elements.result.hidden = false;
    elements.resultTitle.textContent = `${state.mode === "pickup" ? "お迎え" : "お送り"}の時間優先ルート`;
    elements.summaryStopCount.textContent = String(ordered.length);
    elements.summaryDistance.textContent = roadRoute && Number.isFinite(roadRoute.distanceMeters)
      ? formatDistanceMeters(roadRoute.distanceMeters)
      : `${routeDistance(facility, ordered, returnToStart).toFixed(1)} km`;
    elements.summaryDuration.textContent = roadRoute ? formatDuration(roadRoute.durationSeconds) : "--";
    renderDistanceNote(roadRoute, optimizationMode, [facility, ...ordered]);

    renderRouteList(facility, facilityAddress, ordered, returnToStart, roadRoute, schedule);
    renderSchedule(facilityAddress, ordered, returnToStart, roadRoute, schedule, departureTime, stopMinutes);
    renderFailedAddresses(failedStops);
    renderGoogleMapLink(facility, ordered, returnToStart);
    renderMap(facility, ordered, returnToStart, roadRoute);
    renderPrintSheet(facilityAddress, ordered, returnToStart, schedule);
    elements.result.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderDistanceNote(roadRoute, optimizationMode, points) {
    const approximationNote = points.some((point) => point.isApproximate)
      ? "一部の住所は番地まで見つからなかったため、丁目などの代表地点で表示しています。Googleマップや現場判断で位置を確認してください。"
      : "";
    if (optimizationMode === "straight-line") {
      elements.distanceNote.textContent = `${approximationNote} OSRMの道路時間を取得できなかったため、直線距離を使って順番を計算しています。実際の走行時間はGoogleマップや現場判断で確認してください。`.trim();
      return;
    }
    if (roadRoute && roadRoute.isDurationMatrixEstimate) {
      elements.distanceNote.textContent = `${approximationNote} 順番と走行時間はOSRMの道路時間をもとにした目安です。地図線と距離は直線ベースの表示です。渋滞、信号待ち、乗降介助時間は反映されません。`.trim();
      return;
    }
    elements.distanceNote.textContent = `${approximationNote} 順番・道路距離・走行時間はOSRMによる目安です。渋滞、信号待ち、乗降介助時間はGoogleマップや現場判断で確認してください。`.trim();
  }

  function renderRouteList(facility, facilityAddress, ordered, returnToStart, roadRoute, schedule) {
    elements.routeList.innerHTML = "";
    elements.routeList.appendChild(createRouteItem("発", "事業所", facilityAddress, true, facility.isApproximate ? "近似地点（住所の代表地点）" : "出発地"));
    ordered.forEach((stop, index) => {
      const leg = roadRoute && roadRoute.legs[index] ? roadRoute.legs[index] : null;
      const scheduleItem = schedule[index];
      elements.routeList.appendChild(createRouteItem(
        String(index + 1),
        stop.name || "名前なし",
        stop.address,
        false,
        appendApproximateMeta(buildLegMeta(leg, scheduleItem), stop)
      ));
    });
    if (returnToStart) {
      const leg = roadRoute && roadRoute.legs[ordered.length] ? roadRoute.legs[ordered.length] : null;
      const scheduleItem = schedule[ordered.length];
      elements.routeList.appendChild(createRouteItem("着", "事業所", facilityAddress, true, appendApproximateMeta(buildLegMeta(leg, scheduleItem), facility)));
    }
  }

  function buildLegMeta(leg, scheduleItem) {
    const parts = [];
    if (scheduleItem && scheduleItem.arrivalTime) {
      parts.push(`${scheduleItem.arrivalTime} 着`);
    }
    if (leg) {
      parts.push(`${formatDuration(leg.durationSeconds)} / ${formatDistanceMeters(leg.distanceMeters)}`);
    }
    return parts.join(" ・ ");
  }

  function appendApproximateMeta(meta, point) {
    const parts = [];
    if (meta) {
      parts.push(meta);
    }
    if (point.isApproximate) {
      parts.push("近似地点");
    }
    return parts.join(" ・ ");
  }

  function createRouteItem(order, name, address, isFacility, meta) {
    const item = document.createElement("li");
    item.innerHTML = `
      <span class="route-badge${isFacility ? " is-facility" : ""}">${escapeHtml(order)}</span>
      <span>
        <span class="route-name">${escapeHtml(name)}</span>
        <span class="route-address">${escapeHtml(address)}</span>
        ${meta ? `<span class="route-meta">${escapeHtml(meta)}</span>` : ""}
      </span>
    `;
    return item;
  }

  function renderSchedule(facilityAddress, ordered, returnToStart, roadRoute, schedule, departureTime, stopMinutes) {
    if (!roadRoute) {
      elements.schedule.classList.add("is-visible");
      elements.schedule.innerHTML = "<h3>到着予定</h3><p class=\"schedule-empty\">道路ルートの取得に失敗したため、到着予定時刻は表示できません。</p>";
      return;
    }
    const targets = ordered.map((stop, index) => ({
      order: String(index + 1),
      name: stop.name || "名前なし",
      address: stop.address
    }));
    if (returnToStart) {
      targets.push({ order: "着", name: "事業所", address: facilityAddress });
    }
    const rows = targets.map((target, index) => {
      const leg = roadRoute.legs[index];
      const scheduleItem = schedule[index];
      const arrival = scheduleItem ? scheduleItem.arrivalTime : "出発時刻未設定";
      return `
        <tr>
          <td>${escapeHtml(target.order)}</td>
          <td>${escapeHtml(target.name)}<br><span class="route-address">${escapeHtml(target.address)}</span></td>
          <td>${escapeHtml(arrival)}</td>
          <td>${escapeHtml(formatDuration(leg.durationSeconds))}</td>
          <td>${escapeHtml(formatDistanceMeters(leg.distanceMeters))}</td>
        </tr>
      `;
    }).join("");
    const stopNote = stopMinutes > 0 ? `停車時間は各区間の間に${stopMinutes}分を加算しています。` : "停車時間は加算していません。";
    const departureNote = departureTime ? `出発 ${departureTime}。${stopNote}` : "出発時刻を入力すると各ポイントの到着予定時刻を表示します。";
    elements.schedule.classList.add("is-visible");
    elements.schedule.innerHTML = `
      <h3>到着予定</h3>
      <div class="schedule-table-wrap">
        <table class="schedule-table">
          <thead><tr><th>順</th><th>到着先</th><th>予定時刻</th><th>区間時間</th><th>区間距離</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="mini-status">${escapeHtml(departureNote)}</p>
    `;
  }

  function renderFailedAddresses(failedStops) {
    if (failedStops.length === 0) {
      elements.failedAddresses.textContent = "";
      elements.failedAddresses.classList.remove("is-visible");
      return;
    }

    elements.failedAddresses.innerHTML = `<strong>${failedStops.length}件の住所が見つかりませんでした。</strong> 市町村名を含める、施設名にする、または丁目までの住所に直して、もう一度計算してください。<br>${failedStops
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

  function renderMap(facility, ordered, returnToStart, roadRoute) {
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

    const linePoints = roadRoute && roadRoute.geometry && Array.isArray(roadRoute.geometry.coordinates)
      ? roadRoute.geometry.coordinates.map((coord) => [coord[1], coord[0]])
      : points;

    window.L.polyline(linePoints, {
      color: "#1a73e8",
      weight: 4,
      opacity: 0.86,
      dashArray: roadRoute ? null : "2 8",
      lineCap: "round"
    }).addTo(state.layer);

    state.map.fitBounds(window.L.latLngBounds(linePoints.length ? linePoints : points).pad(0.18));
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

  function renderPrintSheet(facilityAddress, ordered, returnToStart, schedule) {
    elements.printTitle.textContent = `送迎ルート表（${state.mode === "pickup" ? "お迎え" : "お送り"}）`;
    elements.printBody.innerHTML = "";
    elements.printBody.appendChild(createPrintRow("-", "発", "事業所（出発）", facilityAddress, elements.departureTime.value || ""));
    ordered.forEach((stop, index) => {
      elements.printBody.appendChild(createPrintRow("□", String(index + 1), stop.name || "名前なし", stop.address, schedule[index] ? schedule[index].arrivalTime : ""));
    });
    if (returnToStart) {
      const returnSchedule = schedule[ordered.length];
      elements.printBody.appendChild(createPrintRow("-", "着", "事業所（帰着）", facilityAddress, returnSchedule ? returnSchedule.arrivalTime : ""));
    }
    elements.printNote.textContent = "順番と時刻は道路ルートをもとにした目安です。道路状況や安全確認を優先して運転してください。";
  }

  function createPrintRow(check, order, name, address, time) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="print-check">${escapeHtml(check)}</td>
      <td class="print-order">${escapeHtml(order)}</td>
      <td>${escapeHtml(name)}</td>
      <td>${escapeHtml(address)}</td>
      <td>${escapeHtml(time)}</td>
    `;
    return row;
  }

  window.RouteMakerUtils = {
    distanceKm,
    routeDistance,
    optimizeRoute,
    buildGoogleMapsUrl,
    buildOsrmRouteUrl,
    buildOsrmTableUrl,
    optimizeRouteByDurationMatrix,
    buildArrivalSchedule,
    formatDuration,
    formatDistanceMeters,
    normalizeAddress,
    buildGeocodeCandidates,
    isPlausibleGeocodeHit
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
