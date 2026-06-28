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
assert.strictEqual(courses[0].stops.length, 3, "each course should start with three blank stop rows");
assert.notStrictEqual(courses[0].stops[0].id, courses[1].stops[0].id, "stop ids should be unique across courses");

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
  JSON.stringify(["那覇空港", "沖縄県那覇市鏡水150"]),
  "place name should be searched before address"
);
assert.strictEqual(
  utils.getStopDisplayName(stopWithPlaceAndAddress),
  "那覇空港",
  "print and route labels should prefer place name"
);

const stopWithoutPlace = {
  name: "利用者B",
  place: "",
  address: "沖縄県那覇市泉崎1丁目1-1"
};
assert.strictEqual(JSON.stringify(utils.buildStopSearchQueries(stopWithoutPlace)), JSON.stringify(["沖縄県那覇市泉崎1丁目1-1"]));
assert.strictEqual(utils.getStopDisplayName(stopWithoutPlace), "利用者B");

courses[0].name = "1号車";
courses[0].contact = "090-0000-0000";
courses[0].stops[0].name = "利用者A";
courses[0].stops[0].place = "那覇空港";
courses[0].stops[0].address = "沖縄県那覇市鏡水150";
courses[0].lastRoute = { shouldNotBeSaved: true };
const savedPayload = utils.serializeCoursesForStorage(courses);
assert.strictEqual(savedPayload.version, 1);
assert.strictEqual(savedPayload.courses[0].name, "1号車");
assert.strictEqual(savedPayload.courses[0].contact, "090-0000-0000");
assert.strictEqual(savedPayload.courses[0].stops[0].place, "那覇空港");
assert.strictEqual(savedPayload.courses[0].lastRoute, undefined, "calculated route results should not be stored");

const restoredCourses = utils.hydrateCoursesFromStorage(savedPayload);
assert.strictEqual(restoredCourses.length, 4);
assert.strictEqual(restoredCourses[0].name, "1号車");
assert.strictEqual(restoredCourses[0].contact, "090-0000-0000");
assert.strictEqual(restoredCourses[0].stops[0].name, "利用者A");
assert.strictEqual(restoredCourses[0].stops[0].place, "那覇空港");
assert.strictEqual(restoredCourses[0].stops[0].address, "沖縄県那覇市鏡水150");
assert.strictEqual(restoredCourses[0].lastRoute, null);

console.log("course and place utility tests passed");
