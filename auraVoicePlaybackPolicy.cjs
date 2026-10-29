/** Opt-in half-duplex phone playback. This is turn protection, not denoising. */
function speechPlaybackParts(inner) {
  const protect = /^(1|true|yes)$/i.test(String(process.env.AURA_VOICE_PROTECT_PLAYBACK || "").trim());
  return { beforeGather: protect ? inner : "", duringGather: protect ? "" : inner };
}
module.exports = { speechPlaybackParts };
