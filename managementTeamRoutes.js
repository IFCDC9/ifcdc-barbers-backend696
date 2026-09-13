/**
 * Management Team API — Super Admin CRUD + manager self-context + activity logs.
 */
import express from "express";
import { resolveAuthPayload } from "./authRoutes.js";
import { ensureManagementTeamSchema } from "./managementTeamMigrations.js";
import {
  requireSuperAdminActor,
  validateAssignmentPayload,
  loadActiveManagementContext,
  ensureManagementLinkedToUser,
} from "./managementTeamAuth.js";
import {
  createManagementAssignment,
  updateManagementAssignment,
  setManagementAssignmentStatus,
  listManagementTeam,
  getManagementAssignment,
  findUserCandidates,
  listShopsForAssignment,
  listLocationsForAssignment,
  managementTeamMeta,
  sanitizePermissionPatch,
} from "./managementTeamService.js";
import { listManagementActivityLogs } from "./managementActivityLog.js";

function bearerPayload(req, res) {
  const hdr = String(req.get("authorization") || "");
  const token = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice("bearer ".length).trim() : "";
  if (!token) {
    res.status(401).json({ ok: false, message: "Missing Bearer token" });
    return null;
  }
  const payload = resolveAuthPayload(token);
  if (!payload) {
    res.status(401).json({ ok: false, message: "Invalid or expired token" });
    return null;
  }
  req.user = payload;
  return payload;
}

