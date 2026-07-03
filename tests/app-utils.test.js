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
assert.strictEqual(courses.length, 8, "should create up to eight courses");
assert.strictEqual(JSON.stringify(courses.map((course) => course.name)), JSON.stringify(["コース1", "コース2", "コース3", "コース4", "コース5", "コース6", "コース7", "コース8"]));
assert.strictEqual(courses[0].contact, "", "course contact should start empty");
assert.strictEqual(courses[0].targetMonth, "", "course target month should start empty");
assert.strictEqual(courses[0].targetDate, "", "course target date should start empty");
assert.strictEqual(courses[0].stops.length, 1, "each course should start with one blank stop row");
assert.notStrictEqual(courses[0].stops[0].id, courses[1].stops[0].id, "stop ids should be unique across courses");
assert.strictEqual(courses[0].stops[0].service, undefined, "stop service should not be part of the route input");
assert.strictEqual(courses[0].stops[0].scheduledTime, undefined, "manual scheduled time should not be part of the route input");
assert.strictEqual(JSON.stringify(courses[0].stops[0].restDays), JSON.stringify([]), "stop rest days should start empty");
assert.strictEqual(JSON.stringify(courses[0].stops[0].restDates), JSON.stringify([]), "stop rest dates should start empty");

courses[0].stops[0].name = "Aさん";
courses[1].stops[0].name = "Bさん";
assert.strictEqual(courses[0].stops[0].name, "Aさん");
assert.strictEqual(courses[1].stops[0].name, "Bさん");
const hydratedFourCourses = utils.hydrateCoursesFromStorage({
  version: 1,
  courses: [
    { name: "A", contact: "", targetMonth: "", targetDate: "", stops: [] },
    { name: "B", contact: "", targetMonth: "", targetDate: "", stops: [] },
    { name: "C", contact: "", targetMonth: "", targetDate: "", stops: [] },
    { name: "D", contact: "", targetMonth: "", targetDate: "", stops: [] }
  ]
});
assert.strictEqual(hydratedFourCourses.length, 8, "old saved data should be expanded to eight courses");
assert.strictEqual(hydratedFourCourses[4].name, "コース5", "newly added courses should keep default names");

