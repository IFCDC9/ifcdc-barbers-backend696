import { useState } from "react";
import { deleteMyAccount } from "../services/api.js";

const CONFIRM_PHRASE = "DELETE";

export default function DeleteAccountSection({ user, onDeleted, inputId = "delete-account-confirm" }) {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const canDelete = confirmText.trim().toUpperCase() === CONFIRM_PHRASE && !busy;

  const handleDelete = async () => {
    if (!canDelete) return;
    const ok = window.confirm(
      "Your account and personal data will be permanently removed. This cannot be undone.",
    );
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      await deleteMyAccount();
      onDeleted?.();
    } catch (e) {
      setError(e?.message || "Account could not be deleted.");
    } finally {
      setBusy(false);
    }
  };

  if (!user) return null;

  return (
    <section className="ifcdc-delete-account" aria-labelledby="delete-account-heading">
      <h2 id="delete-account-heading" className="ifcdc-delete-account__title">
        Delete account
      </h2>
      <div className="ifcdc-delete-account__panel">
        <p className="ifcdc-delete-account__warning">
          Permanently remove your IFCDC Barbers account. This cannot be undone.
        </p>
        <ul className="ifcdc-delete-account__list">
          <li>Your profile and sign-in credentials will be removed.</li>
          <li>
            Past bookings stay on record for the shop but your personal details are anonymized.
          </li>
          <li>Barber profile data (services, schedule, portfolio) is removed when applicable.</li>
          <li>You will be signed out immediately after deletion.</li>
        </ul>
        {user.email ? (
          <p className="ifcdc-delete-account__email">
            Account: <strong>{user.email}</strong>
          </p>
        ) : null}
        <label className="ifcdc-delete-account__label" htmlFor={inputId}>
          Type <strong>DELETE</strong> below to confirm.
        </label>
        <input
          id={inputId}
          className="ifcdc-delete-account__input"
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={CONFIRM_PHRASE}
          autoCapitalize="characters"
          autoComplete="off"
          disabled={busy}
        />
        {error ? <p className="ifcdc-error-msg">{error}</p> : null}
        <div className="ifcdc-delete-account__actions">
          <button
            type="button"
            className="ifcdc-delete-account__btn"
            onClick={handleDelete}
            disabled={!canDelete}
          >
            {busy ? "Deleting…" : "Delete my account"}
          </button>
        </div>
      </div>
    </section>
  );
}
