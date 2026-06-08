import React from "react";
import {
  FALLBACK_STYLE_IMAGE_URL,
  isRenderableStyleImageUrl,
  resolveStyleImageUrl,
} from "../lib/styleImageUrl.js";

/**
 * Style card cover image — object-fit cover, fallback on invalid URL or load error.
 */
export default function StyleCoverImage({
  styleId,
  barberId,
  imageUrl,
  alt = "",
  className = "ifcdc-cover-media__img ifcdc-cover-fill",
  frameClassName = "ifcdc-cover-media",
  frameStyle,
  logContext = "style-card",
  bare = false,
}) {
  const [src, setSrc] = React.useState(() =>
    isRenderableStyleImageUrl(imageUrl) ? resolveStyleImageUrl(imageUrl) : FALLBACK_STYLE_IMAGE_URL,
  );
  const [useFallback, setUseFallback] = React.useState(false);

  React.useEffect(() => {
    const resolved = isRenderableStyleImageUrl(imageUrl)
      ? resolveStyleImageUrl(imageUrl)
      : FALLBACK_STYLE_IMAGE_URL;
    setSrc(resolved);
    setUseFallback(false);
    console.info(`[${logContext}] style image`, {
      styleId,
      barberId,
      image_url: imageUrl,
      resolved,
      renderable: isRenderableStyleImageUrl(imageUrl),
    });
  }, [styleId, barberId, imageUrl, logContext]);

  const onError = React.useCallback(() => {
    console.warn(`[${logContext}] image load error`, {
      styleId,
      barberId,
      image_url: imageUrl,
      attemptedSrc: src,
    });
    setUseFallback(true);
    setSrc(FALLBACK_STYLE_IMAGE_URL);
  }, [styleId, barberId, imageUrl, src, logContext]);

  const img = (
    <img
      src={useFallback ? FALLBACK_STYLE_IMAGE_URL : src}
      alt={alt}
      className={className}
      loading="lazy"
      onError={onError}
    />
  );

  if (bare) return img;
  return (
    <div className={frameClassName} style={frameStyle}>
      {img}
    </div>
  );
}
