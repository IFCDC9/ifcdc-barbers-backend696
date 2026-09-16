# AURA Voicebox tests 1–17

2026-09-16T15:23:34.462Z

1. Live Voicebox GET /health: PASS
2. VOICEBOX_PRIMARY default 0: PASS
3. AURA founder-approved profile not cloned: PASS
4. speak() maps to /generate or /generate/stream: PASS
5. EN language mapping: PASS
6. ES language mapping: PASS
7. HE language mapping: PASS
8. Language change keeps booking ledger: PASS
9. Same Sample A profile EN/ES; HE Polly fallback: PASS
10. Timeout automatic fallback: PASS
11. Invalid audio automatic fallback: PASS
12. Outage fallback (no dropped call): PASS
13. Pronunciation IFCDC / Aura / time: PASS
14. Barge-in cancel: PASS
15. Per-conversation queue: PASS
16. HQ VOICEBOX STATUS fields: PASS
17. Booking unchanged; primary off uses Polly: PASS
