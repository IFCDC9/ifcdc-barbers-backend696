import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function NotFound() {
  const { t } = useTranslation();

  return (
    <div className="page" style={{ padding: "2rem 1rem", textAlign: "center" }}>
      <h1 className="ifcdc-page-title">
        {t("web.notFoundPage.title", { defaultValue: "Page not found" })}
      </h1>
      <p className="ifcdc-page-hint" style={{ marginBottom: "1.5rem" }}>
        {t("web.notFoundPage.body", {
          defaultValue: "That page doesn't exist or was moved.",
        })}
      </p>
      <Link to="/" className="auth-link">
        {t("web.notFoundPage.home", { defaultValue: "Go home" })}
      </Link>
      {" · "}
      <Link to="/booking" className="auth-link">
        {t("web.homePage.bookAppointment", { defaultValue: "Book appointment" })}
      </Link>
    </div>
  );
}
