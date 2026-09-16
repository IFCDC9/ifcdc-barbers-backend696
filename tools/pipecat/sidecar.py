#!/usr/bin/env python3
"""
AURA × Pipecat sidecar — orchestration only.

Streaming, turn detection, barge-in, cancel, silence, pacing,
language switch, recovery. Does NOT replace Aura brain, booking,
Twilio console config, or Voicebox Sample A (Kokoro af_heart).

Bind: 127.0.0.1:8766 (PIPECAT_SIDECAR_URL).
PIPECAT_ENABLED default is off in Node. Do not set VOICEBOX_PRIMARY=1 here.
"""

from __future__ import annotations

import json
import math
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HOST = os.environ.get("PIPECAT_SIDECAR_HOST", "127.0.0.1")
PORT = int(os.environ.get("PIPECAT_SIDECAR_PORT", "8766"))

PIPECAT_IMPORT_ERROR = None
PIPECAT_VERSION = None
try:
    import pipecat  # type: ignore

    PIPECAT_VERSION = getattr(pipecat, "__version__", "installed")
except Exception as exc:  # noqa: BLE001 — sidecar must boot without 3.11+/torch
    PIPECAT_IMPORT_ERROR = str(exc)[:240]

STATE = {
    "cancels": 0,
    "interrupts": 0,
    "language": {},
    "recovered": 0,
}


def rms_u8(samples):
    if not samples:
        return 0.0
    acc = 0.0
    for b in samples:
        x = (b - 128) / 128.0
        acc += x * x
    return math.sqrt(acc / len(samples))


def json_bytes(obj, status=200):
    body = json.dumps(obj).encode("utf-8")
    return status, body


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[aura/pipecat-sidecar] " + (fmt % args) + "\n")

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _send(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/health"):
            status, body = json_bytes(
                {
                    "ok": True,
                    "status": "healthy",
                    "service": "aura-pipecat-sidecar",
                    "pipecatInstalled": PIPECAT_VERSION is not None,
                    "pipecatVersion": PIPECAT_VERSION,
                    "pipecatImportError": PIPECAT_IMPORT_ERROR,
                    "role": "orchestration_only",
                    "publicName": "Aura",
                    "sample": "A",
                    "voiceboxPrimary": 0,
                    "productionActivation": "OFF",
                }
            )
            self._send(status, body)
            return
        self._send(*json_bytes({"ok": False, "error": "not_found"}, 404))

    def do_POST(self):
        path = urlparse(self.path).path
        payload = self._read_json()
        conv = str(payload.get("conversationId") or payload.get("callSid") or "")

        if path == "/turn":
            samples = payload.get("samples") or payload.get("pcm") or []
            if isinstance(samples, str):
                samples = list(samples.encode("latin1"))
            energy = rms_u8([int(x) & 255 for x in samples] if isinstance(samples, list) else [])
            speaking = energy >= float(payload.get("bargeInRms") or 0.04)
            silence_ms = 0 if speaking else int(payload.get("silenceMs") or 650)
            end_of_turn = (not speaking) and silence_ms >= int(payload.get("endSilenceMs") or 650)
            self._send(
                *json_bytes(
                    {
                        "ok": True,
                        "speaking": speaking,
                        "endOfTurn": end_of_turn,
                        "bargeIn": speaking,
                        "rms": round(energy, 5),
                        "silenceMs": 0 if speaking else silence_ms,
                    }
                )
            )
            return

        if path == "/interrupt":
            STATE["interrupts"] += 1
            self._send(*json_bytes({"ok": True, "cancelled": True, "conversationId": conv}))
            return

        if path == "/cancel":
            STATE["cancels"] += 1
            self._send(*json_bytes({"ok": True, "cancelled": True, "conversationId": conv}))
            return

        if path == "/language":
            lang = str(payload.get("language") or "en").split("-")[0].lower()
            if lang == "iw":
                lang = "he"
            if lang not in ("en", "es", "he"):
                lang = "en"
            STATE["language"][conv or "_"] = lang
            self._send(
                *json_bytes(
                    {
                        "ok": True,
                        "language": lang,
                        "bookingPreserved": True,
                        "note": "Language switch does not wipe the booking ledger (ledger lives in Node).",
                    }
                )
            )
            return

        if path == "/recover":
            STATE["recovered"] += 1
            self._send(
                *json_bytes(
                    {
                        "ok": True,
                        "recovered": True,
                        "fallback": "polly",
                        "reason": str(payload.get("reason") or "error")[:120],
                    }
                )
            )
            return

        if path == "/pace":
            text = str(payload.get("text") or "").strip()
            self._send(
                *json_bytes(
                    {
                        "ok": True,
                        "text": text,
                        "note": "Pacing/chunking is decided in Node (ack + rest) so Sample A is not chopped mid-sentence.",
                    }
                )
            )
            return

        self._send(*json_bytes({"ok": False, "error": "not_found"}, 404))


def main():
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        json.dumps(
            {
                "event": "listen",
                "url": "http://%s:%s" % (HOST, PORT),
                "pipecatInstalled": PIPECAT_VERSION is not None,
                "pipecatVersion": PIPECAT_VERSION,
                "productionActivation": "OFF",
            }
        ),
        flush=True,
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()
