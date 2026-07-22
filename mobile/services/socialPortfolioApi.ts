import { apiFetch } from "./api";
import { apiFullUrl } from "../constants/config";
import { ensureValidAppToken } from "./appSession";

export type PortfolioCategory = { id: string; label: string };

export type PortfolioPhoto = {
  id: string;
  photoUrl: string;
  thumbnailUrl: string;
  caption: string;
  title?: string;
  photoType: string;
  styleCategory: string | null;
  source?: string;
  canEdit?: boolean;
  isPrimary?: boolean;
  is30DayFollowup: boolean;
  parentPhotoId: string | null;
  likeCount: number;
  likedByViewer: boolean;
  barberName?: string;
  barberSlug?: string;
  barberId?: string;
  serviceId?: string | null;
  serviceName?: string;
  price?: number | null;
  durationMinutes?: number | null;
};

export type PortfolioReview = {
  id: string;
  bookingId: string | null;
  barberId: string;
  rating: number;
  comment: string;
  customerName: string;
  verifiedClient: boolean;
  createdAt: string | null;
  barberReply?: string;
  barberReplyAt?: string | null;
  photos: PortfolioPhoto[];
};

export type PortfolioBadge = { key: string; label: string; description: string };

export type BarberPortfolio = {
  id: string;
  slug: string;
  name: string;
  headline: string;
  bio: string;
  profileImage: string;
  yearsExperience: number | null;
  averageRating: number;
  reviewCount: number;
  followerCount: number;
  isFollowing: boolean;
  badges: PortfolioBadge[];
  shop: {
    name: string;
    address: string;
    city: string;
    state: string;
    phone: string;
    locationLabel: string;
  };
  services: Array<{
    id: string | number;
    name: string;
    description: string;
    price: number | null;
    durationMinutes: number | null;
    icon: string;
    imageUrl: string;
  }>;
  reviews: PortfolioReview[];
  gallery: PortfolioPhoto[];
  bookable: boolean;
  publicUrl: string;
};

export type ReviewStatus = {
  ok: boolean;
  canReview: boolean;
  hasReview: boolean;
  reviewId: string | null;
  canEdit?: boolean;
  canDelete?: boolean;
  editWindowEndsAt?: string | null;
  rating?: number | null;
  comment?: string;
  reason?: string;
};

export type FollowupReminder = {
  id: string;
  bookingId: string;
  barberId: string;
  barberName: string;
  service: string;
  appointmentDate: string | null;
  reviewId: string | null;
  remindAt: string | null;
  status: string;
  due: boolean;
};

export type ContentReport = {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  details: string;
  reporterUserId: string | null;
  createdAt: string | null;
};

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { message?: string; error?: string };
  if (!res.ok) {
    throw new Error(String(data?.message || data?.error || `HTTP ${res.status}`));
  }
  return data;
}

export async function fetchPortfolioCategories(): Promise<PortfolioCategory[]> {
  const res = await apiFetch("/api/portfolio/meta/categories", { auth: false });
  const data = await parseJson<{ categories: PortfolioCategory[] }>(res);
  return data.categories || [];
}

export async function fetchBarberPortfolio(slugOrId: string): Promise<BarberPortfolio> {
  const res = await apiFetch(`/api/portfolio/${encodeURIComponent(slugOrId)}`, { auth: false });
  const data = await parseJson<{ portfolio: BarberPortfolio }>(res);
  if (!data.portfolio) throw new Error("Portfolio not found.");
  return data.portfolio;
}

export async function fetchDiscoverPhotos(
  styleCategory?: string,
  limit = 100,
): Promise<PortfolioPhoto[]> {
  const cap = Math.min(Math.max(limit, 1), 100);
  const q = styleCategory
    ? `?styleCategory=${encodeURIComponent(styleCategory)}&limit=${cap}`
    : `?limit=${cap}`;
  // Prefer auth so staff get canEdit flags; still works anonymously.
  const res = await apiFetch(`/api/portfolio/discover${q}`);
  const data = await parseJson<{ photos: PortfolioPhoto[] }>(res);
  return data.photos || [];
}

