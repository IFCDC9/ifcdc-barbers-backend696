import { Link, useLocation } from "react-router-dom";
import { PRIVACY_PUBLIC, TERMS_PUBLIC } from "../content/legalPublic.js";
import { CANONICAL_PUBLIC_ORIGIN, PUBLIC_CONTACT_EMAIL } from "../lib/publicSite.js";

const DOCS = {
  privacy: PRIVACY_PUBLIC,
  terms: TERMS_PUBLIC,
};

export default function PublicLegalPage({ docKey: docKeyProp }) {
  const { pathname } = useLocation();
  const docKey =
    docKeyProp || (pathname.endsWith("/terms") ? "terms" : pathname.endsWith("/privacy") ? "privacy" : "");
  const doc = DOCS[docKey];
  if (!doc) {
    return (
      <div className="public-legal">
        <p>Document not found.</p>
        <Link to="/">Back to home</Link>
      </div>
    );
  }
  return (
    <article className="public-legal">
      <p className="ifcdc-hero-brand">IFCDC BARBERS APP</p>
      {doc.identity ? <p className="sms-consent-page__identity">{doc.identity}</p> : null}
      <h1 className="public-legal__title">{doc.title}</h1>
      <p className="public-legal__meta">
        Effective {doc.effective} · {CANONICAL_PUBLIC_ORIGIN}
      </p>
      {doc.sections.map((s) => (
        <section key={s.heading} className="public-legal__section">
          <h2>{s.heading}</h2>
          <p>{s.body}</p>
        </section>
      ))}
      <p className="public-legal__contact">
        Contact:{" "}
        <a href={`mailto:${PUBLIC_CONTACT_EMAIL}`}>{PUBLIC_CONTACT_EMAIL}</a>
      </p>
      <Link to="/" className="public-legal__back">
        ← Back to IFCDC Barbers App
      </Link>
    </article>
  );
}
