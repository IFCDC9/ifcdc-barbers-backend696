import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getBarbers, getStylesAll, mediaUrl } from "../services/api.js";
import Lightbox from "../components/Lightbox.jsx";

export default function Barbers() {
  const [barbers, setBarbers] = useState([]);
  const [styles, setStyles] = useState([]);
  const [error, setError] = useState(null);
  const [userCoords, setUserCoords] = useState(null);
  const [locating, setLocating] = useState(false);
  const navigate = useNavigate();
  const [previewSrc, setPreviewSrc] = useState("");

  function getDistance(lat1, lon1, lat2, lon2) {
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

  const useMyLocation = async () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Geolocation is not available on this device/browser.");
      return;
    }
    setLocating(true);
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
        setUserCoords({ lat: la, lng: lo });
      } else {
        setError("Could not read your coordinates.");
      }
    } catch (e) {
      setError(e?.message || "Could not get location.");
    } finally {
      setLocating(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    getBarbers()
      .then((data) => {
        if (!cancelled) {
          const list = Array.isArray(data) ? data : [];
          setBarbers(list);
          setError(list.length ? null : "No barbers listed yet. Add barbers in Admin.");
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setBarbers([]);
          setError(e?.message || "Could not load barbers from the API.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getStylesAll()
      .then((rows) => {
        if (!cancelled) setStyles(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setStyles([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedBarbers = useMemo(() => {
    const list = Array.isArray(barbers) ? [...barbers] : [];
    if (!userCoords) return list;

    for (const b of list) {
      const lat = b?.location?.latitude;
      const lng = b?.location?.longitude;
      if (typeof lat === "number" && typeof lng === "number") {
        b.distance = getDistance(userCoords.lat, userCoords.lng, lat, lng);
      } else {
        b.distance = Number.POSITIVE_INFINITY;
      }
    }

    list.sort((a, b) => {
      return (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY);
    });
    return list;
  }, [barbers, userCoords]);

  return (
    <div className="ifcdc-page-barbers">
      <h1 className="ifcdc-page-title">Barbers</h1>
      <p className="ifcdc-page-lead">
        Browse barbers here — booking starts from <strong>Styles</strong> with set prices per look.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <button type="button" className="ifcdc-barber-card__btn" onClick={useMyLocation} disabled={locating}>
          {locating ? "Locating…" : "Use My Location"}
        </button>
        {userCoords ? (
          <p className="ifcdc-page-hint" style={{ margin: 0 }}>
            Sorted by nearest when each barber has latitude/longitude. Shop addresses alone do not change sort order.
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="ifcdc-page-hint" role="status">
          {error}
        </p>
      ) : null}

      <div className="ifcdc-barber-grid">
        {sortedBarbers.map((b) => {
          const img = b.photo || b.image;
          const specialty = b.specialty || "Cuts & grooming";
          const years = b.experience || b.years || "Pro stylist";
          const barberId = typeof b.id === "number" ? b.id : Number(b.id);
          const myStyles =
            Number.isFinite(barberId) && Array.isArray(styles)
              ? styles.filter((s) => Number(s.barber_id) === barberId).slice(0, 4)
              : [];
          return (
            <article key={b.id} className="glass-panel ifcdc-barber-card">
              <div className="ifcdc-barber-card__media">
                {img ? (
                  <img src={img.startsWith("http") ? img : mediaUrl(img)} alt="" className="ifcdc-barber-card__img" />
                ) : (
                  <div className="ifcdc-barber-card__placeholder" aria-hidden />
                )}
              </div>
              <h2 className="ifcdc-barber-card__name">{b.name}</h2>
              <p className="ifcdc-barber-card__meta">{specialty}</p>
              <p className="ifcdc-barber-card__meta ifcdc-barber-card__meta--dim">{years}</p>
              {userCoords && Number.isFinite(b.distance) && b.distance !== Number.POSITIVE_INFINITY ? (
                <p className="ifcdc-barber-card__meta ifcdc-barber-card__meta--dim">
                  {b.distance.toFixed(2)} km away
                </p>
              ) : null}

              <div style={{ marginTop: 10 }}>
                {myStyles.length ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
                    {myStyles.map((s) => {
                      const src = String(s.image_url || "");
                      const url = src.startsWith("/") ? mediaUrl(src) : src;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setPreviewSrc(url)}
                          style={{
                            padding: 0,
                            border: "1px solid rgba(212,175,55,0.2)",
                            borderRadius: 10,
                            overflow: "hidden",
                            background: "rgba(0,0,0,0.25)",
                          }}
                          aria-label={`Preview ${s.title || "style"}`}
                        >
                          <img src={url} alt="" style={{ width: "100%", height: 56, objectFit: "cover", display: "block" }} loading="lazy" />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="ifcdc-page-hint" style={{ margin: 0 }}>
                    No styles uploaded yet.
                  </p>
                )}
              </div>

              <button type="button" className="ifcdc-barber-card__btn" onClick={() => navigate("/styles")}>
                Choose style &amp; book
              </button>
            </article>
          );
        })}
      </div>

      <Lightbox open={Boolean(previewSrc)} src={previewSrc} onClose={() => setPreviewSrc("")} />
    </div>
  );
}
