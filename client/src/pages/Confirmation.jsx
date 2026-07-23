import React from "react";
import { useTranslation } from "react-i18next";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card } from "../components/ui/Card.jsx";
import { theme } from "../components/ui/theme.js";

/** Shown after successful PayPal capture + booking save. */
export default function Confirmation({ navigate, barberName = "", date = "", time = "", orderId = "" }) {
  const { t } = useTranslation();

  return (
    <Page>
      <section>
        <PageHeader
          title={t("web.confirmationPage.title", { defaultValue: "Booking confirmed" })}
          subtitle={t("web.confirmationPage.body", {
            defaultValue: "You're all set. A confirmation email is on the way.",
          })}
        />
        <Card>
          <div style={styles.row}>
            <span style={styles.label}>Barber</span>
            <span style={styles.value}>{barberName || "—"}</span>
          </div>
          <div style={styles.row}>
            <span style={styles.label}>When</span>
            <span style={styles.value}>
              {date || "—"} at {time || "—"}
            </span>
          </div>
          {orderId ? (
            <div style={styles.row}>
              <span style={styles.label}>PayPal order</span>
              <span style={styles.mono}>{orderId}</span>
            </div>
          ) : null}
          <div style={{ marginTop: 18 }}>
            <button type="button" style={styles.backHomeBtn} onClick={() => navigate?.("/")}>
              {t("web.confirmationPage.backHome", { defaultValue: "Back to home" })}
            </button>
          </div>
        </Card>
      </section>
    </Page>
  );
}

const styles = {
  backHomeBtn: {
    cursor: "pointer",
    padding: "10px 12px",
    borderRadius: theme.radius.sm,
    fontWeight: 900,
    fontSize: 14,
    border: `1px solid ${theme.colors.indigoBorder}`,
    backgroundColor: theme.colors.indigoBg,
    color: "rgba(238,242,255,0.98)",
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    marginBottom: 10,
    fontSize: 14,
  },
  label: { color: theme.colors.muted, fontWeight: 700 },
  value: { color: theme.colors.text, fontWeight: 800 },
  mono: { color: theme.colors.muted, fontSize: 12, fontFamily: "ui-monospace, monospace" },
};
