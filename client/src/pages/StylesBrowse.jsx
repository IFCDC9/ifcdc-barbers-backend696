import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getBarbers, getStylesAll, mediaUrl } from "../services/api.js";

const STORAGE_KEY = "ifcdc_selected_booking_style";

export default function StylesBrowse() {
  const navigate = useNavigate();
  const [barbers, setBarbers] = useState([]);
  const [styles, setStyles] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let c = false;
    Promise.all([getBarbers(), getStylesAll()])
      .then(([b, s]) => {
        if (!c) {
          setBarbers(Array.isArray(b) ? b : []);
          setStyles(Array.isArray(s) ? s : []);
          setError(null);
        }
      })
      .catch((e) => {
        if (!c) {
          setBarbers([]);
          setStyles([]);
          setError(e?.message || "Could not load styles. Check that the API is reachable.");
        }
      });
    return () => {
      c = true;
    };
  }, []);

  const barberNameById = useMemo(() => {
    const m = new Map();
    for (const b of barbers) {
      const id = String(b.id ?? "").trim();
      if (id) m.set(id, String(b.name || "").trim());
    }
    return m;
  }, [barbers]);

  const sortedStyles = useMemo(() => {
    return [...styles].sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
  }, [styles]);

  const goBook = (s) => {
    const bid = String(s.barber_id ?? "").trim();
    const name = barberNameById.get(bid) || `Barber ${bid}`;
    const payload = {
      styleId: s.id,
      barber_id: bid,
      barberId: bid,
      title: String(s.title || "").trim(),
      price: Number(s.price) > 0 ? Number(s.price) : 25,
      image_url: s.image_url,
      barberName: name,
    };
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
    navigate("/booking", { state: { selectedStyle: payload } });
  };

  return (
    <div className="ifcdc-styles-browse">
      <h1 className="ifcdc-page-title">Choose a style</h1>
      <p className="ifcdc-page-lead">
        Pick your cut — price is set per style. One tap takes you to date, time, and secure payment.
      </p>
      {error ? (
        <p className="ifcdc-error-msg" role="alert">
          {error}
        </p>
      ) : null}

      {!sortedStyles.length && !error ? (
        <p className="ifcdc-page-hint">No styles are published yet. Check back soon.</p>
      ) : (
        <ul className="ifcdc-styles-browse__grid">
          {sortedStyles.map((s) => {
            const img = mediaUrl(s.image_url);
            const price = Number(s.price) > 0 ? Number(s.price) : 25;
            const barber = barberNameById.get(String(s.barber_id)) || `Barber ${s.barber_id}`;
            return (
              <li key={s.id} className="ifcdc-styles-browse__card">
                <div className="ifcdc-styles-browse__img-wrap">
                  <img
                    src={img || ""}
                    alt=""
                    className="ifcdc-styles-browse__img ifcdc-cover-fill"
                    loading="lazy"
                  />
                </div>
                <div className="ifcdc-styles-browse__body">
                  <h2 className="ifcdc-styles-browse__name">{s.title || "Style"}</h2>
                  <p className="ifcdc-styles-browse__barber">{barber}</p>
                  <p className="ifcdc-styles-browse__price">${price.toFixed(2)}</p>
                  <button type="button" className="ifcdc-styles-browse__cta" onClick={() => goBook(s)}>
                    Select &amp; continue
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
