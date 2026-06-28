import React from "react";
import { Link, Navigate } from "react-router-dom";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card, CardTitle } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { theme } from "../components/ui/theme.js";
import { getStoredToken, getStoredUser } from "../lib/authHeaders.js";
import {
  fetchContentReports,
  hidePhoto,
  hideReview,
  resolveContentReport,
} from "../services/socialPortfolioApi.js";

export default function AdminContentModeration() {
  const user = getStoredUser();
  const token = getStoredToken();
  const [reports, setReports] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [busyId, setBusyId] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const j = await fetchContentReports();
      setReports(Array.isArray(j?.reports) ? j.reports : []);
    } catch (e) {
      setError(e?.message || "Failed to load reports");
      setReports([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (!user || !token || (user.role !== "admin" && user.role !== "super_admin")) {
    return <Navigate to="/login" replace />;
  }

  const act = async (report, action) => {
    setBusyId(report.id);
    try {
      if (action === "hide") {
        if (report.targetType === "review") await hideReview(report.targetId);
        else await hidePhoto(report.targetId);
        await resolveContentReport(report.id, { status: "action_taken" });
      } else {
        await resolveContentReport(report.id, { status: "dismissed" });
      }
      await load();
    } catch (e) {
      setError(e?.message || "Action failed");
    } finally {
      setBusyId("");
    }
  };

  return (
    <Page>
      <PageHeader
        title="Content moderation"
        subtitle="Review reported photos and reviews"
        right={
          <Link to="/admin" style={{ color: theme.colors.text, fontWeight: 800 }}>
            ← Admin
          </Link>
        }
      />
      {loading ? <p style={{ color: theme.colors.muted, marginTop: 16 }}>Loading…</p> : null}
      {error ? <p style={{ color: "#f87171", marginTop: 16 }}>{error}</p> : null}
      {!loading && !reports.length ? (
        <p style={{ color: theme.colors.muted, marginTop: 16 }}>No pending reports.</p>
      ) : null}
      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        {reports.map((report) => (
          <Card key={report.id}>
            <CardTitle>
              {report.targetType === "review" ? "Review" : "Photo"} · {report.reason}
            </CardTitle>
            <p style={{ color: theme.colors.muted, fontSize: 14, marginTop: 8 }}>
              Target: {report.targetId}
              {report.details ? (
                <>
                  <br />
                  {report.details}
                </>
              ) : null}
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <Button
                variant="ghost"
                type="button"
                disabled={busyId === report.id}
                onClick={() => {
                  if (window.confirm("Hide this content from public view?")) void act(report, "hide");
                }}
              >
                Hide content
              </Button>
              <Button variant="ghost" type="button" disabled={busyId === report.id} onClick={() => void act(report, "dismiss")}>
                Dismiss
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </Page>
  );
}