export function createManagementTeamRouter() {
  const router = express.Router();

  router.use(async (_req, _res, next) => {
    try {
      await ensureManagementTeamSchema();
    } catch (e) {
      console.warn("[management-team] schema ensure:", e?.message || e);
    }
    next();
  });

  router.get("/api/admin/management-team/meta", async (req, res) => {
    const payload = bearerPayload(req, res);
    if (!payload) return;
    if (!requireSuperAdminActor(payload, res)) return;
    return res.json({ ok: true, ...managementTeamMeta() });
  });

  router.get("/api/admin/management-team", async (req, res) => {
    const payload = bearerPayload(req, res);
    if (!payload) return;
    if (!requireSuperAdminActor(payload, res)) return;
    try {
      const includeRemoved = String(req.query.includeRemoved || "") === "1";
      const managers = await listManagementTeam({ includeRemoved });
      return res.json({ ok: true, managers });
    } catch (e) {
      console.error("[management-team] list failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to list management team." });
    }
  });

  router.get("/api/admin/management-team/users/search", async (req, res) => {
    const payload = bearerPayload(req, res);
    if (!payload) return;
    if (!requireSuperAdminActor(payload, res)) return;
    try {
      const users = await findUserCandidates(req.query.q || "");
      return res.json({ ok: true, users });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "User search failed." });
    }
  });

  router.get("/api/admin/management-team/shops", async (req, res) => {
    const payload = bearerPayload(req, res);
    if (!payload) return;
    if (!requireSuperAdminActor(payload, res)) return;
    try {
      const shops = await listShopsForAssignment();
      return res.json({ ok: true, shops });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to list shops." });
    }
  });

  router.get("/api/admin/management-team/locations", async (req, res) => {
    const payload = bearerPayload(req, res);
    if (!payload) return;
    if (!requireSuperAdminActor(payload, res)) return;
    try {
      const businessIds = String(req.query.businessIds || "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter(Number.isFinite);
      const locations = await listLocationsForAssignment({
        businessIds: businessIds.length ? businessIds : null,
      });
      return res.json({ ok: true, locations });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to list locations." });
    }
  });

  router.get("/api/admin/management-team/activity", async (req, res) => {
    const payload = bearerPayload(req, res);
    if (!payload) return;
    if (!requireSuperAdminActor(payload, res)) return;
    try {
      const logs = await listManagementActivityLogs({
        limit: req.query.limit,
        offset: req.query.offset,
        actorUserId: req.query.actorUserId || null,
        businessId: req.query.businessId || null,
        action: req.query.action || null,
      });
      return res.json({ ok: true, logs });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to load activity logs." });
    }
  });

  router.get("/api/admin/management-team/:assignmentId", async (req, res) => {
    const payload = bearerPayload(req, res);
    if (!payload) return;
    if (!requireSuperAdminActor(payload, res)) return;
    try {
      const assignment = await getManagementAssignment(req.params.assignmentId);
      if (!assignment) return res.status(404).json({ ok: false, message: "Not found." });
      return res.json({ ok: true, assignment });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to load assignment." });
    }
  });

  router.post("/api/admin/management-team", async (req, res) => {
    const payload = bearerPayload(req, res);
    if (!payload) return;
    if (!requireSuperAdminActor(payload, res)) return;

    const validated = validateAssignmentPayload(req.body || {});
    if (!validated.ok) return res.status(400).json({ ok: false, message: validated.message });

    try {
      const result = await createManagementAssignment({
        actorUserId: payload.id,
        actorEmail: payload.email,
        userId: req.body?.userId || null,
        email: req.body?.email || null,
        name: req.body?.name || null,
        phone: req.body?.phone || null,
        createIfMissing: req.body?.createIfMissing === true,
        password: req.body?.password || null,
        role: validated.role,
        shopIds: validated.shopIds,
        locationIds: validated.locationIds,
        permissions: sanitizePermissionPatch(validated.permissions),
        fullAccess:
          validated.fullAccess ||
          validated.permissions?.full_manager_access === true,
        notes: req.body?.notes || null,
        req,
      });
      if (!result.ok) {
        return res.status(result.status || 400).json({
          ok: false,
          message: result.message,
          assignmentId: result.assignmentId,
        });
      }
      return res.status(201).json({
        ok: true,
        assignment: result.assignment,
        createdUser: result.createdUser,
        temporaryPassword: result.temporaryPassword || undefined,
      });
    } catch (e) {
      console.error("[management-team] create failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to create manager assignment." });
    }
  });

  router.patch("/api/admin/management-team/:assignmentId", async (req, res) => {
    const payload = bearerPayload(req, res);
    if (!payload) return;
    if (!requireSuperAdminActor(payload, res)) return;

    const body = req.body || {};
    if (body.role || body.shopIds || body.locationIds) {
      const validated = validateAssignmentPayload({
        role: body.role,
        shopIds: body.shopIds,
        locationIds: body.locationIds,
        permissions: body.permissions,
        fullAccess: body.fullAccess,
      });
      // Allow partial updates: if role omitted, skip full validate shop rules by merging later in service
      if (body.role && !validated.ok) {
        return res.status(400).json({ ok: false, message: validated.message });
      }
    }

    try {
      const result = await updateManagementAssignment({
        assignmentId: req.params.assignmentId,
        actorUserId: payload.id,
        actorEmail: payload.email,
        role: body.role,
        shopIds: body.shopIds,
        locationIds: body.locationIds,
        permissions: body.permissions ? sanitizePermissionPatch(body.permissions) : undefined,
        fullAccess: typeof body.fullAccess === "boolean" ? body.fullAccess : undefined,
        notes: body.notes,
        req,
      });
      if (!result.ok) {
        return res.status(result.status || 400).json({ ok: false, message: result.message });
      }
      return res.json({ ok: true, assignment: result.assignment });
    } catch (e) {
      console.error("[management-team] update failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update manager." });
    }
  });

  router.post("/api/admin/management-team/:assignmentId/suspend", async (req, res) => {
    const payload = bearerPayload(req, res);
    if (!payload) return;
    if (!requireSuperAdminActor(payload, res)) return;
    const result = await setManagementAssignmentStatus({
      assignmentId: req.params.assignmentId,
      status: "suspended",
      actorUserId: payload.id,
      actorEmail: payload.email,
      req,
    });
    if (!result.ok) return res.status(result.status || 400).json({ ok: false, message: result.message });
    return res.json({ ok: true, assignment: result.assignment });
  });

  router.post("/api/admin/management-team/:assignmentId/reactivate", async (req, res) => {
    const payload = bearerPayload(req, res);
    if (!payload) return;
    if (!requireSuperAdminActor(payload, res)) return;
    const existing = await getManagementAssignment(req.params.assignmentId);
    const restoringRemoved = existing?.status === "removed";
    const confirmRestore =
      req.body?.confirmRestore === true || req.body?.allowRestoreRemoved === true;
    if (restoringRemoved && !confirmRestore) {
      return res.status(409).json({
        ok: false,
        error: "explicit_restore_required",
        message:
          "This assignment is removed. Super Admin must send confirmRestore=true to restore it.",
      });
    }
    const result = await setManagementAssignmentStatus({
      assignmentId: req.params.assignmentId,
      status: "active",
      actorUserId: payload.id,
      actorEmail: payload.email,
      req,
      allowRestoreRemoved: restoringRemoved && confirmRestore,
    });
    if (!result.ok) return res.status(result.status || 400).json({ ok: false, message: result.message });
    return res.json({ ok: true, assignment: result.assignment });
  });

  router.post("/api/admin/management-team/:assignmentId/remove", async (req, res) => {
    const payload = bearerPayload(req, res);
    if (!payload) return;
    if (!requireSuperAdminActor(payload, res)) return;
    const result = await setManagementAssignmentStatus({
      assignmentId: req.params.assignmentId,
      status: "removed",
      actorUserId: payload.id,
      actorEmail: payload.email,
      req,
    });
    if (!result.ok) return res.status(result.status || 400).json({ ok: false, message: result.message });
    return res.json({ ok: true, assignment: result.assignment });
  });

  /** Authenticated manager: current scope + permissions (never Super Admin secrets). */
  router.get("/api/management/me", async (req, res) => {
    const payload = bearerPayload(req, res);
    if (!payload) return;
    try {
      const management =
        (await ensureManagementLinkedToUser({
          userId: payload.id,
          email: payload.email,
        })) || (await loadActiveManagementContext(payload.id));
      return res.json({
        ok: true,
        isSuperAdmin: payload.isSuperAdmin === true,
        management: management
          ? {
              assignmentId: management.assignmentId,
              role: management.role,
              status: management.status,
              shopIds: management.shopIds,
              locationIds: management.locationIds,
              permissions: management.permissions,
            }
          : null,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to load management context." });
    }
  });

  return router;
}
