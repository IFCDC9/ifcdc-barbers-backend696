import { logSupabaseKeyStatus } from "./src/config/supabaseEnv.js";
import { ensureBarberCmsSchema } from "./src/services/barberCmsStore.js";
import { ensureBarberProfilesTable } from "./src/services/barberProfileStore.js";
import { ensureBarberStylePhotosTable } from "./src/services/barberStylePhotoStore.js";

/**
 * Mount persistent media/CMS routes used by Admin, gallery, and mobile sync.
 * Call before legacy disk-based /api/styles router so CMS list routes take precedence.
 */
export async function mountProductionCms(app) {
  const { stylesRouter: cmsStylesRouter, imagesRouter } = await import("./src/routes/barberCmsRoutes.js");
  const barberProfileApiRoutes = (await import("./src/routes/barberProfileApiRoutes.js")).default;
  const barberStyleRoutes = (await import("./src/routes/barberStyleRoutes.js")).default;
  const uploadRoutes = (await import("./src/routes/uploadRoutes.js")).default;

  await ensureBarberProfilesTable();
  await ensureBarberCmsSchema();
  await ensureBarberStylePhotosTable();
  logSupabaseKeyStatus();

  app.use("/api/upload", uploadRoutes);
  app.use("/api/images", imagesRouter);
  app.use("/api/barbers", barberStyleRoutes);
  app.use("/api/barbers", barberProfileApiRoutes);

  return { cmsStylesRouter };
}
