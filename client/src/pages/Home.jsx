import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getBarbers } from "../services/api.js";
import StyleCoverImage from "../components/StyleCoverImage.jsx";
import LanguageDropdown from "../components/LanguageDropdown.jsx";
import { formatNanpUsDisplay, nanpDialString } from "../lib/formatNanp.js";
import { useAuraContactPhone } from "../lib/useAuraContactPhone.js";
import {
  APP_DOWNLOAD_CTA,
  PUBLIC_CONTACT_EMAIL,
  PUBLIC_LEGAL,
  resolveAppDownloadHref,
} from "../lib/publicSite.js";

function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function estimateTravelTimeMinutes(distanceKm) {
  const avgSpeedKmh = 40;
  return Math.round((distanceKm / avgSpeedKmh) * 60);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function minutesSinceMidnight(d) {
  return d.getHours() * 60 + d.getMinutes();
}

function addDaysYmd(ymdStr, days) {
  const [y, m, dd] = String(ymdStr).split("-").map((x) => Number(x));
  const dt = new Date(y, (m || 1) - 1, dd || 1);
  dt.setDate(dt.getDate() + days);
  return ymd(dt);
}

function ceilToStepMinutes(totalMinutes, step) {
  return Math.ceil(totalMinutes / step) * step;
}

function formatHm(totalMinutes) {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function isLiveBarberId(id) {
  if (id == null) return false;
  const s = String(id);
  if (s.startsWith("seed")) return false;
  return typeof id === "number" || /^\d+$/.test(s);
}

function nextSuggestedAppointment(userCoords, barber, now = new Date()) {
  const openMin = 9 * 60;
  const closeMin = 20 * 60;
  const step = 30;
  const bufferMin = 10;

  const shopLat = barber?.location?.latitude;
  const shopLng = barber?.location?.longitude;
  let travelMin = 0;
  if (
    userCoords &&
    typeof shopLat === "number" &&
    typeof shopLng === "number" &&
    Number.isFinite(shopLat) &&
    Number.isFinite(shopLng)
  ) {
    const km = getDistanceKm(userCoords.lat, userCoords.lng, shopLat, shopLng);
    if (Number.isFinite(km)) travelMin = estimateTravelTimeMinutes(km);
  }

  const todayStr = ymd(now);
  const nowMin = minutesSinceMidnight(now);
  const earliestMin = nowMin + travelMin + bufferMin;

  const pickDay = (dateStr, startMin) => {
    let t = Math.max(openMin, ceilToStepMinutes(startMin, step));
    if (t > closeMin) return null;
    return { date: dateStr, time: formatHm(t) };
  };

  let first = pickDay(todayStr, earliestMin);
  if (first) return { ...first, travelMin };

  const tomorrowStr = addDaysYmd(todayStr, 1);
  first = pickDay(tomorrowStr, openMin);
  if (first) return { ...first, travelMin };

  return { date: todayStr, time: "09:00", travelMin };
}

export default function Home() {
  const { t } = useTranslation();
  const [barbers, setBarbers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [userCoords, setUserCoords] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState(null);
  const navigate = useNavigate();

  const auraPhoneRaw = useAuraContactPhone();
  const auraPhoneTel = nanpDialString(auraPhoneRaw);
  const auraPhoneDisplay = formatNanpUsDisplay(auraPhoneRaw);
  const appDownloadHref = useMemo(
    () =>
      typeof navigator !== "undefined"
        ? resolveAppDownloadHref(navigator.userAgent)
        : APP_DOWNLOAD_CTA.href,
    [],
  );

  const requestLocation = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocError(
        t("web.homePage.geoUnavailable", {
          defaultValue: "Geolocation is not available on this device/browser.",
        }),
      );
      return null;
    }
    setLocating(true);
    setLocError(null);
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 60000,
        });
      });
      const la = pos?.coords?.latitude;
      const lo = pos?.coords?.longitude;
      if (typeof la === "number" && typeof lo === "number") {
        const coords = { lat: la, lng: lo };
        setUserCoords(coords);
        return coords;
      }
      setLocError(
        t("web.homePage.geoCoords", { defaultValue: "Could not read your coordinates." }),
      );
      return null;
    } catch (e) {
      setLocError(
        e?.message || t("web.homePage.geoFailed", { defaultValue: "Could not get location." }),
      );
      return null;
    } finally {
      setLocating(false);
    }
  }, [t]);

  const roster = useMemo(() => (Array.isArray(barbers) ? barbers : []).filter((b) => isLiveBarberId(b?.id)), [barbers]);

  const sortedByDistance = useMemo(() => {
    if (!userCoords) return roster;
    const scored = roster.map((b) => {
      const lat = b?.location?.latitude;
      const lng = b?.location?.longitude;
      const distanceKm =
        typeof lat === "number" && typeof lng === "number"
          ? getDistanceKm(userCoords.lat, userCoords.lng, lat, lng)
          : Number.POSITIVE_INFINITY;
      return { ...b, distanceKm };
    });
    scored.sort(
      (a, b) => (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY),
    );
    return scored;
  }, [roster, userCoords]);

  const nearest = sortedByDistance[0] ?? null;

  const suggestion = useMemo(() => {
    if (!nearest) return null;
    const slot = nextSuggestedAppointment(userCoords, nearest);
    const miles =
      userCoords && Number.isFinite(nearest.distanceKm) && nearest.distanceKm !== Number.POSITIVE_INFINITY
        ? nearest.distanceKm * 0.621371
        : null;
    const driveMin =
      userCoords && Number.isFinite(nearest.distanceKm) && nearest.distanceKm !== Number.POSITIVE_INFINITY
        ? estimateTravelTimeMinutes(nearest.distanceKm)
        : null;
    return { barber: nearest, slot, miles, driveMin };
  }, [nearest, userCoords]);

  useEffect(() => {
    let cancelled = false;
    getBarbers()
      .then((data) => {
        if (!cancelled) setBarbers(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setBarbers([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const bookInstant = () => {
    navigate("/booking");
  };

  const openNow = async () => {
    if (!userCoords) await requestLocation();
    navigate("/booking");
  };

  return (
    <div className="home-landing">
      <section className="app-marketing-hero" aria-labelledby="app-marketing-title">
        <p className="ifcdc-hero-brand">
          {t("web.homePage.brandApp", { defaultValue: "IFCDC BARBERS APP" })}
        </p>
        <h1 id="app-marketing-title" className="app-marketing-hero__title">
          {t("web.homePage.marketingTitle", { defaultValue: "Book. Pay. Confirmed." })}
        </h1>
        <p className="app-marketing-hero__sub">
          {t("web.homePage.marketingSub", {
            defaultValue:
              "The official IFCDC Barbers platform — secure PayPal checkout, instant booking confirmation, and professional scheduling for customers, barbers, and shop owners.",
          })}
        </p>
        <div className="app-marketing-hero__actions">
          <a
            href={appDownloadHref}
            className="app-marketing-hero__btn app-marketing-hero__btn--gold"
            rel="noopener noreferrer"
          >
            {t("web.homePage.getTheApp", { defaultValue: APP_DOWNLOAD_CTA.label || "Get the App" })}
          </a>
          <Link to="/booking" className="app-marketing-hero__btn app-marketing-hero__btn--outline">
            {t("web.homePage.bookOnWeb", { defaultValue: "Book on the Web" })}
          </Link>
          <Link to="/login" className="app-marketing-hero__btn app-marketing-hero__btn--outline">
            {t("web.homePage.signIn", { defaultValue: "Sign In" })}
          </Link>
        </div>
        <div className="app-marketing-hero__lang" style={{ maxWidth: 320, margin: "1rem auto 0" }}>
          <LanguageDropdown />
        </div>
        <div className="app-marketing-hero__owner">
          <span>{t("web.homePage.ownerPrompt", { defaultValue: "Barber or shop owner?" })}</span>
          <a href={`mailto:${PUBLIC_CONTACT_EMAIL}?subject=IFCDC%20shop%20onboarding`}>
            {t("web.homePage.requestAccess", { defaultValue: "Request access" })}
          </a>
        </div>
        <nav
          className="app-marketing-hero__legal"
          aria-label={t("web.homePage.legalNav", { defaultValue: "Legal" })}
        >
          <Link to={PUBLIC_LEGAL.privacy}>
            {t("web.footer.privacy", { defaultValue: "Privacy Policy" })}
          </Link>
          <Link to={PUBLIC_LEGAL.terms}>{t("web.footer.terms", { defaultValue: "Terms" })}</Link>
          <a href={`mailto:${PUBLIC_CONTACT_EMAIL}`}>{PUBLIC_CONTACT_EMAIL}</a>
        </nav>
      </section>

      <section className="home-hero" aria-labelledby="home-hero-title">
        <p className="ifcdc-hero-brand">
          {t("web.homePage.brandBarbers", { defaultValue: "IFCDC BARBERS" })}
        </p>
        <h1 id="home-hero-title" className="home-hero__title">
          {t("web.homePage.heroTitleAlt", { defaultValue: "Precision cuts. Elevated experience." })}
        </h1>
        <p className="home-hero__sub">
          {t("web.homePage.heroSubtitleAlt", {
            defaultValue: "Matte black. Liquid gold. Book your chair and walk out sharp — every time.",
          })}
        </p>
        <Link to="/booking" className="home-hero__btn">
          {t("web.homePage.bookAppointment", { defaultValue: "Book appointment" })}
        </Link>
      </section>

      <section className="smart-home glass-panel" aria-label="Smart shortcuts">
        <div className="aura-panel">
          <div className="aura-glow" aria-hidden />
          <h2 className="aura-panel__title">{t("web.nav.aura", { defaultValue: "AURA" })}</h2>
          <p className="aura-panel__lead">
            {t("web.homePage.auraLead", { defaultValue: "What do you need today?" })}
          </p>
          <p className="aura-panel__hint">
            {t("web.homePage.auraHint", {
              defaultValue: "Tap the floating AURA button to ask anything — or use the shortcuts below.",
            })}
          </p>
          {auraPhoneTel ? (
            <div className="aura-panel__call-block">
              <p className="aura-panel__call-text">
                <a href={`tel:${auraPhoneTel}`} className="aura-panel__call-link">
                  {t("web.homePage.callAura", { defaultValue: "Call AURA" })}
                </a>
                {" · "}
                <a href={`sms:${auraPhoneTel}`} className="aura-panel__call-link">
                  {t("web.homePage.textAura", { defaultValue: "Text AURA" })}
                </a>
              </p>
              {auraPhoneDisplay ? (
                <p className="aura-panel__call-display" aria-label={`IFCDC Barbers App ${auraPhoneDisplay}`}>
                  IFCDC Barbers App · {auraPhoneDisplay}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="quick-actions">
          <button type="button" className="smart-home__btn smart-home__btn--primary" onClick={() => navigate("/booking")}>
            {t("web.homePage.bookNow", { defaultValue: "Book Now" })}
          </button>
          <button
            type="button"
            className="smart-home__btn"
            onClick={async () => {
              if (!userCoords) await requestLocation();
              navigate("/booking");
            }}
            disabled={locating}
          >
            {locating
              ? t("web.homePage.locating", { defaultValue: "Locating…" })
              : t("web.homePage.nearestBarber", { defaultValue: "Nearest Barber" })}
          </button>
          <button type="button" className="smart-home__btn" onClick={openNow} disabled={locating}>
            {locating
              ? t("web.homePage.locating", { defaultValue: "Locating…" })
              : t("web.homePage.openNowBtn", { defaultValue: "Open Now" })}
          </button>
        </div>

        <div className="smart-suggestion">
          {!loading && roster.length === 0 ? (
            <p className="smart-suggestion__empty">
              {t("web.homePage.noRoster", { defaultValue: "No live roster yet — add barbers from Admin." })}
            </p>
          ) : !suggestion ? (
            <p className="smart-suggestion__empty">
              {t("web.homePage.loadingSuggestion", { defaultValue: "Loading suggestion…" })}
            </p>
          ) : (
            <div
              className="barber-card best"
              aria-label={`${t("web.homePage.bestMatch", { defaultValue: "Best Match" })}: ${suggestion.barber?.name || "Barber"}`}
            >
              <h3>🔥 {t("web.homePage.bestMatch", { defaultValue: "Best Match" })}</h3>
              <p>
                {userCoords &&
                suggestion.miles != null &&
                suggestion.driveMin != null &&
                Number.isFinite(suggestion.barber?.distanceKm) &&
                suggestion.barber.distanceKm !== Number.POSITIVE_INFINITY
                  ? t("web.homePage.milesAwayDetail", {
                      miles: suggestion.miles.toFixed(1),
                      minutes: suggestion.driveMin,
                      defaultValue: `${suggestion.miles.toFixed(1)} miles • ${suggestion.driveMin} min away`,
                    })
                  : userCoords
                    ? t("web.homePage.needAddress", {
                        defaultValue:
                          "Save a shop street address in Admin for map directions. Miles and drive time appear when coordinates exist (optional).",
                      })
                    : t("web.homePage.turnOnLocation", {
                        defaultValue:
                          "Turn on location to sort by distance when barbers have coordinates on file.",
                      })}
              </p>
              <p>
                {t("web.homePage.nextSlot", { defaultValue: "Next Slot:" })}{" "}
                <time dateTime={`${suggestion.slot.date}T${suggestion.slot.time}`}>
                  {new Date(`${suggestion.slot.date}T${suggestion.slot.time}:00`).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
                {suggestion.slot.date !== ymd(new Date()) ? ` (${suggestion.slot.date})` : ""}
              </p>
              <button type="button" className="smart-home__btn smart-home__btn--primary" onClick={bookInstant}>
                {t("web.homePage.bookNow", { defaultValue: "Book Now" })}
              </button>
            </div>
          )}
        </div>

        {locError ? (
          <p className="smart-home__hint" role="status">
            {locError}
          </p>
        ) : null}
      </section>

      <section className="home-feature-grid" aria-labelledby="features-heading">
        <h2 id="features-heading" className="home-section__title">
          {t("web.homePage.featuresTitle", { defaultValue: "Why IFCDC" })}
        </h2>
        <div className="home-feature-grid__row">
          <article className="glass-panel home-feature-card">
            <h3 className="home-feature-card__h">
              {t("web.homePage.featureCraft", { defaultValue: "Craft" })}
            </h3>
            <p className="home-feature-card__p">
              {t("web.homePage.featureCraftBody", {
                defaultValue: "Lineups, fades, and finishes executed with discipline.",
              })}
            </p>
          </article>
          <article className="glass-panel home-feature-card">
            <h3 className="home-feature-card__h">
              {t("web.homePage.featureCulture", { defaultValue: "Culture" })}
            </h3>
            <p className="home-feature-card__p">
              {t("web.homePage.featureCultureBody", {
                defaultValue: "A premium chair experience built on respect and consistency.",
              })}
            </p>
          </article>
          <article className="glass-panel home-feature-card">
            <h3 className="home-feature-card__h">
              {t("web.homePage.featureConvenience", { defaultValue: "Convenience" })}
            </h3>
            <p className="home-feature-card__p">
              {t("web.homePage.featureConvenienceBody", {
                defaultValue: "Book online, pay securely, confirmation straight to your inbox.",
              })}
            </p>
          </article>
        </div>
      </section>

      <section className="home-featured" aria-labelledby="featured-heading">
        <h2 id="featured-heading" className="home-section__title">
          {t("web.homePage.featuredBarbers", { defaultValue: "Featured barbers" })}
        </h2>
        {loading ? (
          <p className="home-featured__loading" role="status">
            {t("web.common.loading", { defaultValue: "Loading…" })}
          </p>
        ) : (
          <div
            className={
              barbers.length === 0 ? "home-featured__grid home-featured__grid--empty" : "home-featured__grid"
            }
          >
            {barbers.length === 0 ? (
              <p className="home-featured__empty">
                {t("web.homePage.noRosterFeatured", {
                  defaultValue: "No roster yet — add barbers from Admin.",
                })}
              </p>
            ) : (
              barbers.slice(0, 4).map((b) => (
                <article key={b.id} className="home-featured__card">
                  <div className="home-featured__card-media">
                    {b.image || b.photo ? (
                      <StyleCoverImage
                        barberId={b.id}
                        imageUrl={b.image || b.photo}
                        alt={b.name || "Barber"}
                        className="home-featured__card-media-img ifcdc-cover-fill"
                        frameClassName="home-featured__card-media-frame ifcdc-cover-media"
                        logContext="featured-barber"
                        bare={false}
                      />
                    ) : (
                      <div className="home-featured__card-placeholder" aria-hidden />
                    )}
                  </div>
                  <h3 className="home-featured__card-name">{b.name}</h3>
                </article>
              ))
            )}
          </div>
        )}
      </section>

      <section className="home-cta" aria-labelledby="cta-heading">
        <h2 id="cta-heading" className="home-cta__visually-hidden">
          {t("web.nav.book", { defaultValue: "Book" })}
        </h2>
        <p className="home-cta__text">
          {t("web.homePage.readyWhen", { defaultValue: "Ready when you are." })}
        </p>
        <Link to="/booking" className="home-cta__btn">
          {t("web.homePage.reserveTime", { defaultValue: "Reserve your time" })}
        </Link>
      </section>

    </div>
  );
}
