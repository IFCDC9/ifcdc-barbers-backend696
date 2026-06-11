/** Max style gallery photos per barber (soft cap for storage/performance). */
const MAX_STYLE_GALLERY_PHOTOS_PER_BARBER = 100;

/** Max files accepted per batch upload request. */
const MAX_STYLE_GALLERY_BATCH_UPLOAD = 25;

const GALLERY_ID_PREFIX = "gal-";

module.exports = {
  MAX_STYLE_GALLERY_PHOTOS_PER_BARBER,
  MAX_STYLE_GALLERY_BATCH_UPLOAD,
  GALLERY_ID_PREFIX,
};
