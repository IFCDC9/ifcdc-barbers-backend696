import { Link, useNavigate } from "react-router-dom";
import DeleteAccountSection from "../components/DeleteAccountSection.jsx";

function readUser() {
  try {
    return JSON.parse(localStorage.getItem("user") || "null");
  } catch {
    return null;
  }
}

export default function DeleteAccount() {
  const navigate = useNavigate();
  const user = readUser();

  const logout = () => {
    try {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
    } catch {
      /* ignore */
    }
    navigate("/", { replace: true });
  };

  if (!user) {
    return (
      <div className="ifcdc-profile">
        <h1 className="ifcdc-page-title">Delete account</h1>
        <p className="ifcdc-page-lead">Sign in to permanently delete your account.</p>
        <Link to="/login" className="ifcdc-book-wizard__cta">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="ifcdc-profile">
      <h1 className="ifcdc-page-title">Delete account</h1>
      <p className="ifcdc-page-lead">
        Permanently remove your IFCDC Barbers account and personal data.
      </p>
      <DeleteAccountSection user={user} onDeleted={logout} />
      <Link to="/profile" className="ifcdc-book-wizard__back">
        ← Back to profile
      </Link>
    </div>
  );
}
