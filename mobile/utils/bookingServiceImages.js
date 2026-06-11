import { apiFullUrl } from '../constants/config';
import { isRenderableStyleImageUrl } from './styleImageUrl';

export function serviceNameKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize API row — same fields website booking uses. */
export function normalizeBookingService(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const image_url = String(
    raw.image_url || raw.imageUrl || raw.cover_image_url || raw.coverImageUrl || raw.image || '',
  ).trim();
  return { ...raw, image_url };
}

function stylePhotoUrl(style) {
  const direct = String(style?.image_url || style?.imageUrl || style?.image || '').trim();
  if (isRenderableStyleImageUrl(direct)) return direct;
  const images = Array.isArray(style?.images) ? style.images : [];
  for (const im of images) {
    const url = String(im?.url || im?.image_url || '').trim();
    if (isRenderableStyleImageUrl(url)) return url;
  }
  return '';
}

/** Gallery rows from /api/styles as extra bookable service cards (gal-* ids). */
export function appendGalleryStylesAsServices(services, styles, { barberId } = {}) {
  const list = (Array.isArray(services) ? services : []).map(normalizeBookingService);
  const published = Array.isArray(styles) ? styles : [];
  if (!published.length) return list;

  const bid = String(barberId || '').trim();
  const existingIds = new Set(list.map((s) => String(s.id)));
  const extras = [];

  for (const st of published) {
    const src = String(st.source || '');
    const sid = String(st.id || '');
    if (src !== 'barber_style_gallery' && !sid.startsWith('gal-')) continue;

    const stBarberId = String(st.barber_id ?? st.barberId ?? '').trim();
    if (bid && stBarberId && stBarberId !== bid) continue;
    if (existingIds.has(sid)) continue;

    const url = stylePhotoUrl(st);
    if (!isRenderableStyleImageUrl(url)) continue;

    extras.push(
      normalizeBookingService({
        id: sid,
        name: st.title || st.name || 'Style',
        description: st.description || '',
        price: st.price,
        duration_minutes: st.duration_minutes || 30,
        image_url: url,
        barber_id: stBarberId || bid,
      }),
    );
    existingIds.add(sid);
  }

  return [...list, ...extras];
}

/**
 * Merge published style photos onto booking services (website /api/styles parity).
 */
export function mergeServicePhotosFromStyles(services, styles, { barberId, barberName } = {}) {
  const list = (Array.isArray(services) ? services : []).map(normalizeBookingService);
  const published = Array.isArray(styles) ? styles : [];
  if (!list.length || !published.length) return list;

  const bid = String(barberId || '').trim();
  const bname = String(barberName || '').trim().toLowerCase();
  const styleByName = new Map();

  for (const st of published) {
    const stBarberId = String(st.barber_id ?? st.barberId ?? '').trim();
    const stBarberName = String(st.barber_name ?? st.barberName ?? '').trim().toLowerCase();
    if (bid && stBarberId && stBarberId !== bid) continue;
    if (!bid && bname && stBarberName && stBarberName !== bname) continue;

    const title = st.title || st.name || st.style_name || '';
    const key = serviceNameKey(title);
    const url = stylePhotoUrl(st);
    if (key && url && !styleByName.has(key)) styleByName.set(key, url);
  }

  return list.map((svc) => {
    const existing = String(svc.image_url || '').trim();
    if (isRenderableStyleImageUrl(existing)) return svc;
    const merged = styleByName.get(serviceNameKey(svc.name));
    return merged ? { ...svc, image_url: merged } : svc;
  });
}

/** Fetch GET /api/styles and merge photos onto services missing image_url. */
export async function enrichBookingServicesWithPublishedStyles(
  services,
  { barberId, barberName },
  fetchFn,
  timeoutMs = 8000,
) {
  const list = (Array.isArray(services) ? services : []).map(normalizeBookingService);
  if (!fetchFn) return list;

  try {
    const res = await fetchFn(apiFullUrl('/api/styles'), {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      timeoutMs,
    });
    if (!res?.ok) return list;
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    const styles = Array.isArray(json.styles) ? json.styles : [];
    const withPhotos = mergeServicePhotosFromStyles(list, styles, { barberId, barberName });
    return appendGalleryStylesAsServices(withPhotos, styles, { barberId, barberName });
  } catch {
    return list;
  }
}
