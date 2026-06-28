/** Haircut style categories for discovery and photo tagging. */
export const HAIRCUT_STYLE_CATEGORIES = [
  { id: "skin_fade", label: "Skin Fade" },
  { id: "taper_fade", label: "Taper Fade" },
  { id: "burst_fade", label: "Burst Fade" },
  { id: "beard", label: "Beard" },
  { id: "kids_cuts", label: "Kids Cuts" },
  { id: "braids", label: "Braids" },
  { id: "designs", label: "Designs" },
  { id: "womens_styles", label: "Women's Styles" },
  { id: "hair_color", label: "Hair Color" },
];

export const HAIRCUT_CATEGORY_IDS = new Set(HAIRCUT_STYLE_CATEGORIES.map((c) => c.id));

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
