import WebSocket from "ws"
import { SHOP_CONTEXT } from "./shopContext.js"
import { createRequire } from "module"

const requireCjs = createRequire(import.meta.url)
const { shouldForwardMulawFrame } = requireCjs("../../auraVoiceNoiseControl.cjs")

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

const vadThreshold = () => {
  const n = Number(process.env.AURA_REALTIME_VAD_THRESHOLD || 0.62)
  return Number.isFinite(n) ? Math.min(0.9, Math.max(0.3, n)) : 0.62
}

const buildSystemPrompt = () => {
  return [
    SHOP_CONTEXT.trim(),
    "Understand caller intent instantly and keep responses short.",
    "Ask only one follow-up question at a time.",
    "Help with booking, queue status, barber requests, and shop information.",
    "Use the shop details above when answering questions about barbers, pricing, and hours.",
    "If the primary caller clearly interrupts, stop speaking and listen.",
    "Ignore television, music, radio, and distant background chatter.",
    "If multiple voices are loud, ask the caller to speak directly into the phone.",
    "If audio is unclear, ask them to repeat — never invent names, dates, times, or phone numbers.",
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

    const markAssistantSpeaking = (ms = 1200) => {
      assistantSpeaking = true
      if (assistantIdleTimer) clearTimeout(assistantIdleTimer)
      assistantIdleTimer = setTimeout(() => {
        assistantSpeaking = false
      }, ms)
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
              // Higher threshold = fewer false barge-ins from TV/music/room noise
              threshold: vadThreshold(),
              prefix_padding_ms: 180,
              silence_duration_ms: 450,
              interrupt_response: true
            },
            voice: "alloy"
          }
        })
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
        }

        // Selective barge-in: only clear playback when speech is strong enough while AURA talks
        if (event.type === "input_audio_buffer.speech_started" && streamSid) {
          if (!assistantSpeaking) {
            sendToTwilio({ event: "clear", streamSid })
          } else {
            // Soft interrupt window — clear only if OpenAI already decided it was speech;
            // energy gate below reduces weak noise frames reaching the model.
            sendToTwilio({ event: "clear", streamSid })
          }
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
          !shouldForwardMulawFrame(payload, {
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
