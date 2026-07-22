/** Re-export Discover categories — single source of truth in discoverCategories.js */
export {
  DISCOVER_STYLE_CATEGORIES,
  DISCOVER_CATEGORY_IDS,
  HAIRCUT_STYLE_CATEGORIES,
  HAIRCUT_CATEGORY_IDS,
  STYLE_CATEGORIES,
  normalizeDiscoverCategory,
  matchesDiscoverCategoryFilter,
  bustImageCacheUrl,
} from "./discoverCategories.js";

/** Automatic recognition badges (computed from portfolio metrics). */
export const BARBER_BADGE_DEFINITIONS = {
  top_rated: {
    key: "top_rated",
    label: "Top Rated Barber",
    description: "Average rating 4.8+ with at least 10 reviews",
  },
  trending: {
    key: "trending",
    label: "Trending Barber",
    description: "High engagement in the last 30 days",
  },
  master: {
    key: "master",
    label: "Master Barber",
    description: "5+ years experience and 50+ completed bookings",
  },
  hundred_five_star: {
    key: "hundred_five_star",
    label: "100+ Five-Star Reviews",
    description: "At least 100 five-star customer reviews",
  },
  most_liked: {
    key: "most_liked",
    label: "Most Liked Haircuts",
    description: "500+ likes across portfolio photos",
  },
};

export const CONTENT_REPORT_REASONS = [
  "inappropriate",
  "spam",
  "harassment",
  "copyright",
  "misleading",
  "other",
];

export const MAX_REVIEW_PHOTOS = 5;
export const FOLLOWUP_REMINDER_DAYS = 30;
/** Hours after submission during which customers may edit or delete their review. */
export const REVIEW_EDIT_WINDOW_HOURS = 48;
