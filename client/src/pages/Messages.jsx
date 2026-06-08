import { useNavigate } from "react-router-dom";

/**
 * In-app messaging hub (AURA-first). No dialer or public phone numbers.
 * Legacy /phone redirects here; nav tab is "Messaging".
 */
export default function Messages() {
  const navigate = useNavigate();

  const goMessages = () => {
    navigate("/messages", { replace: true });
  };

  const startChat = () => {
    navigate("/aura", { replace: false });
  };

  const viewConversations = () => {
    goMessages();
    window.setTimeout(() => {
      document.getElementById("messages-conversations")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  };

  return (
    <div className="page messages-page">
      <h1 className="messages-page__title">MESSAGING</h1>
      <p className="messages-page__subtitle">Talk to AURA or your barber instantly</p>
      <p className="messages-page__status messages-page__status--connected" role="status">
        Connected
      </p>

      <div className="messages-page__card glass-card">
        <button type="button" className="aura-action-panel__btn messages-page__btn" onClick={startChat}>
          Start Chat
        </button>
        <button type="button" className="aura-action-panel__btn messages-page__btn" onClick={viewConversations}>
          View Conversations
        </button>
      </div>

      <div id="messages-conversations" className="messages-page__inbox glass-card">
        <h2 className="messages-page__inbox-title">Conversations</h2>
        <p className="messages-page__inbox-empty">No threads yet. Start a chat with AURA to begin.</p>
      </div>
    </div>
  );
}
