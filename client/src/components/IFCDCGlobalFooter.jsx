import { Link } from "react-router-dom";
import { PUBLIC_CONTACT_EMAIL, PUBLIC_LEGAL } from "../lib/publicSite.js";

/** Site-wide footer — branding, legal, contact. */
export default function IFCDCGlobalFooter() {
  return (
    <footer className="app-footer ifcdc-global-footer" role="contentinfo">
      <nav className="home-footer__nav" aria-label="Legal and contact">
        <Link to={PUBLIC_LEGAL.privacy}>Privacy Policy</Link>
        <span className="home-footer__sep" aria-hidden>
          ·
        </span>
        <Link to={PUBLIC_LEGAL.terms}>Terms</Link>
        <span className="home-footer__sep" aria-hidden>
          ·
        </span>
        <a href={`mailto:${PUBLIC_CONTACT_EMAIL}`}>{PUBLIC_CONTACT_EMAIL}</a>
      </nav>
      <p className="home-footer__text">© 2026 IFCDC</p>
      <p className="home-footer__text home-footer__sub">Powered by IFCDC Productions</p>
    </footer>
  );
}
