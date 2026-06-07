import AuraChat from "../components/AuraChat.jsx";

/** Dedicated AURA tab — matches TestFlight app (full-screen chat, not floating orb). */
export default function AuraPage() {
  return (
    <div className="ifcdc-aura-page">
      <h1 className="ifcdc-page-title">AURA</h1>
      <p className="ifcdc-page-lead">Your IFCDC booking assistant — same experience as the mobile app.</p>
      <div className="ifcdc-aura-page__panel">
        <AuraChat embedded />
      </div>
    </div>
  );
}
