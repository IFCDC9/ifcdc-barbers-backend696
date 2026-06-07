/** Offline fallback when service catalog API is unreachable (same as TestFlight). */
export const DEFAULT_BOOKING_SERVICES = [
  { id: "local-regular-haircut", name: "Regular Haircut", description: "Classic cut and style", price: 25, duration_minutes: 30, icon: "✂️" },
  { id: "local-fade", name: "Fade", description: "Clean fade with crisp lines", price: 30, duration_minutes: 30, icon: "💈" },
  { id: "local-beard-trim", name: "Beard Trim", description: "Shape and trim beard", price: 15, duration_minutes: 15, icon: "🧔" },
  { id: "local-kids-cut", name: "Kids Cut", description: "Haircut for children 12 and under", price: 20, duration_minutes: 30, icon: "👦" },
  { id: "local-line-up", name: "Line Up", description: "Edge-up and line refinement", price: 12, duration_minutes: 15, icon: "📐" },
  { id: "local-haircut-beard", name: "Haircut + Beard", description: "Full haircut with beard trim", price: 40, duration_minutes: 45, icon: "⭐" },
];
