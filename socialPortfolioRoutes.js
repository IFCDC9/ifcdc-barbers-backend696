import express from "express";
import multer from "multer";
import { resolveAuthPayload, requireAuth } from "./authRoutes.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { uploadPortfolioPhoto } from "./src/services/storageUpload.js";
import {
  HAIRCUT_STYLE_CATEGORIES,
  CONTENT_REPORT_REASONS,
} from "./socialPortfolioConstants.js";
import {
  addReviewPhotos,
  createBarberReview,
  deleteCustomerReview,
  followBarber,
  getBookingReviewStatus,
  getPublicBarberPortfolio,
  listCustomerFollowupReminders,
  listDiscoverPhotos,
  listPendingContentReports,
  listReviewableBookings,
  reportContent,
  resolveContentReport,
  setPhotoVisibility,
  setReviewVisibility,
  togglePhotoLike,
  unfollowBarber,
  updateCustomerReview,
} from "./socialPortfolioService.js";
import { logAdminActivity, ADMIN_ACTIVITY } from "./adminActivityLog.js";

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

function optionalAuth(req) {
  const hdr = String(req.get("authorization") || "");
  const token = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice(7).trim() : "";
  if (!token) return null;
  return resolveAuthPayload(token);
}

async function requirePlatformAdmin(req, res) {
  const payload = optionalAuth(req);
  if (!payload) {
    res.status(401).json({ ok: false, message: "Missing Bearer token" });
    return null;
  }
  const role = String(payload.role || "").toLowerCase();
  if (!isJwtGlobalSuperScope(payload) && role !== "admin") {
    res.status(403).json({ ok: false, message: "Platform admin only." });
    return null;
  }
  return payload;
}

