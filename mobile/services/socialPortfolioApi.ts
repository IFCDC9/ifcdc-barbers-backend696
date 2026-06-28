import { apiFetch } from "./api";
import { apiFullUrl } from "../constants/config";
import { getAuthToken } from "./authService";

export type PortfolioCategory = { id: string; label: string };

export type PortfolioPhoto = {
  id: string;
  photoUrl: string;
  thumbnailUrl: string;
  caption: string;
  photoType: string;
  styleCategory: string | null;
  is30DayFollowup: boolean;
  parentPhotoId: string | null;
  likeCount: number;
  likedByViewer: boolean;
  barberName?: string;
  barberSlug?: string;
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
  const res = await apiFetch(`/api/portfolio/${encodeURIComponent(slugOrId)}`);
  const data = await parseJson<{ portfolio: BarberPortfolio }>(res);
  if (!data.portfolio) throw new Error("Portfolio not found.");
  return data.portfolio;
}

export async function fetchDiscoverPhotos(styleCategory?: string): Promise<PortfolioPhoto[]> {
  const q = styleCategory ? `?styleCategory=${encodeURIComponent(styleCategory)}&limit=48` : "?limit=48";
  const res = await apiFetch(`/api/portfolio/discover${q}`);
  const data = await parseJson<{ photos: PortfolioPhoto[] }>(res);
  return data.photos || [];
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
  const token = await getAuthToken();
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

export async function togglePortfolioPhotoLike(photoId: string): Promise<{ liked: boolean }> {
  const res = await apiFetch(`/api/photos/${encodeURIComponent(photoId)}/like`, { method: "POST" });
  return parseJson<{ liked: boolean }>(res);
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

export async function hidePhoto(photoId: string): Promise<void> {
  await apiFetch(`/api/admin/photos/${encodeURIComponent(photoId)}/visibility`, {
    method: "PATCH",
    body: JSON.stringify({ status: "hidden" }),
  });
}

export function portfolioShareUrl(slug: string): string {
  return `https://ifcdcbarbersapp.com/p/${slug}`;
}
