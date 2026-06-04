import React from "react";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { theme } from "../components/ui/theme.js";
import { apiGet } from "../lib/api.js";
import { supabase } from "../utils/supabaseClient.js";
import {
  getStyleImagesForBarber,
  getImageUrl,
  pathFromPublicImageUrl,
} from "../utils/barberStyleStorage.js";

function mergeStorageWithApi(storageFiles, apiStyles) {
  const byPath = new Map();
  for (const s of apiStyles || []) {
    const p = pathFromPublicImageUrl(s.imageUrl);
    if (p) byPath.set(p, s);
  }

  const rows = [];
  for (const f of storageFiles) {
    const match = byPath.get(f.path);
    const baseTitle = f.name.replace(/\.[^.]+$/, "").replace(/-/g, " ");
    rows.push({
      id: match?.id ?? `path:${f.path}`,
      styleName: match?.styleName ?? baseTitle,
      price: match != null ? Number(match.price) : 20,
      durationMinutes: match?.durationMinutes ?? 30,
      imageUrl: getImageUrl(f.path),
      tags: match?.tags ?? [],
    });
  }
  return rows;
}

function galleryItemUrls(gallery) {
  if (!Array.isArray(gallery)) return [];
  return gallery
    .map((item) => (typeof item === "string" ? item : item?.url))
    .filter(Boolean);
}

