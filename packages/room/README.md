# @hubble/room

Hubble's connection to the Aixia Innovation Day room: the table projector,
two TVs, the Logitech MX Brio camera, the RPLIDAR C1 lidar, Hue lights and
buttons, and team slots.

Everything spec-shaped lives in `src/spec.ts`; the rest of Hubble only sees
the `Room` interface, implemented by a live client (the organisers' planned
API), a legacy client (the room's current NUC API), and a replay of recorded
sessions. A spec-exact emulator lives in the app repo (`apps/room-emulator`).

Developed inside [hubble](https://github.com/Juliusolsson05/hubble), mounted
at `packages/room`. Issues are tracked in the root repo (#11).
