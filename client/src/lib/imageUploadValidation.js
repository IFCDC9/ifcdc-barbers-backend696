/** Shared client-side checks before sending photos to the API. */
export const UPLOAD_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif";

export function validateImageUploadFile(file) {
  if (!file) return "Select an image file first.";
  if (!(file instanceof File) && !(file instanceof Blob)) return "Invalid file selection.";
  if (!file.size) return "Selected file is empty.";
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  const isHeic = /\.heic$|\.heif$/.test(name) || type.includes("heic") || type.includes("heif");
  if (type && !isHeic && !/^image\/(jpeg|pjpeg|png|gif|webp|heic|heif)$/.test(type)) {
    return "Please choose a JPEG, PNG, WebP, GIF, or iPhone photo (HEIC).";
  }
  if (file.size > 8 * 1024 * 1024) return "Image must be 8MB or smaller.";
  return null;
}
