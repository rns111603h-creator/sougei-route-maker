const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const code = fs.readFileSync("js/app.js", "utf8");
const context = {
  window: {},
  document: {
    addEventListener() {},
    getElementById() { return null; },
    querySelectorAll() { return []; },
    createElement() { return {}; }
  },
  console,
  URLSearchParams,
  setTimeout,
  clearTimeout
};

vm.createContext(context);
vm.runInContext(code, context);

const utils = context.window.RouteMakerUtils;
assert.ok(utils, "RouteMakerUtils should be exposed on window");

const courses = utils.createInitialCourses();
assert.strictEqual(courses.length, 4, "should create up to four courses");
assert.strictEqual(JSON.stringify(courses.map((course) => course.name)), JSON.stringify(["コース1", "コース2", "コース3", "コース4"]));
assert.strictEqual(courses[0].contact, "", "course contact should start empty");
assert.strictEqual(courses[0].targetMonth, "", "course target month should start empty");
assert.strictEqual(courses[0].targetDate, "", "course target date should start empty");
assert.strictEqual(courses[0].stops.length, 1, "each course should start with one blank stop row");
assert.notStrictEqual(courses[0].stops[0].id, courses[1].stops[0].id, "stop ids should be unique across courses");
assert.strictEqual(courses[0].stops[0].service, undefined, "stop service should not be part of the route input");
assert.strictEqual(courses[0].stops[0].scheduledTime, undefined, "manual scheduled time should not be part of the route input");
assert.strictEqual(JSON.stringify(courses[0].stops[0].restDays), JSON.stringify([]), "stop rest days should start empty");

courses[0].stops[0].name = "Aさん";
courses[1].stops[0].name = "Bさん";
assert.strictEqual(courses[0].stops[0].name, "Aさん");
assert.strictEqual(courses[1].stops[0].name, "Bさん");

const stopWithPlaceAndAddress = {
  name: "利用者A",
  place: "那覇空港",
  address: "沖縄県那覇市鏡水150"
};
assert.strictEqual(
  JSON.stringify(utils.buildStopSearchQueries(stopWithPlaceAndAddress)),
  JSON.stringify(["那覇空港 沖縄県那覇市鏡水150", "沖縄県那覇市鏡水150"]),
  "place name should be searched with the address context before falling back to address"
);
assert.strictEqual(
  utils.getStopDisplayName(stopWithPlaceAndAddress),
  "那覇空港",
  "print and route labels should prefer place name"
);
assert.strictEqual(utils.getRoutePrimaryName(stopWithPlaceAndAddress), "利用者A", "route result should use user name as primary text");
assert.strictEqual(
  JSON.stringify(utils.getRouteDetailLines(stopWithPlaceAndAddress)),
  JSON.stringify(["場所：那覇空港", "住所：沖縄県那覇市鏡水150"]),
  "route result details should show place before address"
);
assert.strictEqual(utils.getPrintPlaceName(stopWithPlaceAndAddress), "那覇空港", "print sheet should show only the place name");
const combinedCandidate = utils.buildGeocodeCandidates("那覇空港 沖縄県那覇市鏡水150")[0];
assert.strictEqual(combinedCandidate.parts.state, "沖縄県", "combined place and address searches should keep address context");
assert.strictEqual(combinedCandidate.parts.city, "那覇市", "combined place and address searches should keep city context");

const stopWithoutPlace = {
  name: "利用者B",
  place: "",
  address: "沖縄県那覇市泉崎1丁目1-1"
};
assert.strictEqual(JSON.stringify(utils.buildStopSearchQueries(stopWithoutPlace)), JSON.stringify(["沖縄県那覇市泉崎1丁目1-1"]));
assert.strictEqual(utils.getStopDisplayName(stopWithoutPlace), "利用者B");
assert.strictEqual(utils.getPrintPlaceName(stopWithoutPlace), "", "address-only stops should leave the print place blank");

assert.strictEqual(JSON.stringify(utils.parseRestDays("1, 3 5,31,32,0,abc,3")), JSON.stringify([1, 3, 5, 31]), "rest days should be normalized to unique valid day numbers");
assert.strictEqual(utils.isStopRestOnDay({ restDays: [1, 3, 5] }, 3), true, "checked rest day should be detected");
assert.strictEqual(utils.isStopRestOnDay({ restDays: [1, 3, 5] }, 4), false, "unchecked rest day should not be treated as rest");

