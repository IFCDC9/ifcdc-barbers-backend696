/**
 * Canonical Discover / portfolio style categories (shared by API, web, mobile).
 * Legacy aliases map old chip IDs and gallery free-text into these ids.
 */

export const DISCOVER_STYLE_CATEGORIES = [
  { id: "haircuts", label: "Haircuts" },
  { id: "fades", label: "Fades" },
  { id: "lineups", label: "Lineups" },
  { id: "beard", label: "Beard" },
  { id: "braids", label: "Braids" },
  { id: "locs", label: "Locs" },
  { id: "styling", label: "Styling" },
  { id: "color", label: "Color" },
  { id: "nails", label: "Nails" },
  { id: "beauty", label: "Beauty" },
];

/** @deprecated Use DISCOVER_STYLE_CATEGORIES — kept for import compatibility */
export const HAIRCUT_STYLE_CATEGORIES = DISCOVER_STYLE_CATEGORIES;

export const DISCOVER_CATEGORY_IDS = new Set(DISCOVER_STYLE_CATEGORIES.map((c) => c.id));
export const HAIRCUT_CATEGORY_IDS = DISCOVER_CATEGORY_IDS;

/** Gallery upload dropdown values — same ids as Discover. */
export const STYLE_CATEGORIES = DISCOVER_STYLE_CATEGORIES.map((c) => c.id);

/**
 * Map any legacy / free-text category to a canonical Discover id.
 * Unknown values fall back to "haircuts" (not dropped).
 */
export function normalizeDiscoverCategory(raw) {
  const v = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!v) return "haircuts";

  const compact = v.replace(/\s+/g, "_");
  if (DISCOVER_CATEGORY_IDS.has(compact)) return compact;
  if (DISCOVER_CATEGORY_IDS.has(v)) return v;

  const aliases = {
    skin_fade: "fades",
    taper_fade: "fades",
    burst_fade: "fades",
    drop_fade: "fades",
    low_fade: "fades",
    mid_fade: "fades",
    high_fade: "fades",
    fade: "fades",
    tapers: "fades",
    taper: "fades",
    kids_cuts: "haircuts",
    "kids cuts": "haircuts",
    kids: "haircuts",
    haircut: "haircuts",
    cuts: "haircuts",
    designs: "lineups",
    design: "lineups",
    lineup: "lineups",
    "line up": "lineups",
    "shape up": "lineups",
    shapeup: "lineups",
    "beard work": "beard",
    beards: "beard",
    goatee: "beard",
    braid: "braids",
    cornrows: "braids",
    twists: "braids",
    dreads: "locs",
    dreadlocks: "locs",
    locks: "locs",
    womens_styles: "styling",
    "women's styles": "styling",
    women: "styling",
    ladies: "styling",
    waves: "styling",
    silk_press: "styling",
    blowout: "styling",
    hair_color: "color",
    "hair color": "color",
    dye: "color",
    highlights: "color",
    balayage: "color",
    nail: "nails",
    manicure: "nails",
    pedicure: "nails",
    makeup: "beauty",
    lashes: "beauty",
    brows: "beauty",
    other: "haircuts",
  };

  if (aliases[compact]) return aliases[compact];
  if (aliases[v]) return aliases[v];

  for (const [key, id] of Object.entries(aliases)) {
    if (v.includes(key.replace(/_/g, " ")) || compact.includes(key)) return id;
  }

  for (const cat of DISCOVER_STYLE_CATEGORIES) {
    if (v.includes(cat.id) || v.includes(cat.label.toLowerCase())) return cat.id;
  }

  return "haircuts";
}

/** Match haystack text / assigned category to a Discover filter chip. */
export function matchesDiscoverCategoryFilter(styleCategory, fields = {}) {
  if (!styleCategory) return true;
  const want = normalizeDiscoverCategory(styleCategory);
  const assignedRaw = fields.styleCategory || fields.category;
  if (assignedRaw != null && String(assignedRaw).trim() !== "") {
    return normalizeDiscoverCategory(assignedRaw) === want;
  }

  const hay = [fields.name, fields.title, fields.serviceName, fields.caption]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!hay) return false;
  return normalizeDiscoverCategory(hay) === want;
}

export function bustImageCacheUrl(url, versionHint) {
  const raw = String(url || "").trim();
  if (!raw || raw.startsWith("data:")) return raw;
  try {
    const u = new URL(raw, "https://ifcdcbarbersapp.com");
    const v = versionHint != null ? String(versionHint) : String(Date.now());
    u.searchParams.set("v", v);
    if (raw.startsWith("http://") || raw.startsWith("https://")) return u.toString();
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    const sep = raw.includes("?") ? "&" : "?";
    return `${raw}${sep}v=${encodeURIComponent(String(versionHint || Date.now()))}`;
  }
}
