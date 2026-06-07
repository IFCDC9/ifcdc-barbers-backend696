import { createPortal } from "react-dom";
import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import AppNav from "../components/AppNav.jsx";
import { useDevice } from "../hooks/useDevice.js";

export default function MainLayout() {
  const device = useDevice();

  useEffect(() => {
    if (device !== "mobile") return undefined;
    document.body.classList.add("ifcdc-has-bottom-nav");
    return () => document.body.classList.remove("ifcdc-has-bottom-nav");
  }, [device]);

  const nav =
    device === "mobile" ? <AppNav variant="bottom" /> : device === "tablet" ? <AppNav variant="top" /> : <AppNav variant="sidebar" />;

  const mobileBottomNav =
    device === "mobile" && typeof document !== "undefined"
      ? createPortal(nav, document.body)
      : null;

  return (
    <div className={`ifcdc-shell ifcdc-shell--${device} ifcdc-no-x pb-safe pt-safe`} data-device={device}>
      {device === "desktop" ? (
        <aside className="ifcdc-shell__sidebar">{nav}</aside>
      ) : device === "tablet" ? (
        <header className="ifcdc-shell__topnav">{nav}</header>
      ) : null}

      <main className="ifcdc-shell__main premium-stage">
        <div className="ifcdc-layout-container">
          <Outlet />
        </div>
      </main>

      {mobileBottomNav}
    </div>
  );
}