const firstWeek = utils.getCoursePrintWeek({ targetMonth: "2026-04", targetDate: "2026-04-03" });
assert.strictEqual(
  JSON.stringify(firstWeek.map((day) => ({ weekday: day.weekday, day: day.day }))),
  JSON.stringify([
    { weekday: "月", day: null },
    { weekday: "火", day: null },
    { weekday: "水", day: 1 },
    { weekday: "木", day: 2 },
    { weekday: "金", day: 3 }
  ]),
  "print week should show only the selected month days within the Monday-Friday block"
);
assert.strictEqual(utils.getJapaneseHolidayName(new Date(2026, 4, 5)), "こどもの日", "Japanese holidays should be marked for print");
assert.strictEqual(utils.getJapaneseHolidayName(new Date(2026, 4, 6)), "振替休日", "substitute holidays should be marked for print");

const unsortedStops = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
  { id: "c", name: "C" },
  { id: "d", name: "D" }
];
const routeOrderedStops = [
  { id: "c", name: "C" },
  { id: "a", name: "A" }
];
assert.strictEqual(
  JSON.stringify(utils.sortStopsByRouteOrder(unsortedStops, routeOrderedStops).map((stop) => stop.id)),
  JSON.stringify(["c", "a", "b", "d"]),
  "route stops should move to the calculated order while remaining stops stay after them"
);
assert.strictEqual(
  JSON.stringify(utils.moveItemInList(unsortedStops, 2, 0).map((stop) => stop.id)),
  JSON.stringify(["c", "a", "b", "d"]),
  "moving a route stop should place it at the requested index"
);
assert.strictEqual(
  JSON.stringify(utils.moveItemInList(unsortedStops, -1, 1).map((stop) => stop.id)),
  JSON.stringify(["a", "b", "c", "d"]),
  "invalid route move indexes should leave the list unchanged"
);

const routeLegs = [
  { durationSeconds: 600, distanceMeters: 1000 },
  { durationSeconds: 900, distanceMeters: 2000 },
  { durationSeconds: 1200, distanceMeters: 3000 }
];
const adjustedSchedule = utils.buildArrivalSchedule("08:00", routeLegs, 5, { b: "08:40" }, [
  { id: "a" },
  { id: "b" }
]);
assert.strictEqual(
  JSON.stringify(adjustedSchedule.map((item) => ({
    arrivalTime: item.arrivalTime,
    isManual: item.isManual
  }))),
  JSON.stringify([
    { arrivalTime: "08:10", isManual: false },
    { arrivalTime: "08:40", isManual: true },
    { arrivalTime: "09:05", isManual: false }
  ]),
  "manual arrival time should reset the timeline for following stops and return leg"
);

courses[0].name = "1号車";
courses[0].contact = "090-0000-0000";
courses[0].targetMonth = "2026-04";
courses[0].targetDate = "2026-04-03";
courses[0].stops[0].name = "利用者A";
courses[0].stops[0].place = "那覇空港";
courses[0].stops[0].address = "沖縄県那覇市鏡水150";
courses[0].stops[0].restDays = [3, 10];
courses[0].lastRoute = { shouldNotBeSaved: true };
const savedPayload = utils.serializeCoursesForStorage(courses);
assert.strictEqual(savedPayload.version, 1);
assert.strictEqual(savedPayload.courses[0].name, "1号車");
assert.strictEqual(savedPayload.courses[0].contact, "090-0000-0000");
assert.strictEqual(savedPayload.courses[0].targetMonth, "2026-04");
assert.strictEqual(savedPayload.courses[0].targetDate, "2026-04-03");
assert.strictEqual(savedPayload.courses[0].stops[0].service, undefined);
assert.strictEqual(savedPayload.courses[0].stops[0].place, "那覇空港");
assert.strictEqual(savedPayload.courses[0].stops[0].scheduledTime, undefined);
assert.strictEqual(JSON.stringify(savedPayload.courses[0].stops[0].restDays), JSON.stringify([3, 10]));
assert.strictEqual(savedPayload.courses[0].lastRoute, undefined, "calculated route results should not be stored");

const restoredCourses = utils.hydrateCoursesFromStorage(savedPayload);
assert.strictEqual(restoredCourses.length, 4);
assert.strictEqual(restoredCourses[0].name, "1号車");
assert.strictEqual(restoredCourses[0].contact, "090-0000-0000");
assert.strictEqual(restoredCourses[0].targetMonth, "2026-04");
assert.strictEqual(restoredCourses[0].targetDate, "2026-04-03");
assert.strictEqual(restoredCourses[0].stops[0].name, "利用者A");
assert.strictEqual(restoredCourses[0].stops[0].service, undefined);
assert.strictEqual(restoredCourses[0].stops[0].place, "那覇空港");
assert.strictEqual(restoredCourses[0].stops[0].address, "沖縄県那覇市鏡水150");
assert.strictEqual(restoredCourses[0].stops[0].scheduledTime, undefined);
assert.strictEqual(JSON.stringify(restoredCourses[0].stops[0].restDays), JSON.stringify([3, 10]));
assert.strictEqual(restoredCourses[0].lastRoute, null);

console.log("course and place utility tests passed");