export async function patchDiscoverPhoto(
  photoId: string,
  body: {
    title?: string;
    caption?: string;
    description?: string;
    styleCategory?: string;
    category?: string;
    status?: "published" | "hidden";
    setCover?: boolean;
  },
): Promise<{ ok: boolean }> {
  const res = await apiFetch(`/api/portfolio/discover/${encodeURIComponent(photoId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export async function hideDiscoverPhoto(photoId: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`/api/portfolio/discover/${encodeURIComponent(photoId)}/hide`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return parseJson(res);
}

export async function setDiscoverPhotoCover(photoId: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`/api/portfolio/discover/${encodeURIComponent(photoId)}/cover`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return parseJson(res);
}

export async function deleteDiscoverPhoto(photoId: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`/api/portfolio/discover/${encodeURIComponent(photoId)}`, {
    method: "DELETE",
  });
  return parseJson(res);
}

export async function replaceDiscoverPhotoImage(
  photoId: string,
  asset: { uri: string; name?: string; type?: string },
): Promise<{ ok: boolean; imageUrl?: string }> {
  const token = await ensureValidAppToken().catch(() => null);
  const form = new FormData();
  form.append("image", {
    uri: asset.uri,
    name: asset.name || "photo.jpg",
    type: asset.type || "image/jpeg",
  } as unknown as Blob);
  const res = await fetch(apiFullUrl(`/api/portfolio/discover/${encodeURIComponent(photoId)}/image`), {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  return parseJson(res);
}

export async function fetchBookingReviewStatus(bookingId: string): Promise<ReviewStatus> {
  const res = await apiFetch(`/api/bookings/${encodeURIComponent(bookingId)}/review-status`);
  return parseJson<ReviewStatus>(res);
}

export async function fetchFollowupReminders(): Promise<FollowupReminder[]> {
  const res = await apiFetch("/api/me/followup-reminders");
  const data = await parseJson<{ reminders: FollowupReminder[] }>(res);
  return data.reminders || [];
}

export async function submitBookingReview(
  bookingId: string,
  body: { rating: number; comment?: string; photos?: Array<{ photoUrl: string; photoType?: string; styleCategory?: string; caption?: string }> },
): Promise<PortfolioReview> {
  const res = await apiFetch(`/api/bookings/${encodeURIComponent(bookingId)}/review`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = await parseJson<{ review: PortfolioReview }>(res);
  return data.review;
}

export async function updateCustomerReview(
  reviewId: string,
  body: { rating: number; comment?: string },
): Promise<PortfolioReview> {
  const res = await apiFetch(`/api/reviews/${encodeURIComponent(reviewId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  const data = await parseJson<{ review: PortfolioReview }>(res);
  return data.review;
}

export async function deleteCustomerReview(reviewId: string): Promise<void> {
  await apiFetch(`/api/reviews/${encodeURIComponent(reviewId)}`, { method: "DELETE" });
}

export async function uploadReviewPhoto(
  reviewId: string,
  localUri: string,
  opts: {
    barberName?: string;
    photoType?: string;
    styleCategory?: string;
    caption?: string;
    is30DayFollowup?: boolean;
    parentPhotoId?: string;
  } = {},
): Promise<PortfolioPhoto[]> {
  const token = await ensureValidAppToken();
  const form = new FormData();
  const filename = localUri.split("/").pop() || "haircut.jpg";
  form.append("files", { uri: localUri, name: filename, type: "image/jpeg" } as unknown as Blob);
  if (opts.barberName) form.append("barberName", opts.barberName);
  if (opts.photoType) form.append("photoType", opts.photoType);
  if (opts.styleCategory) form.append("styleCategory", opts.styleCategory);
  if (opts.caption) form.append("caption", opts.caption);
  if (opts.is30DayFollowup) form.append("is30DayFollowup", "true");
  if (opts.parentPhotoId) form.append("parentPhotoId", opts.parentPhotoId);

  const url = apiFullUrl(`/api/reviews/${encodeURIComponent(reviewId)}/photos`);
  const res = await fetch(url, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const data = await parseJson<{ photos: PortfolioPhoto[] }>(res);
  return data.photos || [];
}

export async function togglePortfolioPhotoLike(
  photoId: string,
): Promise<{ liked: boolean; likeCount?: number }> {
  const token = await ensureValidAppToken();
  if (!token) {
    throw new Error("Sign in to like photos.");
  }

  const url = apiFullUrl(`/api/photos/${encodeURIComponent(photoId)}/like`);
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let data: { ok?: boolean; liked?: boolean; likeCount?: number; message?: string; code?: string } = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-json body */
  }

  if (!res.ok) {
    const msg =
      String(data.message || "").trim() ||
      (res.status === 401 ? "Session expired. Sign in again." : "Could not update like. Try again.");
    console.warn("[portfolio-like]", res.status, photoId, data.code || msg);
    throw new Error(msg);
  }

  return {
    liked: Boolean(data.liked),
    likeCount: data.likeCount != null ? Number(data.likeCount) : undefined,
  };
}

export async function followPortfolioBarber(barberId: string): Promise<void> {
  await apiFetch(`/api/barbers/${encodeURIComponent(barberId)}/follow`, { method: "POST" });
}

export async function unfollowPortfolioBarber(barberId: string): Promise<void> {
  await apiFetch(`/api/barbers/${encodeURIComponent(barberId)}/follow`, { method: "DELETE" });
}

export async function reportPortfolioContent(body: {
  targetType: "review" | "photo";
  targetId: string;
  reason: string;
  details?: string;
}): Promise<void> {
  await apiFetch("/api/content/report", { method: "POST", body: JSON.stringify(body) });
}

export async function replyToPortfolioReview(reviewId: string, reply: string): Promise<PortfolioReview> {
  const res = await apiFetch(`/api/reviews/${encodeURIComponent(reviewId)}/reply`, {
    method: "POST",
    body: JSON.stringify({ reply }),
  });
  const data = await parseJson<{ review: PortfolioReview }>(res);
  return data.review;
}

export async function fetchContentReports(): Promise<ContentReport[]> {
  const res = await apiFetch("/api/admin/content/reports");
  const data = await parseJson<{ reports: ContentReport[] }>(res);
  return data.reports || [];
}

export async function resolveContentReport(
  reportId: string,
  body: { status: string; adminNotes?: string },
): Promise<void> {
  await apiFetch(`/api/admin/content/reports/${encodeURIComponent(reportId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function hideReview(reviewId: string): Promise<void> {
  await apiFetch(`/api/admin/reviews/${encodeURIComponent(reviewId)}/visibility`, {
    method: "PATCH",
    body: JSON.stringify({ status: "hidden" }),
  });
}

export async function removeReview(reviewId: string, reason = "policy_violation"): Promise<void> {
  await apiFetch(`/api/admin/reviews/${encodeURIComponent(reviewId)}`, {
    method: "DELETE",
    body: JSON.stringify({ reason }),
  });
}

export async function restoreReview(reviewId: string, reason = "restored"): Promise<void> {
  await apiFetch(`/api/admin/reviews/${encodeURIComponent(reviewId)}/restore`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export async function clearPortfolioReply(reviewId: string): Promise<PortfolioReview> {
  const res = await apiFetch(`/api/reviews/${encodeURIComponent(reviewId)}/reply`, { method: "DELETE" });
  const data = await parseJson<{ review: PortfolioReview }>(res);
  return data.review;
}

export async function hidePhoto(photoId: string): Promise<void> {
  await apiFetch(`/api/admin/photos/${encodeURIComponent(photoId)}/visibility`, {
    method: "PATCH",
    body: JSON.stringify({ status: "hidden" }),
  });
}

export function portfolioShareUrl(slug: string): string {
  return `https://ifcdcbarbersapp.com/p/${slug}`;
}
