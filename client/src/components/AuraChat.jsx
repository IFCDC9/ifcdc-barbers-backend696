import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { fetchWithTimeout, apiUrl } from "../lib/api.js";
import { useAuraContactPhone } from "../lib/useAuraContactPhone.js";
import { applyAuraNavigateBookPrefill, AURA_STYLE_SESSION_KEY } from "../lib/auraBookingPrefill.js";
import { formatNanpUsDisplay, nanpDialString } from "../lib/formatNanp.js";
import "../styles/auraButton.css";

/** POST /api/aura — OpenAI-backed assistant (see root `server.js`). */
const AURA_CHAT_URL = apiUrl("/api/aura");

/** Speak assistant text aloud (Web Speech API). */
function speakAuraReply(reply) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const text = String(reply || "").replace(/\s+/g, " ").trim();
  if (!text) return;
  try {
    window.speechSynthesis.cancel();
    const speech = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(speech);
  } catch {
    /* ignore unsupported / blocked TTS */
  }
}

function readAuraChatBarberId() {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(AURA_STYLE_SESSION_KEY);
    if (!raw) return undefined;
    const j = JSON.parse(raw);
    const n = Number(j?.barberId);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function useHashNavigate() {
  return useCallback((to) => {
    let raw = String(to || "/").trim();
    if (raw.startsWith("#")) raw = raw.slice(1);
    let normalized = raw.trim() || "/";
    if (!normalized.startsWith("/")) normalized = `/${normalized}`;
    window.location.hash = `#${normalized}`;
  }, []);
}

export default function AuraChat({
  navigate: navigateProp,
  embedded = false,
  onRequestClose,
}) {
  const hashNavigate = useHashNavigate();
  const routerNavigate = useNavigate();
  const navigate = navigateProp ?? routerNavigate ?? hashNavigate;

  const auraPhoneRaw = useAuraContactPhone();
  const auraPhoneTel = nanpDialString(auraPhoneRaw);
  const auraPhoneDisplay = formatNanpUsDisplay(auraPhoneRaw);

  const [message, setMessage] = useState("");
  const [chat, setChat] = useState([]);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (!embedded) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [embedded, chat.length]);

  const sendMessage = async () => {
    const trimmed = String(message || "").trim();
    if (!trimmed || loading) return;
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const safeChat = Array.isArray(chat) ? chat : [];

    setLoading(true);
    setMessage("");
    setChat((prev) => [...prev, { id, user: trimmed, pending: true }]);
    queueMicrotask(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }));

    const setEntry = (patch) => {
      setChat((prev) => prev.map((c) => (c?.id === id ? { ...c, ...patch } : c)));
    };
    try {
      const prior = safeChat.flatMap((c) => [
        { role: "user", content: c.user },
        { role: "assistant", content: c.bot || (c.bookingNavigation ? "Booking suggestion ready." : "") },
      ]);
      const messages = [...prior, { role: "user", content: trimmed }];

      const barberId = readAuraChatBarberId();
      const res = await fetchWithTimeout(AURA_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: trimmed,
          messages,
          ...(barberId != null ? { barberId } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      const failMsg = "I'm having trouble right now, try again.";
      const fromServer = String(data.reply || "").trim();
      const bot = fromServer || failMsg;
      const action = String(data.action || "NONE").trim().toUpperCase();
      if (typeof navigate === "function") {
        if (action === "NAVIGATE_BOOK") {
          let navState = {};
          try {
            const { selectedStyle } = await applyAuraNavigateBookPrefill(trimmed);
            if (selectedStyle?.styleId) navState = { selectedStyle };
          } catch {
            /* prefill is best-effort */
          }
          navigate("/book", { state: navState });
        } else if (action === "NAVIGATE_STYLES") navigate("/booking");
      }
      setEntry({ pending: false, bot });
      queueMicrotask(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }));
    } catch {
      const errBot = "I'm having trouble right now, try again.";
      setEntry({ pending: false, bot: errBot });
      speakAuraReply(errBot);
    } finally {
      setLoading(false);
    }
  };

  const panel = (
    <div className="aura-chat-window">
      <div className="aura-chat-header">
        <div className="aura-chat-header-main">
          <div className="aura-chat-title">AURA</div>
          {auraPhoneTel ? (
            <div className="aura-chat-contact-block">
              <p className="aura-chat-contact-line">
                <a className="aura-chat-contact-digits" href={`tel:${auraPhoneTel}`}>
                  Call AURA
                </a>
                {" · "}
                <a className="aura-chat-contact-digits" href={`sms:${auraPhoneTel}`}>
                  Text AURA
                </a>
              </p>
              {auraPhoneDisplay ? (
                <p className="aura-chat-contact-display" aria-label={`AURA ${auraPhoneDisplay}`}>
                  {auraPhoneDisplay}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <button type="button" className="aura-chat-close" onClick={() => onRequestClose?.()}>
          Close
        </button>
      </div>

      <div ref={scrollRef} className="aura-chat-messages">
        {(Array.isArray(chat) ? chat : []).map((c) => (
          <div key={c.id} className="aura-chat-row">
            <div className="aura-bubble aura-bubble--user">
              <div className="aura-bubble__text">{c.user}</div>
            </div>
            <div className="aura-bubble aura-bubble--assistant">
              {c.pending ? (
                <div className="loading">
                  <p>AURA is finding your best option...</p>
                </div>
              ) : c.bookingNavigation ? (
                <div className="aura-response">
                  <p>Found the best barber for you.</p>
                  <button
                    type="button"
                    onClick={() => {
                      navigate(c.bookingNavigation.path, { state: c.bookingNavigation.state });
                      onRequestClose?.();
                    }}
                  >
                    Confirm Booking
                  </button>
                </div>
              ) : (
                <div className="aura-bubble__text">{c.bot}</div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="aura-chat">
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Ask AURA anything..."
          enterKeyHint="send"
          aria-label="Message to AURA"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void sendMessage();
            }
          }}
        />
        <button type="button" onClick={() => void sendMessage()} disabled={loading} aria-label="Send message">
          {loading ? "…" : "Send"}
        </button>
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div role="dialog" aria-modal="true" aria-label="AURA chat">
        {panel}
      </div>
    );
  }

  // Non-embedded mode is unused in the current app (we use Aura.jsx + aura-chat-dock).
  return null;
}