export default function BarberGallery({ barberName, navigate }) {
  const [styles, setStyles] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [selectedId, setSelectedId] = React.useState(null);
  const [dataNote, setDataNote] = React.useState("");
  const [profile, setProfile] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!barberName) {
        setProfile(null);
        return;
      }
      try {
        const j = await apiGet(`/api/barbers/profile?name=${encodeURIComponent(barberName)}`);
        if (!cancelled) setProfile(j?.profile ?? null);
      } catch {
        if (!cancelled) setProfile(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [barberName]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!barberName) {
        setStyles([]);
        setLoading(false);
        setDataNote("");
        return;
      }
      setLoading(true);
      setDataNote("");
      try {
        /** CMS: barber_styles + style_images (preferred when rows exist) */
        const barberId = profile?.id;
        if (barberId) {
          const cms = await apiGet(`/api/styles/barber/${barberId}`);
          const rows = Array.isArray(cms?.styles) ? cms.styles : [];
          if (rows.length && !cancelled) {
            setStyles(
              rows.map((s) => ({
                id: `cms-${s.id}`,
                cmsStyleId: s.id,
                styleName: s.name,
                price: Number(s.price),
                durationMinutes: s.durationMinutes,
                imageUrl: Array.isArray(s.images) && s.images.length ? s.images[0].url : "",
                images: Array.isArray(s.images) ? s.images : [],
                tags: [],
              }))
            );
            setLoading(false);
            return;
          }
        }

        const q = new URLSearchParams({ barber: barberName }).toString();
        const j = await apiGet(`/api/barbers/styles?${q}`);
        const apiStyles = Array.isArray(j?.styles) ? j.styles : [];

        let storageFiles = [];
        if (supabase) {
          storageFiles = await getStyleImagesForBarber(barberName);
        } else {
          setDataNote("Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY) to .env for live Storage sync.");
        }

        let merged;
        if (storageFiles.length > 0) {
          merged = mergeStorageWithApi(storageFiles, apiStyles);
        } else {
          merged = apiStyles.map((s) => {
            const url = s.imageUrl;
            if (url && /^https?:\/\//i.test(String(url))) {
              return { ...s, imageUrl: String(url) };
            }
            const path = pathFromPublicImageUrl(url);
            if (path) {
              return { ...s, imageUrl: getImageUrl(path) };
            }
            return { ...s };
          });
        }

        if (!cancelled) setStyles(merged);
      } catch (err) {
        if (!cancelled) {
          setStyles([]);
          setDataNote(
            err instanceof Error
              ? `Could not load styles (${err.message}). Check API and database.`
              : "Could not load styles. Is the backend running and /api reachable?"
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [barberName, profile?.id]);

  const selectedService = styles.find((s) => s.id === selectedId) || null;

  const bookThisStyle = () => {
    if (!barberName || !selectedService) return;
    const params = new URLSearchParams({
      barber: barberName,
      service: selectedService.styleName,
      price: String(selectedService.price),
      duration: String(selectedService.durationMinutes),
    });
    navigate?.(`/booking?${params.toString()}`);
  };

  return (
    <Page>
      <section>
        <PageHeader
          title="Style gallery"
          subtitle={
            <>
              Barber: <span style={stylesMeta.pill}>{barberName || "—"}</span>
            </>
          }
        />

        <div style={{ marginTop: 12, marginBottom: 12 }}>
          <Button variant="indigo" onClick={() => navigate?.("/barbers")}>
            ← Back to barbers
          </Button>
        </div>

        {dataNote ? <div style={stylesMeta.hint}>{dataNote}</div> : null}

        {profile ? (
          <Card style={{ marginBottom: 16 }}>
            <div style={stylesMeta.profileRow}>
              {profile.profileImageUrl ? (
                <img src={profile.profileImageUrl} alt="" style={stylesMeta.profileImg} loading="lazy" />
              ) : null}
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={stylesMeta.profileName}>{profile.name || barberName}</div>
                {profile.bio ? <div style={stylesMeta.profileBio}>{profile.bio}</div> : null}
                <div style={stylesMeta.contactRow}>
                  {profile.contactEmail ? (
                    <a href={`mailto:${encodeURIComponent(profile.contactEmail)}`} style={stylesMeta.contactLink}>
                      {profile.contactEmail}
                    </a>
                  ) : null}
                  {profile.contactPhone ? (
                    <a href={`tel:${String(profile.contactPhone).replace(/\s+/g, "")}`} style={stylesMeta.contactLink}>
                      {profile.contactPhone}
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
            {galleryItemUrls(profile.gallery).length ? (
              <div style={stylesMeta.profileGallery}>
                {galleryItemUrls(profile.gallery).map((u, i) => (
                  <img key={`${i}-${u}`} src={u} alt="" style={stylesMeta.profileGalleryImg} loading="lazy" />
                ))}
              </div>
            ) : null}
          </Card>
        ) : null}

        {loading ? (
          <div style={stylesMeta.muted}>Loading styles…</div>
        ) : !styles.length ? (
          <Card>
            <div style={stylesMeta.muted}>No style photos yet for this barber.</div>
          </Card>
        ) : (
          <div style={stylesMeta.grid}>
            {styles.map((s) => {
              const active = selectedId === s.id;
              const thumbUrl = s.imageUrl || (Array.isArray(s.images) && s.images[0]?.url) || "";
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedId(s.id)}
                  style={{
                    ...stylesMeta.tile,
                    borderColor: active ? theme.colors.accent : theme.colors.border,
                    boxShadow: active ? `0 0 0 2px ${theme.colors.indigoBorder}` : "none",
                  }}
                >
                  <img src={thumbUrl || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"} alt={s.styleName} style={stylesMeta.img} />
                  <div style={stylesMeta.tileBody}>
                    <div style={stylesMeta.styleTitle}>{s.styleName}</div>
                    <div style={stylesMeta.meta}>
                      ${Number(s.price).toFixed(2)} · {s.durationMinutes} min
                    </div>
                    {Array.isArray(s.tags) && s.tags.length ? (
                      <div style={stylesMeta.tags}>{s.tags.join(" · ")}</div>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {selectedService ? (
          <Card style={{ marginTop: 16 }}>
            <div style={stylesMeta.selectedRow}>
              <div>
                <div style={stylesMeta.styleTitle}>{selectedService.styleName}</div>
                <div style={stylesMeta.muted}>
                  ${Number(selectedService.price).toFixed(2)} · {selectedService.durationMinutes} minutes
                </div>
              </div>
              <Button variant="indigo" onClick={bookThisStyle}>
                Book this style
              </Button>
            </div>
            {Array.isArray(selectedService.images) && selectedService.images.length ? (
              <div style={stylesMeta.subGallery}>
                {selectedService.images.map((im) => (
                  <img
                    key={im.id || im.url}
                    src={im.url}
                    alt=""
                    style={stylesMeta.subGalleryImg}
                    loading="lazy"
                  />
                ))}
              </div>
            ) : null}
          </Card>
        ) : null}
      </section>
    </Page>
  );
}

const stylesMeta = {
  hint: {
    color: theme.colors.muted,
    fontSize: 13,
    marginBottom: 12,
    fontWeight: 600,
  },
  pill: {
    display: "inline-block",
    padding: "4px 10px",
    borderRadius: 999,
    border: `1px solid ${theme.colors.border}`,
    backgroundColor: "rgba(0,0,0,0.20)",
    fontWeight: 700,
  },
  muted: { color: theme.colors.muted, fontSize: 14 },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: 14,
  },
  tile: {
    textAlign: "left",
    cursor: "pointer",
    padding: 0,
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`,
    backgroundColor: theme.colors.secondary,
    color: theme.colors.text,
    overflow: "hidden",
  },
  img: {
    width: "100%",
    height: 160,
    objectFit: "cover",
    display: "block",
    backgroundColor: "#000",
  },
  tileBody: { padding: 12 },
  styleTitle: { fontWeight: 900, fontSize: 15 },
  meta: { marginTop: 6, fontSize: 13, color: theme.colors.muted, fontWeight: 700 },
  tags: { marginTop: 6, fontSize: 12, color: theme.colors.accent, fontWeight: 600 },
  selectedRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },
  profileRow: {
    display: "flex",
    gap: 16,
    flexWrap: "wrap",
    alignItems: "flex-start",
  },
  profileImg: {
    width: 140,
    height: 140,
    objectFit: "cover",
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`,
    backgroundColor: "#000",
    flexShrink: 0,
  },
  profileName: {
    fontWeight: 900,
    fontSize: 18,
    marginBottom: 8,
  },
  profileBio: {
    color: theme.colors.muted,
    fontSize: 14,
    lineHeight: 1.5,
    marginBottom: 10,
  },
  contactRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
  },
  contactLink: {
    color: theme.colors.accent,
    fontSize: 14,
    fontWeight: 700,
  },
  profileGallery: {
    marginTop: 14,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))",
    gap: 8,
  },
  profileGalleryImg: {
    width: "100%",
    height: 88,
    objectFit: "cover",
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`,
  },
  subGallery: {
    marginTop: 14,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
    gap: 10,
  },
  subGalleryImg: {
    width: "100%",
    height: 120,
    objectFit: "cover",
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`,
    backgroundColor: "#000",
  },
};
