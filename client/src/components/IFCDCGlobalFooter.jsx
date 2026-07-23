import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PUBLIC_CONTACT_EMAIL, PUBLIC_LEGAL } from "../lib/publicSite.js";

/** Site-wide footer — branding, legal, contact. */
export default function IFCDCGlobalFooter() {
  const { t } = useTranslation();

  return (
    <footer className="app-footer ifcdc-global-footer" role="contentinfo">
      <nav
        className="home-footer__nav"
        aria-label={t("web.footer.legalAria", { defaultValue: "Legal and contact" })}
      >
        <Link to={PUBLIC_LEGAL.privacy}>
          {t("web.footer.privacy", { defaultValue: "Privacy Policy" })}
        </Link>
        <span className="home-footer__sep" aria-hidden>
          ·
        </span>
        <Link to={PUBLIC_LEGAL.terms}>{t("web.footer.terms", { defaultValue: "Terms" })}</Link>
        <span className="home-footer__sep" aria-hidden>
          ·
        </span>
        <a href={`mailto:${PUBLIC_CONTACT_EMAIL}`}>{PUBLIC_CONTACT_EMAIL}</a>
      </nav>
      <p className="home-footer__text">{t("web.footer.copyright", { defaultValue: "© 2026 IFCDC" })}</p>
      <p className="home-footer__text home-footer__sub">
        {t("web.footer.poweredBy", { defaultValue: "Powered by IFCDC Productions" })}
      </p>
    </footer>
  );
}