export function createSocialPortfolioRouter() {
  const router = express.Router();

  router.get("/api/portfolio/meta/categories", (_req, res) => {
    return res.json({ ok: true, categories: HAIRCUT_STYLE_CATEGORIES, reportReasons: CONTENT_REPORT_REASONS });
  });

  router.get("/api/portfolio/discover", async (req, res) => {
    try {
      const viewer = optionalAuth(req);
      const result = await listDiscoverPhotos({
        styleCategory: req.query.styleCategory || req.query.category || null,
        limit: req.query.limit,
        viewerUserId: viewer?.id || null,
      });
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      console.error("[portfolio] discover failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load discovery feed." });
    }
  });

  router.get("/api/portfolio/:slugOrId", async (req, res) => {
    try {
      const viewer = optionalAuth(req);
      const result = await getPublicBarberPortfolio(req.params.slugOrId, {
        viewerUserId: viewer?.id || null,
      });
      if (!result.ok) return res.status(404).json(result);
      res.set("Cache-Control", "public, max-age=60");
      return res.json(result);
    } catch (e) {
      console.error("[portfolio] public profile failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load portfolio." });
    }
  });

  router.get("/api/me/reviewable-bookings", requireAuth, async (req, res) => {
    try {
      const bookings = await listReviewableBookings(req.user.id);
      return res.json({ ok: true, bookings });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to load reviewable bookings." });
    }
  });

  router.get("/api/me/followup-reminders", requireAuth, async (req, res) => {
    try {
      const reminders = await listCustomerFollowupReminders(req.user.id);
      return res.json({ ok: true, reminders });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to load follow-up reminders." });
    }
  });

  router.get("/api/bookings/:bookingId/review-status", requireAuth, async (req, res) => {
    try {
      const result = await getBookingReviewStatus(req.user.id, req.params.bookingId);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to load review status." });
    }
  });

  router.post("/api/bookings/:bookingId/review", requireAuth, async (req, res) => {
    try {
      const photos = Array.isArray(req.body?.photos) ? req.body.photos : [];
      const result = await createBarberReview({
        userId: req.user.id,
        bookingId: req.params.bookingId,
        rating: req.body?.rating,
        comment: req.body?.comment,
        photos,
      });
      if (!result.ok) return res.status(400).json(result);
      return res.status(201).json(result);
    } catch (e) {
      console.error("[portfolio] create review failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to submit review." });
    }
  });

  router.patch("/api/reviews/:reviewId", requireAuth, async (req, res) => {
    try {
      const result = await updateCustomerReview({
        userId: req.user.id,
        reviewId: req.params.reviewId,
        rating: req.body?.rating,
        comment: req.body?.comment,
      });
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      console.error("[portfolio] update review failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update review." });
    }
  });

  router.delete("/api/reviews/:reviewId", requireAuth, async (req, res) => {
    try {
      const result = await deleteCustomerReview(req.user.id, req.params.reviewId);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      console.error("[portfolio] delete review failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to delete review." });
    }
  });

  router.post(
    "/api/reviews/:reviewId/photos",
    requireAuth,
    uploadMemory.array("files", 5),
    async (req, res) => {
      try {
        const barberName = String(req.body?.barberName || "customer-review");
        const photoType = req.body?.photoType || "after";
        const styleCategory = req.body?.styleCategory || null;
        const caption = req.body?.caption || "";
        const is30DayFollowup = String(req.body?.is30DayFollowup || "").toLowerCase() === "true";
        const parentPhotoId = req.body?.parentPhotoId || null;

        const uploaded = [];
        for (const file of req.files || []) {
          const optimized = await uploadPortfolioPhoto({
            buffer: file.buffer,
            mimetype: file.mimetype,
            originalName: file.originalname,
            barberName: `${barberName}-reviews`,
          });
          uploaded.push({
            photoUrl: optimized.photoUrl,
            thumbnailUrl: optimized.thumbnailUrl,
            caption,
            photoType,
            styleCategory,
            is30DayFollowup,
            parentPhotoId,
          });
        }

        if (!uploaded.length && req.body?.photoUrl) {
          uploaded.push({
            photoUrl: req.body.photoUrl,
            thumbnailUrl: req.body.thumbnailUrl || req.body.photoUrl,
            caption,
            photoType,
            styleCategory,
            is30DayFollowup,
            parentPhotoId,
          });
        }

        const result = await addReviewPhotos({
          userId: req.user.id,
          reviewId: req.params.reviewId,
          photos: uploaded,
        });
        if (!result.ok) return res.status(400).json(result);
        return res.status(201).json(result);
      } catch (e) {
        console.error("[portfolio] add review photos failed:", e?.message || e);
        return res.status(500).json({ ok: false, message: "Failed to upload photos." });
      }
    },
  );

  router.post("/api/photos/:photoId/like", requireAuth, async (req, res) => {
    const photoId = String(req.params.photoId || "");
    try {
      const result = await togglePhotoLike(req.user.id, photoId);
      if (!result.ok) {
        console.warn("[portfolio] like rejected:", {
          userId: req.user.id,
          photoId,
          code: result.code,
          message: result.message,
        });
        return res.status(400).json(result);
      }
      return res.json(result);
    } catch (e) {
      console.error("[portfolio] like failed:", {
        userId: req.user?.id,
        photoId,
        error: e?.message || e,
      });
      return res.status(500).json({ ok: false, message: "Failed to update like.", code: "like_server_error" });
    }
  });

  router.post("/api/barbers/:barberId/follow", requireAuth, async (req, res) => {
    try {
      const result = await followBarber(req.user.id, req.params.barberId);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to follow barber." });
    }
  });

  router.delete("/api/barbers/:barberId/follow", requireAuth, async (req, res) => {
    try {
      return res.json(await unfollowBarber(req.user.id, req.params.barberId));
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to unfollow barber." });
    }
  });

  router.post("/api/content/report", requireAuth, async (req, res) => {
    try {
      const result = await reportContent({
        userId: req.user.id,
        targetType: req.body?.targetType,
        targetId: req.body?.targetId,
        reason: req.body?.reason,
        details: req.body?.details,
      });
      if (!result.ok) return res.status(400).json(result);
      return res.status(201).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to submit report." });
    }
  });

  router.get("/api/admin/content/reports", async (req, res) => {
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    try {
      const reports = await listPendingContentReports();
      return res.json({ ok: true, reports });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to load reports." });
    }
  });

  router.patch("/api/admin/content/reports/:id", async (req, res) => {
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    try {
      const result = await resolveContentReport(req.params.id, {
        status: req.body?.status,
        adminNotes: req.body?.adminNotes,
        adminUserId: admin.id,
      });
      if (!result.ok) return res.status(400).json(result);
      void logAdminActivity({
        eventType: ADMIN_ACTIVITY.CONTENT_MODERATED,
        adminUserId: admin.id,
        detail: `Content report ${req.params.id} → ${req.body?.status}`,
        metadata: { reportId: req.params.id, status: req.body?.status },
        req,
      });
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to resolve report." });
    }
  });

  router.patch("/api/admin/reviews/:id/visibility", async (req, res) => {
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    try {
      const result = await setReviewVisibility(req.params.id, req.body?.status);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to update review." });
    }
  });

  router.patch("/api/admin/photos/:id/visibility", async (req, res) => {
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    try {
      const result = await setPhotoVisibility(req.params.id, req.body?.status);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to update photo." });
    }
  });

  return router;
}
