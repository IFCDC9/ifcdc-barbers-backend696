import WebSocket from "ws"
import { SHOP_CONTEXT } from "./shopContext.js"
import { createRequire } from "module"

const requireCjs = createRequire(import.meta.url)
const { createMulawSpeechGate } = requireCjs("../../auraVoiceNoiseControl.cjs")

const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview"

const buildOpenAIRealtimeUrl = () => {
  const base = new URL("https://api.openai.com/v1/realtime")
  base.searchParams.set("model", OPENAI_REALTIME_MODEL)
  return base.toString().replace(/^https:/i, "wss:")
}

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const vadThreshold = ({ assistantSpeaking }) => {
  // Higher while AURA speaks (fewer false barge-ins); lower while listening (soft callers)
  const listen = Number(process.env.AURA_REALTIME_VAD_THRESHOLD || 0.55)
  const barge = Number(process.env.AURA_REALTIME_VAD_BARGE_THRESHOLD || 0.72)
  const n = assistantSpeaking ? barge : listen
  return Number.isFinite(n) ? Math.min(0.9, Math.max(0.3, n)) : assistantSpeaking ? 0.72 : 0.55
}

const buildSystemPrompt = () => {
  return [
    SHOP_CONTEXT.trim(),
    "Understand caller intent instantly and keep responses short.",
    "Ask only one follow-up question at a time.",
    "Help with booking, queue status, barber requests, and shop information.",
    "Use the shop details above when answering questions about barbers, pricing, and hours.",
    "Lock onto the primary near-field caller. Ignore television, music, radio, clippers, dryers, and distant chatter.",
    "If multiple voices are loud, ask the caller to speak directly into the phone.",
    "If audio is unclear, ask them to repeat — never invent names, dates, times, prices, services, or phone numbers.",
    "Confirm appointment date, time, barber, and service before booking.",
    "Never say a booking is confirmed until the booking tool returns success.",
    "If you need more than a moment to look something up, say a brief acknowledgment first."
  ].join(" ")
}

export const attachTwilioRealtimeBridge = ({ server, path = "/api/voice/media-stream" }) => {
  const wss = new WebSocket.Server({ noServer: true })

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url, "http://localhost")

    if (requestUrl.pathname !== path) {
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request)
    })
  })

  wss.on("connection", (twilioWs) => {
    const hasOpenAI = Boolean(process.env.OPENAI_API_KEY)
    let streamSid = null
    let openaiWs = null
    let isClosed = false
    let assistantSpeaking = false
    let assistantIdleTimer = null
    const speechGate = createMulawSpeechGate()
    let lastVadMode = null

    const markAssistantSpeaking = (ms = 1200) => {
      assistantSpeaking = true
      if (assistantIdleTimer) clearTimeout(assistantIdleTimer)
      assistantIdleTimer = setTimeout(() => {
        assistantSpeaking = false
      }, ms)
    }

    const pushVadSession = () => {
      const mode = assistantSpeaking ? "barge" : "listen"
      if (mode === lastVadMode) return
      lastVadMode = mode
      sendToOpenAI({
        type: "session.update",
        session: {
          turn_detection: {
            type: "server_vad",
            threshold: vadThreshold({ assistantSpeaking }),
            prefix_padding_ms: 160,
            silence_duration_ms: assistantSpeaking ? 500 : 400,
            interrupt_response: true
          }
        }
      })
    }

    const closeAll = () => {
      if (isClosed) return
      isClosed = true
      if (assistantIdleTimer) clearTimeout(assistantIdleTimer)

      try {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.close()
        }
      } catch {}

      try {
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.close()
        }
      } catch {}
    }

    const sendToTwilio = (payload) => {
      if (twilioWs.readyState !== WebSocket.OPEN) return
      twilioWs.send(JSON.stringify(payload))
    }

    const sendToOpenAI = (payload) => {
      if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return
      openaiWs.send(JSON.stringify(payload))
    }

    if (hasOpenAI) {
      openaiWs = new WebSocket(buildOpenAIRealtimeUrl(), {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      })

      openaiWs.on("open", () => {
        sendToOpenAI({
          type: "session.update",
          session: {
            instructions: buildSystemPrompt(),
            modalities: ["audio", "text"],
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            turn_detection: {
              type: "server_vad",
              threshold: vadThreshold({ assistantSpeaking: false }),
              prefix_padding_ms: 160,
              silence_duration_ms: 400,
              interrupt_response: true
            },
            voice: "alloy"
          }
        })
        lastVadMode = "listen"
        sendToOpenAI({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions:
              "Greet the caller now with a complete professional IFCDC Barbers App greeting as AURA. Ask only one question at the end: how you may help today."
          }
        })
      })

      openaiWs.on("message", (raw) => {
        const event = safeJsonParse(raw)
        if (!event) return

        if (event.type === "response.audio.delta" && event.delta && streamSid) {
          markAssistantSpeaking(900)
          pushVadSession()
          sendToTwilio({
            event: "media",
            streamSid,
            media: {
              payload: event.delta
            }
          })
        }

        if (event.type === "response.audio.done" || event.type === "response.done") {
          markAssistantSpeaking(350)
          setTimeout(() => pushVadSession(), 360)
        }

        if (event.type === "input_audio_buffer.speech_started" && streamSid) {
          // Only clear playback after sustained near-field speech (energy gate enforces ~300ms while speaking)
          sendToTwilio({ event: "clear", streamSid })
        }
      })

      openaiWs.on("close", closeAll)
      openaiWs.on("error", (error) => {
        console.error("OpenAI realtime socket error:", error.message)
      })
    }

    twilioWs.on("message", (raw) => {
      const event = safeJsonParse(raw)
      if (!event) return

      if (event.event === "start") {
        streamSid = event.start?.streamSid || streamSid
      }

      if (event.event === "media" && hasOpenAI) {
        const payload = event.media?.payload
        if (
          !speechGate.shouldForward(payload, {
            assistantSpeaking
          })
        ) {
          return
        }
        sendToOpenAI({
          type: "input_audio_buffer.append",
          audio: payload
        })
      }

      if (event.event === "stop") {
        closeAll()
      }
    })

    twilioWs.on("close", closeAll)
    twilioWs.on("error", (error) => {
      console.error("Twilio media socket error:", error.message)
      closeAll()
    })
  })

  return wss
}
