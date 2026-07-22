import test from "node:test";
import assert from "node:assert/strict";
import {
  DISCOVER_STYLE_CATEGORIES,
  matchesDiscoverCategoryFilter,
  normalizeDiscoverCategory,
  bustImageCacheUrl,
} from "../discoverCategories.js";

test("canonical Discover categories match product order", () => {
  assert.deepEqual(
    DISCOVER_STYLE_CATEGORIES.map((c) => c.id),
    [
      "haircuts",
      "fades",
      "lineups",
      "beard",
      "braids",
      "locs",
      "styling",
      "color",
      "nails",
      "beauty",
    ],
  );
});

test("legacy category ids normalize into Discover chips", () => {
  assert.equal(normalizeDiscoverCategory("skin_fade"), "fades");
  assert.equal(normalizeDiscoverCategory("taper_fade"), "fades");
  assert.equal(normalizeDiscoverCategory("beard work"), "beard");
  assert.equal(normalizeDiscoverCategory("kids cuts"), "haircuts");
  assert.equal(normalizeDiscoverCategory("designs"), "lineups");
  assert.equal(normalizeDiscoverCategory("hair_color"), "color");
  assert.equal(normalizeDiscoverCategory("womens_styles"), "styling");
});

test("filter matches normalized category and title cues", () => {
  assert.equal(matchesDiscoverCategoryFilter("fades", { category: "skin_fade" }), true);
  assert.equal(matchesDiscoverCategoryFilter("fades", { category: "fades" }), true);
  assert.equal(matchesDiscoverCategoryFilter("fades", { category: "braids" }), false);
  // Uncategorized rows may still match via title text
  assert.equal(matchesDiscoverCategoryFilter("fades", { title: "Clean Skin Fade" }), true);
  assert.equal(matchesDiscoverCategoryFilter("beard", { category: "braids" }), false);
  assert.equal(matchesDiscoverCategoryFilter("", { category: "anything" }), true);
});

test("bustImageCacheUrl appends version without breaking absolute URLs", () => {
  const out = bustImageCacheUrl("https://cdn.example.com/a.jpg", 123);
  assert.match(out, /[?&]v=123/);
});
