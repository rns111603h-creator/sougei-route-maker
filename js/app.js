(function () {
  "use strict";

  const GEOCODE_DELAY_MS = 1100;
  const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
  const OSRM_ROUTE_ENDPOINT = "https://router.project-osrm.org/route/v1/driving";
  const OSRM_TABLE_ENDPOINT = "https://router.project-osrm.org/table/v1/driving";
  const SAVED_FACILITY_KEY = "sougeiRouteMaker.savedFacilityLocation";
  const SAVED_COURSES_KEY = "sougeiRouteMaker.savedCourses";
  const MAX_COURSES = 4;
  const INITIAL_STOP_ROWS = 1;
  const PREFECTURE_PATTERN = /(北海道|東京都|京都府|大阪府|(?:青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)県)/;

  const state = {
    mode: "pickup",
    activeCourseIndex: 0,
    courses: createInitialCourses(),
    map: null,
    layer: null,
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

  function createInitialCourses(count = MAX_COURSES) {
    return Array.from({ length: count }, (_, index) => createCourse(index + 1));
  }

  function createCourse(number) {
    const course = {
      id: `course-${number}`,
      name: `コース${number}`,
      contact: "",
      targetMonth: "",
      targetDate: "",
      stops: [],
      nextId: 1,
      lastRoute: null
    };
    for (let index = 0; index < INITIAL_STOP_ROWS; index += 1) {
      course.stops.push(createStop(course));
    }
    return course;
  }

  function createStop(course, name = "", place = "", address = "", restDays = []) {
    const stop = {
      id: `${course.id}-stop-${course.nextId}`,
      name,
      place,
      address,
      restDays: normalizeRestDays(restDays),
      restDates: convertRestDaysToDates(restDays, course),
      lat: null,
      lng: null
    };
    course.nextId += 1;
    return stop;
  }

  function getActiveCourse() {
    return state.courses[state.activeCourseIndex];
  }

  function getStopDisplayName(stop) {
    const place = String(stop.place || "").trim();
    const name = String(stop.name || "").trim();
    return place || name || "名前なし";
  }

  function getStopAddressLabel(stop) {
    return String(stop.address || stop.displayName || stop.place || "").trim();
  }

  function getRoutePrimaryName(stop) {
    return String(stop.name || "").trim() || getStopDisplayName(stop);
  }

  function getRouteDetailLines(stop) {
    const details = [];
    const place = String(stop.place || "").trim();
    const address = getStopAddressLabel(stop);
    if (place) {
      details.push(`場所：${place}`);
    }
    if (address) {
      details.push(`住所：${address}`);
    }
    return details;
  }

  function buildStopSearchQueries(stop) {
    const queries = [];
    const place = String(stop.place || "").trim();
    const address = String(stop.address || "").trim();
    if (place && address) {
      queries.push(`${place} ${address}`);
      queries.push(address);
      return queries;
    }
    [place, address].forEach((value) => {
      const query = String(value || "").trim();
      if (query && !queries.includes(query)) {
        queries.push(query);
      }
    });
    return queries;
  }

  function normalizeRestDays(value) {
    if (Array.isArray(value)) {
      return [...new Set(value
        .map((day) => Number.parseInt(day, 10))
        .filter((day) => Number.isInteger(day) && day >= 1 && day <= 31))]
        .sort((a, b) => a - b);
    }
    return parseRestDays(value);
  }

  function parseRestDays(value) {
    return [...new Set(String(value || "")
      .split(/[,\s、，]+/)
      .map((day) => Number.parseInt(day, 10))
      .filter((day) => Number.isInteger(day) && day >= 1 && day <= 31))]
      .sort((a, b) => a - b);
  }

  function normalizeRestDates(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return [...new Set(value
      .map((date) => String(date || "").trim())
      .filter(isValidDateKey))]
      .sort();
  }

  function isValidDateKey(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      return false;
    }
    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    const day = Number.parseInt(match[3], 10);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() + 1 === month && date.getDate() === day;
  }

  function convertRestDaysToDates(restDays, course) {
    const [year, month] = getCoursePrintYearMonth(course || {});
    return normalizeRestDays(restDays)
      .filter((day) => day <= new Date(year, month, 0).getDate())
      .map((day) => formatDateKey(year, month, day));
  }

  function getStopRestDates(stop, course) {
    const dates = normalizeRestDates(stop.restDates);
    if (dates.length > 0) {
      return dates;
    }
    return convertRestDaysToDates(stop.restDays, course);
  }

  function isStopRestOnDay(stop, day) {
    const targetDay = Number.parseInt(day, 10);
    return Number.isInteger(targetDay) && normalizeRestDays(stop.restDays).includes(targetDay);
  }

  function isStopRestOnDate(stop, dateKey, course) {
    return isValidDateKey(dateKey) && getStopRestDates(stop, course).includes(dateKey);
  }

  function getPrintPlaceName(stop) {
    return String(stop.place || "").trim();
  }

  function getTargetDay(course) {
    const date = String(course.targetDate || "").trim();
    if (date) {
      const day = Number.parseInt(date.slice(-2), 10);
      return Number.isInteger(day) ? day : null;
    }
    return null;
  }

  function getTargetDateKey(course) {
    const date = String(course.targetDate || "").trim();
    return isValidDateKey(date) ? date : "";
  }

  function sortStopsByRouteOrder(stops, orderedStops) {
    const orderedIds = new Set(orderedStops.map((stop) => stop.id));
    const byId = new Map(stops.map((stop) => [stop.id, stop]));
    return [
      ...orderedStops.map((stop) => byId.get(stop.id)).filter(Boolean),
      ...stops.filter((stop) => !orderedIds.has(stop.id))
    ];
  }

  function moveItemInList(list, fromIndex, toIndex) {
    if (!Array.isArray(list)
      || fromIndex === toIndex
      || fromIndex < 0
      || toIndex < 0
      || fromIndex >= list.length
      || toIndex >= list.length) {
      return list.slice();
    }
    const next = list.slice();
    const [item] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, item);
    return next;
  }

  function serializeCoursesForStorage(courses) {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      courses: courses.slice(0, MAX_COURSES).map((course, index) => ({
        name: String(course.name || `コース${index + 1}`).trim() || `コース${index + 1}`,
        contact: String(course.contact || "").trim(),
        targetMonth: String(course.targetMonth || "").trim(),
        targetDate: String(course.targetDate || "").trim(),
        stops: course.stops.map((stop) => ({
          name: String(stop.name || "").trim(),
          place: String(stop.place || "").trim(),
          address: String(stop.address || "").trim(),
          restDays: getStopRestDates(stop, course)
            .filter((dateKey) => {
              const date = parseDateKey(dateKey);
              const [year, month] = getCoursePrintYearMonth(course);
              return date.getFullYear() === year && date.getMonth() + 1 === month;
            })
            .map((dateKey) => parseDateKey(dateKey).getDate()),
          restDates: getStopRestDates(stop, course)
        }))
      }))
    };
  }

  function hydrateCoursesFromStorage(payload) {
    const courses = createInitialCourses();
    if (!payload || payload.version !== 1 || !Array.isArray(payload.courses)) {
      return courses;
    }

    payload.courses.slice(0, MAX_COURSES).forEach((storedCourse, index) => {
      const course = courses[index];
      course.name = String(storedCourse.name || `コース${index + 1}`).trim() || `コース${index + 1}`;
      course.contact = String(storedCourse.contact || "").trim();
      course.targetMonth = String(storedCourse.targetMonth || "").trim();
      course.targetDate = String(storedCourse.targetDate || "").trim();
      if (Array.isArray(storedCourse.stops)) {
        course.stops = [];
        course.nextId = 1;
        storedCourse.stops.forEach((storedStop) => {
          const stop = createStop(
            course,
            String(storedStop.name || "").trim(),
            String(storedStop.place || "").trim(),
            String(storedStop.address || "").trim(),
            normalizeRestDays(storedStop.restDays)
          );
          stop.restDates = normalizeRestDates(storedStop.restDates);
          if (stop.restDates.length === 0) {
            stop.restDates = convertRestDaysToDates(storedStop.restDays, course);
          }
          stop.restDays = normalizeRestDays(storedStop.restDays);
          course.stops.push(stop);
        });
        if (course.stops.length === 0) {
          course.stops.push(createStop(course));
        }
      }
      course.lastRoute = null;
    });

    return courses;
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

  async function geocodeStop(stop) {
    const queries = buildStopSearchQueries(stop);
    for (let index = 0; index < queries.length; index += 1) {
      if (index > 0) {
        await sleep(GEOCODE_DELAY_MS);
      }
      const location = await geocodeAddress(queries[index]);
      if (location) {
        return {
          ...location,
          geocodeSource: index === 0 && String(stop.place || "").trim() ? "place" : "address"
        };
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
    const stateMatch = normalized.match(PREFECTURE_PATTERN);
    const state = stateMatch ? stateMatch[1] : "";
    const restAfterState = state ? normalized.slice(stateMatch.index + state.length) : normalized;
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

  function buildArrivalSchedule(departureTime, legs, stopMinutes, manualArrivalTimes = {}, ordered = []) {
    if (!departureTime || !legs.length) {
      return [];
    }
    const departureMinutes = parseClockMinutes(departureTime);
    if (!Number.isFinite(departureMinutes)) {
      return [];
    }
    const stopSeconds = Math.max(0, Number(stopMinutes) || 0) * 60;
    let currentMinutes = departureMinutes;
    return legs.map((leg, index) => {
      const legMinutes = Math.round(leg.durationSeconds / 60);
      currentMinutes += legMinutes;
      const stopId = ordered[index] && ordered[index].id ? ordered[index].id : "";
      const manualMinutes = stopId ? parseClockMinutes(manualArrivalTimes[stopId]) : NaN;
      const isManual = Number.isFinite(manualMinutes);
      if (isManual) {
        currentMinutes = manualMinutes;
      }
      const arrivalTime = formatClockFromMinutes(currentMinutes);
      const elapsedMinutes = Math.round(minutesBetween(departureMinutes, currentMinutes));
      if (index < legs.length - 1) {
        currentMinutes += Math.round(stopSeconds / 60);
      }
      return {
        arrivalTime,
        isManual,
        stopId,
        elapsedMinutes,
        legDurationSeconds: leg.durationSeconds,
        legDistanceMeters: leg.distanceMeters
      };
    });
  }

  function parseClockMinutes(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      return NaN;
    }
    const hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return NaN;
    }
    return hours * 60 + minutes;
  }

  function formatClockFromMinutes(totalMinutes) {
    const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
    const hours = Math.floor(normalized / 60);
    const minutes = normalized % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  function minutesBetween(startMinutes, endMinutes) {
    let diff = endMinutes - startMinutes;
    while (diff < 0) {
      diff += 1440;
    }
    return diff;
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
    loadSavedCourses();
    loadSavedFacilityLocation();
    bindEvents();
    renderCourseTabs();
    renderCourseName();
    renderStops();
  }

  function cacheElements() {
    elements.courseTabs = document.getElementById("course-tabs");
    elements.courseName = document.getElementById("course-name");
    elements.courseContact = document.getElementById("course-contact");
    elements.courseMonth = document.getElementById("course-month");
    elements.courseTargetDate = document.getElementById("course-target-date");
    elements.saveCourses = document.getElementById("save-courses");
    elements.clearSavedCourses = document.getElementById("clear-saved-courses");
    elements.courseSaveStatus = document.getElementById("course-save-status");
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
    elements.calculationSummary = document.getElementById("calculation-summary");
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
    elements.printSheet = document.getElementById("print-sheet");
  }

  function hasRequiredElements() {
    return Object.values(elements).every(Boolean);
  }

  function bindEvents() {
    elements.addStop.addEventListener("click", () => addStop());
    elements.calculateRoute.addEventListener("click", calculateRoute);
    elements.printRoute.addEventListener("click", () => window.print());
    elements.courseName.addEventListener("input", updateActiveCourseName);
    elements.courseContact.addEventListener("input", updateActiveCourseContact);
    elements.courseMonth.addEventListener("input", updateActiveCourseMonth);
    elements.courseTargetDate.addEventListener("input", updateActiveCourseTargetDate);
    elements.saveCourses.addEventListener("click", saveCoursesToBrowser);
    elements.clearSavedCourses.addEventListener("click", clearSavedCourses);
    elements.modePickup.addEventListener("click", () => setMode("pickup"));
    elements.modeDropoff.addEventListener("click", () => setMode("dropoff"));
    elements.saveCurrentLocation.addEventListener("click", saveCurrentLocationAsFacility);
    elements.useSavedLocation.addEventListener("click", useSavedFacilityLocation);
    elements.clearSavedLocation.addEventListener("click", clearSavedFacilityLocation);
    elements.facilityAddress.addEventListener("input", () => {
      updateCalculationSummary();
      invalidateActiveRoute("事業所住所を変更しました。もう一度ルートを計算してください。");
    });
    elements.returnToStart.addEventListener("change", () => invalidateActiveRoute("周回ルートの設定を変更しました。もう一度ルートを計算してください。"));
    elements.departureTime.addEventListener("input", refreshActiveRouteSchedule);
    elements.stopMinutes.addEventListener("input", refreshActiveRouteSchedule);
  }

  function renderCourseTabs() {
    elements.courseTabs.innerHTML = "";
    state.courses.forEach((course, index) => {
      const button = document.createElement("button");
      const isActive = index === state.activeCourseIndex;
      button.type = "button";
      button.className = `course-tab${isActive ? " is-active" : ""}`;
      button.id = `${course.id}-tab`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(isActive));
      button.setAttribute("aria-controls", "stops");
      button.textContent = course.name || `コース${index + 1}`;
      button.addEventListener("click", () => switchCourse(index));
      elements.courseTabs.appendChild(button);
    });
  }

  function renderCourseName() {
    const course = getActiveCourse();
    elements.courseName.value = course.name;
    elements.courseContact.value = course.contact;
    elements.courseMonth.value = course.targetMonth || "";
    elements.courseTargetDate.value = course.targetDate || "";
  }

  function updateActiveCourseName(event) {
    const course = getActiveCourse();
    course.name = event.target.value.trim() || `コース${state.activeCourseIndex + 1}`;
    renderCourseTabs();
    refreshCourseResultLabels();
  }

  function updateActiveCourseContact(event) {
    getActiveCourse().contact = event.target.value.trim();
    refreshCourseResultLabels();
  }

  function updateActiveCourseMonth(event) {
    getActiveCourse().targetMonth = event.target.value.trim();
    renderStops();
    refreshCourseResultLabels();
  }

  function updateActiveCourseTargetDate(event) {
    getActiveCourse().targetDate = event.target.value.trim();
    renderStops();
    updateCalculationSummary();
    invalidateActiveRoute("ルート計算日を変更しました。もう一度ルートを計算してください。");
  }

  function loadSavedCourses() {
    try {
      const raw = window.localStorage.getItem(SAVED_COURSES_KEY);
      if (raw) {
        state.courses = hydrateCoursesFromStorage(JSON.parse(raw));
        updateCourseSaveStatus("保存済みのコース設定を読み込みました。");
        return;
      }
    } catch (error) {
      state.courses = createInitialCourses();
      updateCourseSaveStatus("保存済みコース設定を読み込めませんでした。", "error");
      return;
    }
    updateCourseSaveStatus();
  }

  function saveCoursesToBrowser() {
    try {
      window.localStorage.setItem(SAVED_COURSES_KEY, JSON.stringify(serializeCoursesForStorage(state.courses)));
      updateCourseSaveStatus("コース名・連絡先・立ち寄り先をこの端末に保存しました。");
    } catch (error) {
      updateCourseSaveStatus("コース設定を保存できませんでした。ブラウザの保存領域を確認してください。", "error");
    }
  }

  function clearSavedCourses() {
    window.localStorage.removeItem(SAVED_COURSES_KEY);
    updateCourseSaveStatus("保存済みのコース設定を削除しました。");
  }

  function updateCourseSaveStatus(message, type) {
    if (!elements.courseSaveStatus) {
      return;
    }
    elements.courseSaveStatus.textContent = message || "コース設定はまだ保存されていません。";
    elements.courseSaveStatus.classList.toggle("is-ready", Boolean(message) && type !== "error");
    elements.courseSaveStatus.classList.toggle("is-error", type === "error");
  }

  function switchCourse(index) {
    if (index === state.activeCourseIndex || elements.calculateRoute.disabled) {
      return;
    }
    state.activeCourseIndex = index;
    hideFormMessage();
    clearFailedAddresses();
    renderCourseTabs();
    renderCourseName();
    renderStops();
    updateCalculationSummary();
    renderStoredCourseResult();
  }

  function renderStoredCourseResult() {
    const course = getActiveCourse();
    if (!course.lastRoute) {
      elements.placeholder.hidden = false;
      elements.result.hidden = true;
      clearMapLayer();
      return;
    }
    renderRouteResult(course.lastRoute);
  }

  function refreshCourseResultLabels() {
    const course = getActiveCourse();
    if (!course.lastRoute) {
      return;
    }
    elements.resultTitle.textContent = buildResultTitle(course);
    renderPrintSheet(course.lastRoute.facilityAddress, course.lastRoute.ordered, course.lastRoute.returnToStart, course.lastRoute.schedule || []);
  }

  function invalidateActiveRoute(message) {
    const course = getActiveCourse();
    if (!course || !course.lastRoute) {
      return;
    }
    course.lastRoute = null;
    elements.placeholder.hidden = false;
    elements.result.hidden = true;
    clearMapLayer();
    clearFailedAddresses();
    if (message) {
      showFormMessage(message);
    }
  }

  function setMode(mode) {
    state.mode = mode;
    elements.modePickup.classList.toggle("is-active", mode === "pickup");
    elements.modeDropoff.classList.toggle("is-active", mode === "dropoff");
    elements.modePickup.setAttribute("aria-pressed", String(mode === "pickup"));
    elements.modeDropoff.setAttribute("aria-pressed", String(mode === "dropoff"));
    elements.stopsKicker.textContent = mode === "pickup" ? "お迎えする利用者" : "お送りする利用者";
    const course = getActiveCourse();
    if (course.lastRoute) {
      renderPrintSheet(course.lastRoute.facilityAddress, course.lastRoute.ordered, course.lastRoute.returnToStart, course.lastRoute.schedule || []);
      elements.resultTitle.textContent = buildResultTitle(course);
    }
  }

  function loadSavedFacilityLocation() {
    try {
      const raw = window.localStorage.getItem(SAVED_FACILITY_KEY);
      state.savedFacilityLocation = normalizeSavedFacilityLocation(raw ? JSON.parse(raw) : null);
    } catch (error) {
      state.savedFacilityLocation = null;
    }
    updateLocationStatus();
  }

  function normalizeSavedFacilityLocation(saved) {
    if (!saved || !Number.isFinite(saved.lat) || !Number.isFinite(saved.lng)) {
      return null;
    }
    return {
      lat: saved.lat,
      lng: saved.lng,
      savedAt: saved.savedAt || ""
    };
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
        updateCalculationSummary();
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
    updateCalculationSummary();
    updateLocationStatus("住所欄が空の時、保存した事業所位置を出発・帰着地として使います。");
  }

  function clearSavedFacilityLocation() {
    state.savedFacilityLocation = null;
    state.useSavedFacilityLocation = false;
    window.localStorage.removeItem(SAVED_FACILITY_KEY);
    updateCalculationSummary();
    updateLocationStatus("保存した事業所位置を削除しました。");
  }

  function addStop(name = "", place = "", address = "", restDays = []) {
    const course = getActiveCourse();
    course.stops.push(createStop(course, name, place, address, restDays));
    invalidateActiveRoute("利用者を追加しました。もう一度ルートを計算してください。");
    renderStops();
    updateCalculationSummary();
  }

  function removeStop(id) {
    const course = getActiveCourse();
    course.stops = course.stops.filter((stop) => stop.id !== id);
    invalidateActiveRoute("利用者を削除しました。もう一度ルートを計算してください。");
    if (course.stops.length === 0) {
      addStop();
      return;
    }
    renderStops();
    updateCalculationSummary();
  }

  function renderStops() {
    elements.stops.innerHTML = "";
    const course = getActiveCourse();
    course.stops.forEach((stop, index) => {
      const row = document.createElement("div");
      row.className = "stop-row";
      row.dataset.id = String(stop.id);
      row.innerHTML = `
        <div class="stop-number">${index + 1}</div>
        <input class="stop-name" type="text" value="${escapeHtml(stop.name)}" placeholder="お名前" aria-label="${index + 1}番目の名前">
        <input class="stop-place" type="text" value="${escapeHtml(stop.place)}" placeholder="場所名・施設名" aria-label="${index + 1}番目の場所名または施設名">
        <input class="stop-address" type="text" value="${escapeHtml(stop.address)}" placeholder="住所（市町村から）" aria-label="${index + 1}番目の住所">
        <button class="delete-stop" type="button" aria-label="${index + 1}番目の立ち寄り先を削除">×</button>
        <details class="rest-days">
          <summary>${escapeHtml(buildRestSummary(stop, course))}</summary>
          <div class="rest-day-grid" role="group" aria-label="${index + 1}番目の休み日">
            ${buildRestDayCheckboxes(stop, index, course)}
          </div>
        </details>
        <div class="stop-error" hidden>場所名・住所が見つかりません。施設名を変えるか、市町村名を含む住所を入力してください。</div>
      `;

      row.querySelector(".stop-name").addEventListener("input", (event) => {
        stop.name = event.target.value;
        invalidateActiveRoute("利用者名を変更しました。もう一度ルートを計算してください。");
      });
      row.querySelector(".stop-place").addEventListener("input", (event) => {
        stop.place = event.target.value;
        clearRowError(row);
        updateCalculationSummary();
        invalidateActiveRoute("場所名を変更しました。もう一度ルートを計算してください。");
      });
      row.querySelector(".stop-address").addEventListener("input", (event) => {
        stop.address = event.target.value;
        clearRowError(row);
        updateCalculationSummary();
        invalidateActiveRoute("住所を変更しました。もう一度ルートを計算してください。");
      });
      row.querySelectorAll(".rest-day-checkbox").forEach((checkbox) => {
        checkbox.addEventListener("change", () => {
          stop.restDates = normalizeRestDates(Array.from(row.querySelectorAll(".rest-day-checkbox:checked"))
            .map((input) => input.value));
          const [year, month] = getCoursePrintYearMonth(course);
          stop.restDays = getStopRestDates(stop, course)
            .map((dateKey) => parseDateKey(dateKey))
            .filter((date) => date.getFullYear() === year && date.getMonth() + 1 === month)
            .map((date) => date.getDate());
          const summary = row.querySelector(".rest-days summary");
          if (summary) {
            summary.textContent = buildRestSummary(stop, course);
          }
          updateCalculationSummary();
          invalidateActiveRoute("休み日を変更しました。もう一度ルートを計算してください。");
        });
      });
      row.querySelector(".delete-stop").addEventListener("click", () => removeStop(stop.id));
      elements.stops.appendChild(row);
    });
    updateCalculationSummary();
  }

  function updateCalculationSummary() {
    if (!elements.calculationSummary) {
      return;
    }
    const facilityReady = Boolean(elements.facilityAddress.value.trim()) || Boolean(state.useSavedFacilityLocation && state.savedFacilityLocation);
    const course = getActiveCourse();
    const targetDateKey = getTargetDateKey(course);
    const stopCount = course.stops.filter((stop) => buildStopSearchQueries(stop).length > 0 && !(targetDateKey && isStopRestOnDate(stop, targetDateKey, course))).length;
    if (facilityReady && stopCount > 0) {
      elements.calculationSummary.textContent = `事業所と送迎利用者${stopCount}件で計算します。`;
      elements.calculationSummary.classList.add("is-ready");
      return;
    }
    if (!facilityReady && stopCount === 0) {
      elements.calculationSummary.textContent = "事業所住所と送迎利用者を入力したら計算できます。";
    } else if (!facilityReady) {
      elements.calculationSummary.textContent = `送迎利用者${stopCount}件が入力されています。次に事業所住所を入れてください。`;
    } else {
      elements.calculationSummary.textContent = "事業所住所は入力済みです。次に送迎利用者の場所名または住所を入れてください。";
    }
    elements.calculationSummary.classList.remove("is-ready");
  }

  function buildRestSummary(stop, course) {
    const restDates = getStopRestDates(stop, course);
    if (restDates.length === 0) {
      return "休み日を選択（任意）";
    }
    return `休み：${restDates.map((dateKey) => formatRestDateLabel(dateKey, course)).join("、")}`;
  }

  function buildRestDayCheckboxes(stop, stopIndex, course) {
    const restDates = getStopRestDates(stop, course);
    return getCourseRestDateChoices(course).map((choice) => {
      const id = `${escapeHtml(stop.id)}-rest-${choice.dateKey}`;
      const checked = restDates.includes(choice.dateKey) ? " checked" : "";
      return `
        <label class="rest-day-pill" for="${id}">
          <input id="${id}" class="rest-day-checkbox" type="checkbox" value="${escapeHtml(choice.dateKey)}"${checked} aria-label="${stopIndex + 1}番目の利用者 ${escapeHtml(choice.label)}を休みにする">
          <span>${escapeHtml(choice.label)}</span>
        </label>
      `;
    }).join("");
  }

  async function calculateRoute() {
    const facilityAddress = elements.facilityAddress.value.trim();
    const useSavedFacility = !facilityAddress && state.useSavedFacilityLocation && state.savedFacilityLocation;
    const facilityLabel = useSavedFacility ? "保存した事業所位置" : facilityAddress;
    const course = getActiveCourse();
    const targetDateKey = getTargetDateKey(course);
    const activeStops = course.stops
      .map((stop) => ({
        ...stop,
        name: stop.name.trim(),
        place: stop.place.trim(),
        address: stop.address.trim(),
        restDays: normalizeRestDays(stop.restDays),
        restDates: getStopRestDates(stop, course)
      }))
      .filter((stop) => buildStopSearchQueries(stop).length > 0 && !(targetDateKey && isStopRestOnDate(stop, targetDateKey, course)));

    hideFormMessage();
    clearAddressErrors();

    if (!facilityAddress && !useSavedFacility) {
      showFormMessage("Step 2：事業所の住所を入力するか、保存した事業所位置を使ってください。");
      elements.facilityAddress.focus();
      return;
    }

    if (activeStops.length === 0) {
      showFormMessage(targetDateKey
        ? "Step 3：ルート計算日に送迎対象となる利用者の場所名または住所を1件以上入力してください。休み日にチェックが入っている利用者は計算から外れます。"
        : "Step 3：利用者の場所名または住所を1件以上入力してください。");
      return;
    }

    setBusy(true);
    try {
      setProgressText("事業所の場所を調べています...");
      const facility = await resolveFacilityLocation(facilityAddress, useSavedFacility);
      if (!facility) {
        showFormMessage("Step 2：事業所の住所が見つかりませんでした。市町村名を含める、施設名にする、または丁目までの住所に直してみてください。");
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
        setProgressText(`場所・住所を調べています... ${index + 1} / ${activeStops.length}件`);
        let location = null;
        try {
          location = await geocodeStop(stop);
        } catch (error) {
          location = null;
        }

        if (location) {
          foundStops.push({
            ...stop,
            lat: location.lat,
            lng: location.lng,
            displayName: location.displayName,
            geocodeQuery: location.geocodeQuery,
            geocodeSource: location.geocodeSource,
            isApproximate: location.isApproximate,
            matrixIndex: foundStops.length + 1
          });
        } else {
          failedStops.push(stop);
          markAddressError(stop.id);
        }

        if (index < activeStops.length - 1) {
          await sleep(GEOCODE_DELAY_MS);
        }
      }

      if (foundStops.length === 0) {
        showFormMessage("Step 3：利用者の場所名・住所が1件も見つかりませんでした。赤色の行を修正してください。");
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

  function clearFailedAddresses() {
    elements.failedAddresses.textContent = "";
    elements.failedAddresses.classList.remove("is-visible");
  }

  function clearMapLayer() {
    if (state.map && state.layer) {
      state.map.removeLayer(state.layer);
      state.layer = null;
    }
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
    const manualArrivalTimes = {};
    const schedule = roadRoute ? buildArrivalSchedule(departureTime, roadRoute.legs, stopMinutes, manualArrivalTimes, ordered) : [];
    const course = getActiveCourse();
    course.lastRoute = { facility, facilityAddress, ordered, returnToStart, failedStops, roadRoute, schedule, manualArrivalTimes, departureTime, stopMinutes, optimizationMode };
    course.stops = sortStopsByRouteOrder(course.stops, ordered);
    renderStops();
    (failedStops || []).forEach((stop) => markAddressError(stop.id));
    renderRouteResult(course.lastRoute);
    elements.result.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderRouteResult(route) {
    const course = getActiveCourse();
    elements.placeholder.hidden = true;
    elements.result.hidden = false;
    elements.resultTitle.textContent = buildResultTitle(course);
    elements.summaryStopCount.textContent = String(route.ordered.length);
    elements.summaryDistance.textContent = route.roadRoute && Number.isFinite(route.roadRoute.distanceMeters)
      ? formatDistanceMeters(route.roadRoute.distanceMeters)
      : `${routeDistance(route.facility, route.ordered, route.returnToStart).toFixed(1)} km`;
    elements.summaryDuration.textContent = route.roadRoute ? formatDuration(route.roadRoute.durationSeconds) : "--";
    renderDistanceNote(route.roadRoute, route.optimizationMode, [route.facility, ...route.ordered]);

    renderRouteList(route);
    renderSchedule(route, elements.departureTime.value, Number.parseInt(elements.stopMinutes.value, 10) || 0);
    renderFailedAddresses(route.failedStops || []);
    renderGoogleMapLink(route.facility, route.ordered, route.returnToStart);
    renderMap(route.facility, route.ordered, route.returnToStart, route.roadRoute);
    renderPrintSheet(route.facilityAddress, route.ordered, route.returnToStart, route.schedule);
  }

  function refreshActiveRouteSchedule() {
    const course = getActiveCourse();
    if (!course || !course.lastRoute || !course.lastRoute.roadRoute) {
      return;
    }
    updateRouteSchedule(course.lastRoute);
    renderRouteResult(course.lastRoute);
  }

  function updateRouteSchedule(route) {
    const departureTime = elements.departureTime.value;
    const stopMinutes = Number.parseInt(elements.stopMinutes.value, 10) || 0;
    route.departureTime = departureTime;
    route.stopMinutes = stopMinutes;
    route.schedule = buildArrivalSchedule(
      departureTime,
      route.roadRoute.legs,
      stopMinutes,
      route.manualArrivalTimes || {},
      route.ordered
    );
  }

  function buildResultTitle(course) {
    return `${state.mode === "pickup" ? "お迎え" : "お送り"}・${course.name}の時間優先ルート`;
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
    if (optimizationMode === "manual") {
      elements.distanceNote.textContent = `${approximationNote} 手動で変更した順番で道路距離・走行時間を再計算しています。渋滞、信号待ち、乗降介助時間はGoogleマップや現場判断で確認してください。`.trim();
      return;
    }
    elements.distanceNote.textContent = `${approximationNote} 順番・道路距離・走行時間はOSRMによる目安です。渋滞、信号待ち、乗降介助時間はGoogleマップや現場判断で確認してください。`.trim();
  }

  function renderRouteList(route) {
    const { facility, facilityAddress, ordered, returnToStart, roadRoute, schedule } = route;
    elements.routeList.innerHTML = "";
    elements.routeList.appendChild(createRouteItem("発", "事業所", facilityAddress, true, facility.isApproximate ? "近似地点（住所の代表地点）" : "出発地"));
    ordered.forEach((stop, index) => {
      const leg = roadRoute && roadRoute.legs[index] ? roadRoute.legs[index] : null;
      const scheduleItem = schedule[index];
      elements.routeList.appendChild(createRouteItem(
        String(index + 1),
        getRoutePrimaryName(stop),
        getRouteDetailLines(stop),
        false,
        appendApproximateMeta(buildLegMeta(leg, scheduleItem), stop),
        {
          routeIndex: index,
          routeCount: ordered.length,
          label: getRoutePrimaryName(stop)
        }
      ));
    });
    if (returnToStart) {
      const leg = roadRoute && roadRoute.legs[ordered.length] ? roadRoute.legs[ordered.length] : null;
      const scheduleItem = schedule[ordered.length];
      elements.routeList.appendChild(createRouteItem("着", "事業所", facilityAddress, true, appendApproximateMeta(buildLegMeta(leg, scheduleItem), facility)));
    }
    bindRouteReorderControls(route);
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

  function createRouteItem(order, name, detailLines, isFacility, meta, reorderOptions) {
    const item = document.createElement("li");
    const isReorderable = reorderOptions && Number.isInteger(reorderOptions.routeIndex);
    item.className = isReorderable ? "route-item is-reorderable" : "route-item";
    if (isReorderable) {
      item.draggable = true;
      item.dataset.routeIndex = String(reorderOptions.routeIndex);
    }
    item.innerHTML = `
      <span class="route-badge${isFacility ? " is-facility" : ""}">${escapeHtml(order)}</span>
      <span class="route-content">
        <span class="route-name">${escapeHtml(name)}</span>
        ${renderRouteDetailLines(detailLines)}
        ${meta ? `<span class="route-meta">${escapeHtml(meta)}</span>` : ""}
      </span>
      ${isReorderable ? `
        <span class="route-reorder-controls" aria-label="${escapeHtml(name)}の順番変更">
          <button type="button" class="route-move-button" data-route-index="${reorderOptions.routeIndex}" data-move="-1"${reorderOptions.routeIndex === 0 ? " disabled" : ""} aria-label="${escapeHtml(name)}を1つ上へ">↑</button>
          <button type="button" class="route-move-button" data-route-index="${reorderOptions.routeIndex}" data-move="1"${reorderOptions.routeIndex === reorderOptions.routeCount - 1 ? " disabled" : ""} aria-label="${escapeHtml(name)}を1つ下へ">↓</button>
          <span class="route-drag-label">ドラッグ</span>
        </span>
      ` : ""}
    `;
    return item;
  }

  function renderRouteDetailLines(detailLines) {
    const lines = Array.isArray(detailLines) ? detailLines : [detailLines];
    return lines
      .filter((line) => String(line || "").trim())
      .map((line) => `<span class="route-address">${escapeHtml(line)}</span>`)
      .join("");
  }

  function bindRouteReorderControls(route) {
    elements.routeList.querySelectorAll(".route-item.is-reorderable").forEach((item) => {
      item.addEventListener("dragstart", (event) => {
        item.classList.add("is-dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", item.dataset.routeIndex);
      });
      item.addEventListener("dragend", () => {
        item.classList.remove("is-dragging");
      });
      item.addEventListener("dragover", (event) => {
        event.preventDefault();
        item.classList.add("is-drop-target");
        event.dataTransfer.dropEffect = "move";
      });
      item.addEventListener("dragleave", () => {
        item.classList.remove("is-drop-target");
      });
      item.addEventListener("drop", (event) => {
        event.preventDefault();
        item.classList.remove("is-drop-target");
        const fromIndex = Number.parseInt(event.dataTransfer.getData("text/plain"), 10);
        const toIndex = Number.parseInt(item.dataset.routeIndex, 10);
        applyManualRouteMove(route, fromIndex, toIndex);
      });
    });

    elements.routeList.querySelectorAll(".route-move-button").forEach((button) => {
      button.addEventListener("click", () => {
        const fromIndex = Number.parseInt(button.dataset.routeIndex, 10);
        const move = Number.parseInt(button.dataset.move, 10);
        applyManualRouteMove(route, fromIndex, fromIndex + move);
      });
    });
  }

  async function applyManualRouteMove(route, fromIndex, toIndex) {
    if (!route || elements.calculateRoute.disabled) {
      return;
    }
    const nextOrdered = moveItemInList(route.ordered, fromIndex, toIndex);
    if (nextOrdered === route.ordered || nextOrdered.every((stop, index) => stop.id === route.ordered[index].id)) {
      return;
    }

    route.ordered = nextOrdered;
    route.optimizationMode = "manual";
    const course = getActiveCourse();
    course.stops = sortStopsByRouteOrder(course.stops, route.ordered);
    renderStops();

    setBusy(true);
    setProgressText("手動で変更した順番の道路時間を再計算しています...");
    hideFormMessage();
    try {
      const pathPoints = buildRoutePath(route.facility, route.ordered, route.returnToStart);
      route.roadRoute = await fetchRoadRoute(pathPoints);
      if (!route.roadRoute) {
        throw new Error("manual_route_empty_response");
      }
      updateRouteSchedule(route);
      renderRouteResult(route);
    } catch (error) {
      route.roadRoute = null;
      route.schedule = [];
      renderRouteResult(route);
      showFormMessage("順番は変更しましたが、道路時間を再計算できませんでした。通信環境を確認して、もう一度ルートを計算してください。");
    } finally {
      setBusy(false);
    }
  }

  function renderSchedule(route, departureTime, stopMinutes) {
    const { facilityAddress, ordered, returnToStart, roadRoute, schedule } = route;
    if (!roadRoute) {
      elements.schedule.classList.add("is-visible");
      elements.schedule.innerHTML = "<h3>到着予定</h3><p class=\"schedule-empty\">道路ルートの取得に失敗したため、到着予定時刻は表示できません。</p>";
      return;
    }
    const targets = ordered.map((stop, index) => ({
      order: String(index + 1),
      stopId: stop.id,
      name: getRoutePrimaryName(stop),
      details: getRouteDetailLines(stop)
    }));
    if (returnToStart) {
      targets.push({ order: "着", name: "事業所", details: [facilityAddress] });
    }
    const rows = targets.map((target, index) => {
      const leg = roadRoute.legs[index];
      const scheduleItem = schedule[index];
      const arrival = scheduleItem ? scheduleItem.arrivalTime : "";
      const arrivalLabel = arrival || "出発時刻未設定";
      const isManual = Boolean(scheduleItem && scheduleItem.isManual);
      const timeCell = target.stopId
        ? `
          <div class="schedule-time-control">
            <input class="schedule-time-input" type="time" value="${escapeHtml(arrival)}" data-stop-id="${escapeHtml(target.stopId)}" aria-label="${escapeHtml(target.name)}の予定時刻を調整">
            <button type="button" class="schedule-auto-button" data-stop-id="${escapeHtml(target.stopId)}"${isManual ? "" : " disabled"}>自動</button>
          </div>
          ${arrival ? "" : "<span class=\"route-address\">出発時刻未設定</span>"}
          ${isManual ? "<span class=\"route-meta is-manual\">手入力</span>" : ""}
        `
        : escapeHtml(arrivalLabel);
      return `
        <tr>
          <td>${escapeHtml(target.order)}</td>
          <td>${escapeHtml(target.name)}${renderScheduleDetailLines(target.details)}</td>
          <td>${timeCell}</td>
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
      <p class="mini-status">${escapeHtml(departureNote)} 必要な地点の予定時刻を手入力すると、それ以降の予定時刻も自動で調整します。</p>
    `;
    bindScheduleControls(route);
  }

  function renderScheduleDetailLines(details) {
    return (Array.isArray(details) ? details : [details])
      .filter((line) => String(line || "").trim())
      .map((line) => `<br><span class="route-address">${escapeHtml(line)}</span>`)
      .join("");
  }

  function bindScheduleControls(route) {
    elements.schedule.querySelectorAll(".schedule-time-input").forEach((input) => {
      input.addEventListener("change", (event) => {
        const stopId = event.target.dataset.stopId;
        if (!stopId) {
          return;
        }
        route.manualArrivalTimes = route.manualArrivalTimes || {};
        const manualMinutes = parseClockMinutes(event.target.value);
        if (Number.isFinite(manualMinutes)) {
          route.manualArrivalTimes[stopId] = event.target.value;
        } else {
          delete route.manualArrivalTimes[stopId];
        }
        updateRouteSchedule(route);
        renderRouteResult(route);
      });
    });
    elements.schedule.querySelectorAll(".schedule-auto-button").forEach((button) => {
      button.addEventListener("click", (event) => {
        const stopId = event.target.dataset.stopId;
        if (!stopId || !route.manualArrivalTimes) {
          return;
        }
        delete route.manualArrivalTimes[stopId];
        updateRouteSchedule(route);
        renderRouteResult(route);
      });
    });
  }

  function renderFailedAddresses(failedStops) {
    if (failedStops.length === 0) {
      elements.failedAddresses.textContent = "";
      elements.failedAddresses.classList.remove("is-visible");
      return;
    }

    elements.failedAddresses.innerHTML = `<strong>${failedStops.length}件の住所が見つかりませんでした。</strong> 市町村名を含める、施設名にする、または丁目までの住所に直して、もう一度計算してください。<br>${failedStops
      .map((stop) => `・${escapeHtml(getStopDisplayName(stop))}：${escapeHtml(buildStopSearchQueries(stop).join(" / "))}`)
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
        .bindPopup(`${escapeHtml(getStopDisplayName(stop))}<br>${escapeHtml(getStopAddressLabel(stop))}`);
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
    const activeCourse = getActiveCourse();
    const printableCourses = state.courses
      .map((course) => ({
        course,
        route: course === activeCourse
          ? { facilityAddress, ordered, returnToStart, schedule, departureTime: activeCourse.lastRoute && activeCourse.lastRoute.departureTime }
          : course.lastRoute
      }))
      .filter(({ course }) => courseHasPrintableStops(course));

    const coursesToPrint = printableCourses.length > 0
      ? printableCourses
      : [{ course: activeCourse, route: { facilityAddress, ordered, returnToStart, schedule } }];

    elements.printSheet.innerHTML = coursesToPrint
      .map(({ course, route }) => buildPrintCoursePage(course, route))
      .join("");
  }

  function courseHasPrintableStops(course) {
    return course.stops.some((stop) => String(stop.name || stop.place || stop.address || "").trim());
  }

  function buildPrintCoursePage(course, route) {
    const printDays = getCoursePrintWeek(course);
    const routeStops = Array.isArray(route && route.ordered) && route.ordered.length > 0
      ? route.ordered
      : course.stops.filter((stop) => String(stop.name || stop.place || stop.address || "").trim());
    const routeSchedule = Array.isArray(route && route.schedule) ? route.schedule : [];
    const rows = routeStops.map((stop, index) => buildAttendancePrintRow(stop, index, printDays, routeSchedule[index])).join("");
    const startTime = route && route.departureTime ? route.departureTime : "";
    const contact = String(course.contact || "").trim();
    return `
      <article class="print-course-page">
        <h2>☆${escapeHtml(course.name)} ${escapeHtml(formatPrintMonthLabel(course))}の送迎表☆${contact ? `TEL：${escapeHtml(contact)}` : ""}</h2>
        <div class="print-driver-row">
          <span>送迎者</span>
          <span class="print-driver-line"></span>
          <span class="print-mode">${escapeHtml(state.mode === "pickup" ? "お迎え" : "お送り")}</span>
          <span>出発</span>
          <span class="print-start-time">${escapeHtml(startTime || " ")}</span>
        </div>
        <div class="print-table-wrap">
          <table class="attendance-print-table">
            <colgroup>
              <col class="print-col-order">
              <col class="print-col-name">
              <col class="print-col-place">
              ${printDays.map(() => "<col class=\"print-col-day\">").join("")}
            </colgroup>
            <thead>
              <tr>
                <th class="print-order">No</th>
                <th class="print-name">利用者</th>
                <th class="print-place">日にち　場所・時間</th>
                ${printDays.map((day) => buildPrintDayHeader(day)).join("")}
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="${printDays.length + 3}" class="print-empty-row">利用者情報がありません。</td></tr>`}</tbody>
          </table>
        </div>
        <p class="print-note">枠内は送迎利用チェック欄です。休み予定は「休」、祝日は灰色で表示します。順番と時刻は道路ルートをもとにした目安です。</p>
      </article>
    `;
  }

  function buildAttendancePrintRow(stop, index, printDays, scheduleItem) {
    const plannedTime = scheduleItem && scheduleItem.arrivalTime ? scheduleItem.arrivalTime : "";
    const placeName = getPrintPlaceName(stop);
    return `
      <tr class="print-user-row">
        <td class="print-order" rowspan="2">${index + 1}</td>
        <td class="print-name">${escapeHtml(stop.name || "")}</td>
        <td class="print-place">${escapeHtml(placeName)}</td>
        ${printDays.map((day) => buildPrintUsageCell(stop, day, true)).join("")}
      </tr>
      <tr class="print-time-row">
        <td class="print-name print-name-sub"></td>
        <td class="print-place print-time">${escapeHtml(plannedTime)}</td>
        ${printDays.map((day) => buildPrintUsageCell(stop, day, false)).join("")}
      </tr>
    `;
  }

  function buildPrintDayHeader(day) {
    const classes = ["print-day"];
    if (!day.day) {
      classes.push("is-outside-month");
    }
    if (day.isHoliday) {
      classes.push("is-holiday");
    }
    const dayNumber = day.dateLabel || (day.day ? String(day.day) : "");
    const holidayLabel = day.holidayName ? `<span class="print-holiday-name">${escapeHtml(day.holidayName)}</span>` : "";
    return `<th class="${classes.join(" ")}"><span class="print-day-date">${escapeHtml(dayNumber)}</span><span class="print-day-weekday">${escapeHtml(day.weekday)}</span>${holidayLabel}</th>`;
  }

  function buildPrintUsageCell(stop, day, isFirstRow) {
    const classes = ["print-day"];
    if (!day.day) {
      classes.push("is-outside-month");
    }
    if (day.isHoliday) {
      classes.push("is-holiday");
    }
    const content = getPrintUsageCellContent(stop, day, isFirstRow);
    return `<td class="${classes.join(" ")}">${content}</td>`;
  }

  function getPrintUsageCellContent(stop, day, isFirstRow) {
    if (!day.day) {
      return "";
    }
    if (isStopRestOnDate(stop, day.dateKey)) {
      return isFirstRow ? "<span class=\"print-rest-mark\">休</span>" : "";
    }
    return isFirstRow ? "<span class=\"print-check-frame\"><span>迎</span><span>送</span></span>" : "";
  }

  function getCoursePrintWeek(course) {
    const [year, month] = getCoursePrintYearMonth(course);
    const target = getCoursePrintTargetDate(course, year, month);
    const weekStart = new Date(target.getFullYear(), target.getMonth(), target.getDate());
    const dayOfWeek = weekStart.getDay();
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    weekStart.setDate(weekStart.getDate() - daysFromMonday);

    return Array.from({ length: 5 }, (_, index) => {
      const date = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + index);
      const inTargetMonth = date.getFullYear() === year && date.getMonth() + 1 === month;
      const holidayName = getJapaneseHolidayName(date);
      return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        dateKey: formatDateObjectKey(date),
        dateLabel: String(date.getDate()),
        weekday: ["日", "月", "火", "水", "木", "金", "土"][date.getDay()],
        isOutsideMonth: !inTargetMonth,
        isHoliday: Boolean(holidayName),
        holidayName
      };
    });
  }

  function getCourseRestDateChoices(course) {
    const [year, month] = getCoursePrintYearMonth(course);
    const firstDate = new Date(year, month - 1, 1);
    const lastDate = new Date(year, month, 0);
    const start = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
    const firstDayOfWeek = start.getDay();
    start.setDate(start.getDate() - (firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1));

    const end = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate());
    const lastDayOfWeek = end.getDay();
    end.setDate(end.getDate() + (lastDayOfWeek === 0 ? -2 : 5 - lastDayOfWeek));

    const choices = [];
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    while (date <= end) {
      const weekday = date.getDay();
      if (weekday >= 1 && weekday <= 5) {
        const dateKey = formatDateObjectKey(date);
        choices.push({
          dateKey,
          label: formatRestDateLabel(dateKey, course),
          day: date.getDate(),
          weekday: ["日", "月", "火", "水", "木", "金", "土"][weekday],
          isOutsideMonth: date.getFullYear() !== year || date.getMonth() + 1 !== month
        });
      }
      date.setDate(date.getDate() + 1);
    }
    return choices;
  }

  function formatRestDateLabel(dateKey, course) {
    const date = parseDateKey(dateKey);
    const [year, month] = getCoursePrintYearMonth(course || {});
    const weekday = ["日", "月", "火", "水", "木", "金", "土"][date.getDay()];
    const dayLabel = date.getFullYear() === year && date.getMonth() + 1 === month
      ? `${date.getDate()}`
      : `${date.getMonth() + 1}/${date.getDate()}`;
    return `${dayLabel}(${weekday})`;
  }

  function getCoursePrintTargetDate(course, fallbackYear, fallbackMonth) {
    const source = String(course.targetDate || "").trim();
    const match = source.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      return new Date(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10) - 1, Number.parseInt(match[3], 10));
    }
    return new Date(fallbackYear, fallbackMonth - 1, 1);
  }

  function getCoursePrintYearMonth(course) {
    const source = String(course.targetMonth || course.targetDate || "").trim();
    const match = source.match(/^(\d{4})-(\d{2})/);
    if (match) {
      return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)];
    }
    const now = new Date();
    return [now.getFullYear(), now.getMonth() + 1];
  }

  function formatPrintMonthLabel(course) {
    const [year, month] = getCoursePrintYearMonth(course);
    return `${year}年${month}月`;
  }

  function getJapaneseHolidayName(date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const holidays = getJapaneseHolidays(year);
    const key = formatDateKey(year, month, day);
    return holidays.get(key) || "";
  }

  function getJapaneseHolidays(year) {
    const holidays = new Map();
    const addHoliday = (month, day, name) => {
      holidays.set(formatDateKey(year, month, day), name);
    };

    addHoliday(1, 1, "元日");
    addHoliday(2, 11, "建国記念の日");
    if (year >= 2020) {
      addHoliday(2, 23, "天皇誕生日");
    }
    addHoliday(4, 29, "昭和の日");
    addHoliday(5, 3, "憲法記念日");
    addHoliday(5, 4, "みどりの日");
    addHoliday(5, 5, "こどもの日");
    addHoliday(8, 11, "山の日");
    addHoliday(11, 3, "文化の日");
    addHoliday(11, 23, "勤労感謝の日");

    addHoliday(1, nthWeekdayOfMonth(year, 1, 1, 2), "成人の日");
    addHoliday(7, nthWeekdayOfMonth(year, 7, 1, 3), "海の日");
    addHoliday(9, nthWeekdayOfMonth(year, 9, 1, 3), "敬老の日");
    addHoliday(10, nthWeekdayOfMonth(year, 10, 1, 2), "スポーツの日");
    addHoliday(3, calculateVernalEquinoxDay(year), "春分の日");
    addHoliday(9, calculateAutumnalEquinoxDay(year), "秋分の日");

    applySubstituteHolidays(holidays, year);
    applyCitizensHolidays(holidays, year);
    return holidays;
  }

  function applySubstituteHolidays(holidays, year) {
    const holidayEntries = Array.from(holidays.keys()).sort();
    holidayEntries.forEach((key) => {
      const date = parseDateKey(key);
      if (date.getDay() !== 0) {
        return;
      }
      let substitute = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
      while (substitute.getFullYear() === year && holidays.has(formatDateObjectKey(substitute))) {
        substitute.setDate(substitute.getDate() + 1);
      }
      if (substitute.getFullYear() === year) {
        holidays.set(formatDateObjectKey(substitute), "振替休日");
      }
    });
  }

  function applyCitizensHolidays(holidays, year) {
    const date = new Date(year, 0, 2);
    while (date.getFullYear() === year) {
      const key = formatDateObjectKey(date);
      if (!holidays.has(key)) {
        const previous = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
        const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
        if (holidays.has(formatDateObjectKey(previous)) && holidays.has(formatDateObjectKey(next))) {
          holidays.set(key, "国民の休日");
        }
      }
      date.setDate(date.getDate() + 1);
    }
  }

  function nthWeekdayOfMonth(year, month, weekday, nth) {
    const date = new Date(year, month - 1, 1);
    const offset = (weekday - date.getDay() + 7) % 7;
    return 1 + offset + (nth - 1) * 7;
  }

  function calculateVernalEquinoxDay(year) {
    return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }

  function calculateAutumnalEquinoxDay(year) {
    return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }

  function formatDateKey(year, month, day) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function formatDateObjectKey(date) {
    return formatDateKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }

  function parseDateKey(key) {
    const [year, month, day] = key.split("-").map((value) => Number.parseInt(value, 10));
    return new Date(year, month - 1, day);
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
    createInitialCourses,
    buildStopSearchQueries,
    getStopDisplayName,
    getRoutePrimaryName,
    getRouteDetailLines,
    getPrintPlaceName,
    parseRestDays,
    normalizeRestDates,
    isStopRestOnDay,
    isStopRestOnDate,
    getCoursePrintWeek,
    getCourseRestDateChoices,
    getJapaneseHolidayName,
    sortStopsByRouteOrder,
    moveItemInList,
    serializeCoursesForStorage,
    hydrateCoursesFromStorage,
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