const stopWithPlaceAndAddress = {
  name: "利用者A",
  place: "那覇空港",
  address: "沖縄県那覇市鏡水150"
};
assert.strictEqual(
  JSON.stringify(utils.buildStopSearchQueries(stopWithPlaceAndAddress)),
  JSON.stringify([
    "那覇空港 沖縄県那覇市鏡水150",
    "那覇空港, 沖縄県那覇市鏡水150",
    "那覇空港 沖縄県那覇市",
    "沖縄県那覇市鏡水150",
    "那覇空港"
  ]),
  "place name should be searched with multiple address contexts before falling back to address and place"
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
assert.strictEqual(
  utils.isPlausibleGeocodeHit(
    { display_name: "名護市役所, 名護市, 沖縄県, 日本" },
    { state: "沖縄県", city: "名護市", town: "港" },
    { allowTownMismatch: true }
  ),
  true,
  "named public facilities should be accepted when prefecture and city match even if the town is missing from the result"
);
assert.strictEqual(
  utils.isPlausibleGeocodeHit(
    { display_name: "名護市役所, 名護市, 沖縄県, 日本" },
    { state: "沖縄県", city: "名護市", town: "港" }
  ),
  false,
  "plain address searches should keep the stricter town check"
);

const stopWithoutPlace = {
  name: "利用者B",
  place: "",
  address: "沖縄県那覇市泉崎1丁目1-1"
};
assert.strictEqual(JSON.stringify(utils.buildStopSearchQueries(stopWithoutPlace)), JSON.stringify(["沖縄県那覇市泉崎1丁目1-1"]));
assert.strictEqual(utils.getStopDisplayName(stopWithoutPlace), "利用者B");
assert.strictEqual(utils.getPrintPlaceName(stopWithoutPlace), "", "address-only stops should leave the print place blank");

const googleUrl = new URL(utils.buildGoogleMapsUrl(
  { lat: 26.2124, lng: 127.6809 },
  [{ lat: 26.3344, lng: 127.8056 }, { lat: 26.5915, lng: 127.9773 }],
  true
));
assert.strictEqual(googleUrl.searchParams.get("avoid"), "highways,tolls", "Google Maps URL should request routes that avoid highways and tolls");
assert.ok(
  utils.buildOsrmRouteUrl([{ lat: 26.2124, lng: 127.6809 }, { lat: 26.3344, lng: 127.8056 }]).includes("exclude=motorway"),
  "OSRM route requests should exclude motorways for no-expressway route previews"
);
assert.ok(
  utils.buildOsrmTableUrl([{ lat: 26.2124, lng: 127.6809 }, { lat: 26.3344, lng: 127.8056 }]).includes("exclude=motorway"),
  "OSRM table requests should exclude motorways for no-expressway route ordering"
);

assert.strictEqual(JSON.stringify(utils.parseRestDays("1, 3 5,31,32,0,abc,3")), JSON.stringify([1, 3, 5, 31]), "rest days should be normalized to unique valid day numbers");
assert.strictEqual(utils.isStopRestOnDay({ restDays: [1, 3, 5] }, 3), true, "checked rest day should be detected");
assert.strictEqual(utils.isStopRestOnDay({ restDays: [1, 3, 5] }, 4), false, "unchecked rest day should not be treated as rest");
assert.strictEqual(utils.isStopRestOnDate({ restDates: ["2026-07-01"] }, "2026-07-01"), true, "date-based rest days should be detected");

const firstWeek = utils.getCoursePrintWeek({ targetMonth: "2026-04", targetDate: "2026-04-03" });
assert.strictEqual(
  JSON.stringify(firstWeek.map((day) => ({
    dateLabel: day.dateLabel,
    weekday: day.weekday,
    day: day.day,
    isOutsideMonth: day.isOutsideMonth
  }))),
  JSON.stringify([
    { dateLabel: "30", weekday: "月", day: 30, isOutsideMonth: true },
    { dateLabel: "31", weekday: "火", day: 31, isOutsideMonth: true },
    { dateLabel: "1", weekday: "水", day: 1, isOutsideMonth: false },
    { dateLabel: "2", weekday: "木", day: 2, isOutsideMonth: false },
    { dateLabel: "3", weekday: "金", day: 3, isOutsideMonth: false }
  ]),
  "print week should show day numbers for the Monday-Friday block, excluding weekends"
);
const monthEndWeek = utils.getCoursePrintWeek({ targetMonth: "2026-06", targetDate: "2026-06-30" });
assert.strictEqual(
  JSON.stringify(monthEndWeek.map((day) => ({
    dateLabel: day.dateLabel,
    weekday: day.weekday,
    dateKey: day.dateKey,
    isOutsideMonth: day.isOutsideMonth
  }))),
  JSON.stringify([
    { dateLabel: "29", weekday: "月", dateKey: "2026-06-29", isOutsideMonth: false },
    { dateLabel: "30", weekday: "火", dateKey: "2026-06-30", isOutsideMonth: false },
    { dateLabel: "1", weekday: "水", dateKey: "2026-07-01", isOutsideMonth: true },
    { dateLabel: "2", weekday: "木", dateKey: "2026-07-02", isOutsideMonth: true },
    { dateLabel: "3", weekday: "金", dateKey: "2026-07-03", isOutsideMonth: true }
  ]),
  "print week should always include five weekdays even when it crosses into the next month"
);
assert.ok(
  utils.getCourseRestDateChoices({ targetMonth: "2026-06", targetDate: "2026-06-30" })
    .some((choice) => choice.dateKey === "2026-07-03"),
  "rest-day choices should include next-month weekdays shown on the print sheet"
);
const julyPrintWeeks = utils.getCoursePrintWeeks({ targetMonth: "2026-07", targetDate: "2026-07-15" });
assert.strictEqual(julyPrintWeeks.length, 5, "monthly print should include every Monday-Friday sheet needed for the month");
assert.strictEqual(
  JSON.stringify(julyPrintWeeks.map((week) => week.map((day) => day.dateKey))),
  JSON.stringify([
    ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03"],
    ["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10"],
    ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17"],
    ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"],
    ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"]
  ]),
  "monthly print weeks should preserve five weekdays per page and include outside-month days only when they share a target-month week"
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
  JSON.stringify(utils.getCalculationStops({
    targetDate: "2026-06-30",
    stops: [
      { id: "a", name: "A", place: "施設A", address: "", restDates: [] },
      { id: "b", name: "B", place: "", address: "沖縄県名護市港1-1-1", restDates: [] },
      { id: "c", name: "C", place: "施設C", address: "", restDates: ["2026-06-29"] }
    ]
  }).map((stop) => stop.id)),
  JSON.stringify(["a", "b", "c"]),
  "calculation should include every non-rest row with a place or address, including rows that failed in a previous run"
);
assert.strictEqual(
  JSON.stringify(utils.getCalculationStops({
    targetDate: "2026-06-30",
    stops: [
      { id: "a", name: "A", place: "施設A", address: "", restDates: [] },
      { id: "b", name: "B", place: "施設B", address: "", restDates: ["2026-06-30"] }
    ]
  }).map((stop) => stop.id)),
  JSON.stringify(["a", "b"]),
  "calculation should keep resting users in the route because rest marks are for the monthly print sheet"
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

const printCourse = {
  stops: [
    { id: "a", name: "利用者A", place: "施設A", address: "", restDates: [] },
    { id: "b", name: "利用者B", place: "施設B", address: "", restDates: [] },
    { id: "c", name: "利用者C", place: "施設C", address: "", restDates: ["2026-06-30"] }
  ]
};
const printRoute = {
  ordered: [
    { id: "b", name: "利用者B", place: "施設B", address: "" },
    { id: "a", name: "利用者A", place: "施設A", address: "" }
  ],
  schedule: [
    { arrivalTime: "09:10" },
    { arrivalTime: "09:20" }
  ]
};
assert.strictEqual(
  JSON.stringify(utils.buildPrintableRouteStops(printCourse, printRoute).map((stop) => stop.id)),
  JSON.stringify(["b", "a", "c"]),
  "print sheet should keep route order and append rest or uncalculated users so they can be shown as rest"
);
assert.strictEqual(
  utils.buildScheduleByStopId(printRoute).get("a").arrivalTime,
  "09:20",
  "print schedules should stay attached to the matching route stop after rest users are appended"
);
assert.ok(
  utils.getPrintUsageCellContent(printCourse.stops[2], { day: 30, dateKey: "2026-06-30" }, true).includes("print-rest-mark"),
  "print cells should show a rest mark for users with a rest setting on that date"
);
assert.strictEqual(
  JSON.stringify(utils.getPrintableCourseEntries({
    courses: [
      { id: "course-1", name: "A", stops: [{ name: "利用者A" }] },
      { id: "course-2", name: "B", stops: [{ name: "利用者B" }] }
    ],
    activeCourseIndex: 1,
    printCourseScope: "active"
  }).map(({ course }) => course.name)),
  JSON.stringify(["B"]),
  "active-course print scope should print only the selected course"
);
assert.strictEqual(
  JSON.stringify(utils.getPrintableCourseEntries({
    courses: [
      { id: "course-1", name: "A", stops: [{ name: "利用者A" }] },
      { id: "course-2", name: "B", stops: [{ name: "利用者B" }] },
      { id: "course-3", name: "C", stops: [{ name: "" }] }
    ],
    activeCourseIndex: 1,
    printCourseScope: "all"
  }).map(({ course }) => course.name)),
  JSON.stringify(["A", "B"]),
  "all-course print scope should print every course with printable users"
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
courses[0].stops[0].restDates = ["2026-04-03", "2026-04-10", "2026-05-01"];
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
assert.strictEqual(JSON.stringify(savedPayload.courses[0].stops[0].restDates), JSON.stringify(["2026-04-03", "2026-04-10", "2026-05-01"]));
assert.strictEqual(savedPayload.courses[0].lastRoute, undefined, "calculated route results should not be stored");

const restoredCourses = utils.hydrateCoursesFromStorage(savedPayload);
assert.strictEqual(restoredCourses.length, 8);
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
assert.strictEqual(JSON.stringify(restoredCourses[0].stops[0].restDates), JSON.stringify(["2026-04-03", "2026-04-10", "2026-05-01"]));
assert.strictEqual(restoredCourses[0].lastRoute, null);

const legacyRestoredCourses = utils.hydrateCoursesFromStorage({
  version: 1,
  courses: [{
    name: "旧コース",
    contact: "",
    targetMonth: "2026-04",
    targetDate: "2026-04-03",
    stops: [{ name: "利用者C", place: "施設C", address: "", restDays: [3, 10] }]
  }]
});
assert.strictEqual(
  JSON.stringify(legacyRestoredCourses[0].stops[0].restDates),
  JSON.stringify(["2026-04-03", "2026-04-10"]),
  "legacy day-based rest settings should hydrate into date-based rest settings"
);

console.log("course and place utility tests passed");
