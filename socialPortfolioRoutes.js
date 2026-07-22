import express from "express";
import multer from "multer";
import { resolveAuthPayload, requireAuth } from "./authRoutes.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { uploadPortfolioPhoto, uploadBarberStyleImage } from "./src/services/storageUpload.js";
import {
  HAIRCUT_STYLE_CATEGORIES,
  CONTENT_REPORT_REASONS,
} from "./socialPortfolioConstants.js";
import {
  addReviewPhotos,
  adminDeleteReview,
  assertCanManageDiscoverPhoto,
  clearBarberReply,
  createBarberReview,
  deleteCustomerReview,
  deleteDiscoverPhoto,
  followBarber,
  getBookingReviewStatus,
  getPublicBarberPortfolio,
  listAdminReviews,
  listCustomerFollowupReminders,
  listDiscoverPhotos,
  listPendingContentReports,
  listReviewableBookings,
  replaceDiscoverPhotoImage,
  replyToBarberReview,
  reportContent,
  resolveContentReport,
  restoreReview,
  setDiscoverPhotoCover,
  setDiscoverPhotoVisibility,
  setPhotoVisibility,
  setReviewVisibility,
  togglePhotoLike,
  unfollowBarber,
  updateCustomerReview,
  updateDiscoverPhotoMetadata,
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

async function requireDiscoverEditor(req, res) {
  const payload = optionalAuth(req);
  if (!payload) {
    res.status(401).json({ ok: false, message: "Sign in required." });
    return null;
  }
  const role = String(payload.role || "").toLowerCase();
  if (
    !isJwtGlobalSuperScope(payload) &&
    !["admin", "super_admin", "barber", "shop_owner"].includes(role)
  ) {
    res.status(403).json({ ok: false, message: "Staff only." });
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
        viewer,
      });
      if (!result.ok) return res.status(400).json(result);
      res.set("Cache-Control", "no-store, no-cache, must-revalidate");
      return res.json(result);
    } catch (e) {
      console.error("[portfolio] discover failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load discovery feed." });
    }
  });

  router.patch("/api/portfolio/discover/:photoId", async (req, res) => {
    try {
      const viewer = await requireDiscoverEditor(req, res);
      if (!viewer) return;
      const photoId = String(req.params.photoId || "").trim();
      const access = await assertCanManageDiscoverPhoto(viewer, photoId);
      if (!access.ok) return res.status(403).json(access);

      if (req.body?.status === "published" || req.body?.status === "hidden") {
        const vis = await setDiscoverPhotoVisibility(photoId, req.body.status);
        if (!vis.ok) return res.status(400).json(vis);
      }
      if (req.body?.setCover === true || req.body?.isPrimary === true) {
        const cover = await setDiscoverPhotoCover(photoId);
        if (!cover.ok) return res.status(400).json(cover);
      }
      const meta = await updateDiscoverPhotoMetadata(photoId, {
        title: req.body?.title,
        caption: req.body?.caption,
        description: req.body?.description,
        styleCategory: req.body?.styleCategory || req.body?.category,
      });
      if (!meta.ok) return res.status(400).json(meta);
      return res.json({ ok: true });
    } catch (e) {
      console.error("[portfolio] discover patch failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update photo." });
    }
  });

  router.post(
    "/api/portfolio/discover/:photoId/image",
    uploadMemory.single("image"),
    async (req, res) => {
      try {
        const viewer = await requireDiscoverEditor(req, res);
        if (!viewer) return;
        const photoId = String(req.params.photoId || "").trim();
        const access = await assertCanManageDiscoverPhoto(viewer, photoId);
        if (!access.ok) return res.status(403).json(access);
        const file = req.file;
        if (!file?.buffer) return res.status(400).json({ ok: false, message: "image file required" });
        const uploaded = await uploadBarberStyleImage({
          buffer: file.buffer,
          originalName: file.originalname,
          mimetype: file.mimetype,
          barberName: access.barberId || "discover",
        });
        const imageUrl =
          typeof uploaded === "string"
            ? uploaded
            : uploaded?.publicUrl || uploaded?.url || uploaded?.imageUrl || "";
        if (!imageUrl) return res.status(500).json({ ok: false, message: "Upload did not return a URL." });
        const result = await replaceDiscoverPhotoImage(photoId, imageUrl);
        if (!result.ok) return res.status(400).json(result);
        return res.json(result);
      } catch (e) {
        console.error("[portfolio] discover replace image failed:", e?.message || e);
        return res.status(500).json({ ok: false, message: "Failed to replace photo." });
      }
    },
  );

  router.post("/api/portfolio/discover/:photoId/cover", async (req, res) => {
    try {
      const viewer = await requireDiscoverEditor(req, res);
      if (!viewer) return;
      const photoId = String(req.params.photoId || "").trim();
      const access = await assertCanManageDiscoverPhoto(viewer, photoId);
      if (!access.ok) return res.status(403).json(access);
      const result = await setDiscoverPhotoCover(photoId);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to set cover." });
    }
  });

  router.post("/api/portfolio/discover/:photoId/hide", async (req, res) => {
    try {
      const viewer = await requireDiscoverEditor(req, res);
      if (!viewer) return;
      const photoId = String(req.params.photoId || "").trim();
      const access = await assertCanManageDiscoverPhoto(viewer, photoId);
      if (!access.ok) return res.status(403).json(access);
      const result = await setDiscoverPhotoVisibility(photoId, "hidden");
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to hide photo." });
    }
  });

  router.delete("/api/portfolio/discover/:photoId", async (req, res) => {
    try {
      const viewer = await requireDiscoverEditor(req, res);
      if (!viewer) return;
      const photoId = String(req.params.photoId || "").trim();
      const access = await assertCanManageDiscoverPhoto(viewer, photoId);
      if (!access.ok) return res.status(403).json(access);
      const result = await deleteDiscoverPhoto(photoId);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to delete photo." });
    }
  });

  router.get("/api/portfolio/:slugOrId", async (req, res) => {
    try {
      const viewer = optionalAuth(req);
      const result = await getPublicBarberPortfolio(req.params.slugOrId, {
        viewerUserId: viewer?.id || null,
        reviewSort: req.query?.sort || req.query?.reviewSort || "newest",
        reviewLimit: req.query?.limit || 20,
        reviewOffset: req.query?.offset || 0,
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

  router.post("/api/reviews/:reviewId/reply", requireAuth, async (req, res) => {
    try {
      const result = await replyToBarberReview({
        userId: req.user.id,
        reviewId: req.params.reviewId,
        reply: req.body?.reply ?? req.body?.barberReply,
      });
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      console.error("[portfolio] reply review failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to save reply." });
    }
  });

  router.delete("/api/reviews/:reviewId/reply", requireAuth, async (req, res) => {
    try {
      const result = await clearBarberReply({
        userId: req.user.id,
        reviewId: req.params.reviewId,
      });
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to remove reply." });
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
      const result = await setReviewVisibility(req.params.id, req.body?.status, {
        adminUserId: admin.id,
        reason: req.body?.reason || req.body?.adminNotes || "",
      });
      if (!result.ok) return res.status(400).json(result);
      void logAdminActivity({
        eventType: ADMIN_ACTIVITY.CONTENT_MODERATED,
        adminUserId: admin.id,
        detail: `Review ${req.params.id} visibility → ${req.body?.status}`,
        metadata: { reviewId: req.params.id, status: req.body?.status },
        req,
      });
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to update review." });
    }
  });

  router.delete("/api/admin/reviews/:id", async (req, res) => {
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    try {
      const result = await adminDeleteReview(req.params.id, {
        adminUserId: admin.id,
        reason: req.body?.reason || req.body?.adminNotes || "policy_violation",
      });
      if (!result.ok) return res.status(400).json(result);
      void logAdminActivity({
        eventType: ADMIN_ACTIVITY.CONTENT_MODERATED,
        adminUserId: admin.id,
        detail: `Review ${req.params.id} removed`,
        metadata: { reviewId: req.params.id, action: "removed" },
        req,
      });
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to remove review." });
    }
  });

  router.post("/api/admin/reviews/:id/restore", async (req, res) => {
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    try {
      const result = await restoreReview(req.params.id, {
        adminUserId: admin.id,
        reason: req.body?.reason || "restored",
      });
      if (!result.ok) return res.status(400).json(result);
      void logAdminActivity({
        eventType: ADMIN_ACTIVITY.CONTENT_MODERATED,
        adminUserId: admin.id,
        detail: `Review ${req.params.id} restored`,
        metadata: { reviewId: req.params.id, action: "restored" },
        req,
      });
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to restore review." });
    }
  });

  router.get("/api/admin/reviews", async (req, res) => {
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    try {
      const result = await listAdminReviews({
        q: req.query?.q,
        status: req.query?.status,
        stars: req.query?.stars,
        hasPhotos: req.query?.hasPhotos,
        limit: req.query?.limit,
        offset: req.query?.offset,
      });
      return res.json(result);
    } catch (e) {
      console.error("[portfolio] admin reviews failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load reviews." });
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
