import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function About() {
  const { t } = useTranslation();

  return (
    <div className="page-stack ifcdc-about">
      <div className="page-hero">
        <h1 className="ifcdc-page-title">
          {t("web.aboutPage.title", { defaultValue: "About IFCDC" })}
        </h1>
        <p className="lead">
          Discipline, detail, and community — a space where precision meets culture. Matte black, liquid gold: our
          signature look.
        </p>
      </div>

      <section className="panel glass-panel about-mission">
        <h2 className="about-section__title">
          {t("web.aboutPage.mission", { defaultValue: "Our mission" })}
        </h2>
        <p className="muted" style={{ marginTop: 0 }}>
          We deliver consistent, professional cuts and a welcoming chair experience. Excellence isn&apos;t optional —
          it&apos;s the standard for everyone who sits with us.
        </p>
      </section>

      <section className="panel glass-panel about-mission">
        <h2 className="about-section__title">
          {t("web.aboutPage.offer", { defaultValue: "What we offer" })}
        </h2>
        <ul className="ifcdc-about-list">
          <li>Precision fades, tapers, and lineups</li>
          <li>Beard sculpting and hot-towel finishes</li>
          <li>Online booking with secure PayPal checkout</li>
          <li>Email confirmations powered by Resend</li>
        </ul>
      </section>

      <section className="panel glass-panel about-mission">
        <h2 className="about-section__title">
          {t("web.aboutPage.why", { defaultValue: "Why choose us" })}
        </h2>
        <p style={{ marginTop: 0 }}>
          Transparent pricing, respectful service, and a futuristic IFCDC experience from booking to checkout. We invest
          in the craft so you leave confident — every visit.
        </p>
      </section>

      <div className="page-actions" style={{ marginTop: "1.5rem" }}>
        <Link to="/booking" className="btn btn-primary">
          {t("web.homePage.bookNow", { defaultValue: "Book Now" })}
        </Link>
        <Link to="/barbers" className="btn btn-ghost">
          {t("web.homePage.featuredBarbers", { defaultValue: "Featured barbers" })}
        </Link>
      </div>
    </div>
  );
}
