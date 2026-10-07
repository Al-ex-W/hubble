# Room: differences between the spec we built against and the real room

Every place the real room turned out different from what we assumed, with the
evidence and the one place in code that absorbed it. Newest first.

| Date | What | Evidence | Fixed in |
|---|---|---|---|
| 2026-10-07 | Lidar Pi serves `/scan` and `/status`; gateway scan and metadata return 404 | 116-rotation wire recording in `fixtures/lidar/2026-10-07-wire`; organiser `d4d9c4c` | `spec.ts`, read-only `lidarSource.ts`; other room APIs remain unchanged |
| 2026-10-05 | The room's current backend passes light state straight to Hue v1 `PUT /lights/:id/state`, so colour is CIE `xy`, brightness 1–254; scenes are `POST /api/devices/hue/groups/:group/scene { sceneId }`, not by name | `third_party/aid-hackathon-room@ce1dfc9`: `backend/src/app.js` L139–160, `backend/src/devices/huebridge.js` L36–44 | `src/legacy.ts` (`hexToXy`, scene lookup) |
| 2026-10-05 | Display commands include `idle` (the room's rest picture) | organisers' `docs/aid-2026/SPEC.md` §4.2 and §5 | `src/spec.ts` `DisplayCommand` |
| 2026-10-05 | The gateway API (§5) is **planned, not built** in the repo; the repo is the lab backend (HTTPS 8443, self-signed, no tokens or slots, video-only display) | `SPEC.md` §3, §4.1; `backend/src/server.js` (https, PORT 8443) | `src/legacy.ts` keeps `show` unsupported |
| 2026-10-05 | Gateway is plain HTTP to teams; `room.local` via Avahi on the NUC; Pis are `pi-table`, `pi-tv-1`, `pi-tv-2`; camera MJPEG relayed by the gateway; internet only if the venue's ethernet reaches the router's WAN | `SPEC.md` §4.5 | nothing yet (matches our defaults); internet is a `room:check` item |
