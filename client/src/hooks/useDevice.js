import { useEffect, useMemo, useState } from "react";

function getDeviceFromWidth(width) {
  const coarse =
    typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  // Touch phones (incl. iPhone landscape) keep app-style bottom nav below 1024px.
  if (width < 640 || (coarse && width < 1024)) return "mobile";
  if (width < 1024) return "tablet";
  return "desktop";
}

/**
 * Device-aware breakpoint hook.
 * - mobile: < 640px
 * - tablet: 640px – 1023px
 * - desktop: >= 1024px
 *
 * Updates on window resize.
 */
export const useDevice = () => {
  const initial = useMemo(() => {
    if (typeof window === "undefined") return "desktop";
    return getDeviceFromWidth(window.innerWidth);
  }, []);

  const [device, setDevice] = useState(initial);

  useEffect(() => {
    const handleResize = () => setDevice(getDeviceFromWidth(window.innerWidth));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return device;
};
