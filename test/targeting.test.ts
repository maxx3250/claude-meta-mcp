import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeTargeting,
  changedTargetingKeys,
  stripReadOnlyTargetingKeys,
} from "../src/lib/targeting.js";

const current = {
  age_min: 25,
  age_max: 65,
  age_range: [25, 65],
  geo_locations: { countries: ["AT", "DE"], location_types: ["home", "recent"] },
  excluded_custom_audiences: [{ id: "1" }],
  publisher_platforms: ["facebook", "instagram"],
  targeting_automation: { advantage_audience: 1 },
};

test("top-level keys in the patch replace the current value", () => {
  const out = mergeTargeting(current, { publisher_platforms: ["facebook"] });
  assert.deepEqual(out.publisher_platforms, ["facebook"]);
  assert.equal(out.age_min, 25);
});

test("geo_locations merges one level: countries change, location_types survive", () => {
  const out = mergeTargeting(current, { geo_locations: { countries: ["AT"] } });
  assert.deepEqual(out.geo_locations, {
    countries: ["AT"],
    location_types: ["home", "recent"],
  });
});

test("unset removes top-level and dotted keys", () => {
  const out = mergeTargeting(current, {}, [
    "excluded_custom_audiences",
    "geo_locations.location_types",
  ]);
  assert.equal("excluded_custom_audiences" in out, false);
  assert.deepEqual(out.geo_locations, { countries: ["AT", "DE"] });
});

test("read-only keys returned by Graph are stripped before a write", () => {
  const out = mergeTargeting(current, {});
  assert.equal("age_range" in out, false);
  assert.equal("age_range" in stripReadOnlyTargetingKeys(current), false);
});

test("merge never mutates its inputs", () => {
  const snapshot = JSON.stringify(current);
  const patch = { geo_locations: { countries: ["CH"] } };
  mergeTargeting(current, patch, ["publisher_platforms"]);
  assert.equal(JSON.stringify(current), snapshot);
  assert.deepEqual(patch, { geo_locations: { countries: ["CH"] } });
});

test("empty current targeting is fine", () => {
  const out = mergeTargeting(undefined, { age_min: 18 });
  assert.deepEqual(out, { age_min: 18 });
});

test("changedTargetingKeys lists only what differs", () => {
  const after = mergeTargeting(current, { geo_locations: { countries: ["AT"] } });
  assert.deepEqual(changedTargetingKeys(stripReadOnlyTargetingKeys(current), after), [
    "geo_locations",
  ]);
});
