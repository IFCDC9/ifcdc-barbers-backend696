import { NavLink, useNavigate } from "react-router-dom";

const NAV_ICONS = {
  home: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z" />
    </svg>
  ),
  book: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M4 11h16" />
    </svg>
  ),
  aura: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 3l2.2 6.8H21l-5.6 4.1 2.1 6.8L12 16.6 6.5 20.7l2.1-6.8L3 9.8h6.8L12 3Z" />
    </svg>
  ),
  profile: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c1.5-4 14.5-4 16 0" />
    </svg>
  ),
  shop: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 7h16l-1.5 13H5.5L4 7Z" />
      <path d="M9 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  ),
  admin: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    </svg>
  ),
  signin: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  ),
  logout: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5M21 12H9" />
    </svg>
  ),
};

/** TestFlight-parity tab bar: Home · Book · AURA · Profile · Shop/Admin */
export default function AppNav({ variant = "bottom" }) {
  const navigate = useNavigate();

  let user = null;
  try {
    user = JSON.parse(localStorage.getItem("user"));
  } catch {
    user = null;
  }
  const isLoggedIn = Boolean(user);
  const role = String(user?.role || "");
  const canSeePlatformAdmin = role === "super_admin" || role === "admin";
  const canSeeShopSettings =
    role === "barber" || role === "shop_owner" || canSeePlatformAdmin;

  const tabs = [
    { to: "/", icon: NAV_ICONS.home, label: "Home", end: true },
    { to: "/booking", icon: NAV_ICONS.book, label: "Book" },
    { to: "/aura", icon: NAV_ICONS.aura, label: "AURA" },
    { to: "/profile", icon: NAV_ICONS.profile, label: "Profile" },
    ...(canSeeShopSettings ? [{ to: "/barber-settings", icon: NAV_ICONS.shop, label: "Shop" }] : []),
    ...(canSeePlatformAdmin ? [{ to: "/admin", icon: NAV_ICONS.admin, label: "Admin" }] : []),
    ...(!isLoggedIn ? [{ to: "/login", icon: NAV_ICONS.signin, label: "Sign in" }] : []),
  ];

  const navClass =
    variant === "sidebar"
      ? "ifcdc-nav ifcdc-nav--sidebar"
      : variant === "top"
        ? "ifcdc-nav ifcdc-nav--top"
        : "ifcdc-bottom-nav ifcdc-main-nav ifcdc-bottom-nav--portaled";

  return (
    <nav className={navClass} aria-label="Main navigation">
      {tabs.map(({ to, label, icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          aria-label={label}
          className={({ isActive }) =>
            `ifcdc-bottom-nav__link ifcdc-nav-tab${isActive ? " ifcdc-nav-tab--active" : ""}`
          }
        >
          <span className="ifcdc-bottom-nav__glyph ifcdc-bottom-nav__glyph--svg" aria-hidden>
            {icon}
          </span>
          <span className="ifcdc-bottom-nav__text">{label}</span>
        </NavLink>
      ))}

      {isLoggedIn ? (
        <button
          type="button"
          className="ifcdc-bottom-nav__link ifcdc-bottom-nav__link--button ifcdc-nav-tab"
          onClick={() => {
            try {
              localStorage.removeItem("token");
              localStorage.removeItem("user");
            } catch {
              /* ignore */
            }
            navigate("/", { replace: true });
          }}
          aria-label="Logout"
        >
          <span className="ifcdc-bottom-nav__glyph ifcdc-bottom-nav__glyph--svg" aria-hidden>
            {NAV_ICONS.logout}
          </span>
          <span className="ifcdc-bottom-nav__text">Logout</span>
        </button>
      ) : null}
    </nav>
  );
}
