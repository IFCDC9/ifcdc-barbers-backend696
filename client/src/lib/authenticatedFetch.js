/**
 * Authenticated fetch — re-exports from appSession (wake API, retries, clear errors).
 */
export {
  authenticatedFetch,
  authenticatedJson,
  hasWebSession,
  wakeApiIfNeeded,
} from "./appSession.js";
