# Relay

A self-hosted **remote desktop that runs in the browser**. Relay speaks the raw VNC (RFB) protocol from a Node backend and streams the framebuffer to an HTML canvas, and — on a Linux/Wayland host with an NVIDIA GPU — adds a second, **low-latency H.264 path** (NVENC → WebCodecs) fast enough for video and games. One dashboard, two transports, no native client to install.

Built to replace desktop viewers like TigerVNC while going further than any of them: hardware-encoded streaming, kernel-level input, and a modern web UI, all self-hosted and open.

> Status: works end to end. VNC is stable against standard servers; the H.264 stream targets wlroots + NVENC hosts. See [Roadmap](#roadmap).

## Why Relay

Most remote-desktop tools are either a native app you install per machine (TigerVNC, Remmina, NoMachine, X2Go) or a browser VNC client with no server story (noVNC). Relay is a single web app you host once and open from any browser, and it doesn't stop at RFB — when the host can encode H.264 in hardware, Relay switches to a real video pipeline for motion-heavy work.

| | In browser | Protocols | Hardware H.264 | Self-hosted | Open source |
|---|:--:|---|:--:|:--:|:--:|
| **Relay** | ✅ | VNC (RFB) + H.264 stream | ✅ (NVENC) | ✅ | ✅ |
| TigerVNC | ❌ | VNC (RFB) | ❌ | ✅ | ✅ |
| Remmina | ❌ | VNC / RDP / SSH / SPICE | via RDP | ✅ | ✅ |
| noVNC | ✅ | VNC (RFB) | ❌ | ✅ | ✅ |
| NoMachine | partial | NX | ✅ | ✅ | ❌ |
| X2Go | ❌ | NX (X11) | ❌ | ✅ | ✅ |

## Features

**VNC (works with any RFB server — TigerVNC, x11vnc, wayvnc, macOS Screen Sharing, …)**
- RFB 3.3 / 3.7 / 3.8 handshake, `None` and VNC-auth (DES) security
- Decoders: Raw, CopyRect, ZRLE (single persistent zlib stream), and the Cursor pseudo-encoding
- 32bpp true-colour, tear-free **double-buffered** canvas painting
- Clipboard sync (both ways), bell, client-side cursor, and auto-reconnect with backoff
- Scaling (fit / 1:1 / stretch), fullscreen, view-only, PNG screenshots
- Send-keys palette: Ctrl-Alt-Del, function keys, latching modifiers

**H.264 stream (low-latency path for video and gaming)**
- Host captures the Wayland desktop and encodes with **NVENC** (ultra-low-latency CBR, no B-frames)
- Browser decodes with **WebCodecs** (hardware) and paints the newest frame at display refresh, so decode is decoupled from paint — no build-up under motion
- **Absolute pointer with a native browser cursor** — the cursor is instant, it never waits on a round trip
- **Kernel-level input** via `uinput` (evdev): held keys stay held, mouse buttons and wheel work, suitable for games

**Dashboard**
- Machine cards with live reachability probes and thumbnail previews
- Quick-connect (`host:port` or `user@host:port`), saved profiles, tags and groups
- Import / export profiles as JSON; everything persists to `localStorage`
- Floating in-session toolbar and a stats HUD (fps / bandwidth / resolution)

## Architecture

**VNC path** — the browser connects same-origin; the SvelteKit server bridges to the VNC server over TCP:

```
VNC server ──TCP──▶ RfbClient (Node) ──WebSocket──▶ browser <canvas>
```

**Stream path** — the browser connects straight to a small server on the host:

```
Wayland desktop ─▶ NVENC (H.264) ─▶ WebSocket ─▶ WebCodecs ─▶ <canvas>
        browser input ─────────────▶ uinput (evdev) injection
```

Key modules:
- `src/lib/server/vnc/` — the RFB state machine, pixel decoders, the browser WebSocket bridge, and the Vite plugin that mounts it at `/vnc`.
- `src/lib/StreamViewer.svelte` / `src/lib/VncViewer.svelte` — the two viewers, behind one shared `Viewer` interface (`src/lib/types.ts`), so the session shell drives either.
- `server/stream/` — the host-side H.264 streamer (`index.ts`) and its `uinput` input helper (`inject.py`).

## Quick start

Requires Node ≥ 22.6 (for native `.ts`) and npm.

```sh
npm install
npm run dev        # dev server; append -- --open to launch a browser
```

Open the app, add a machine (or quick-connect), and connect. VNC targets are restricted to loopback and private (RFC 1918) addresses — see [Security](#security).

Production build:

```sh
npm run build
npm run preview
```

## Setting up the H.264 stream host

The stream server runs **on the machine you want to view**. It expects:
- Linux with a **wlroots** Wayland compositor (Hyprland, Sway, …)
- an **NVIDIA GPU with NVENC**, plus `ffmpeg` (with `h264_nvenc`) and `wf-recorder`
- **Python 3** with `python-evdev`, and write access to `/dev/uinput` (add your user to the `input` group or install a udev rule)
- Node ≥ 22.6

Run it:

```sh
cd server/stream
npm install
HOST=<your-vpn-or-loopback-ip> node index.ts
```

It listens on `ws://<host>:4735`. Useful environment variables (all optional):

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `4735` | WebSocket port |
| `HOST` | `0.0.0.0` | bind address — set your VPN/loopback IP to avoid exposing it |
| `OUTPUT` | *(auto)* | wlroots output to capture (e.g. `DP-2`); unset picks the default |
| `BITRATE` / `GOP` / `PRESET` | `40M` / `120` / `p1` | NVENC tuning |
| `PYTHON` | `python3` | interpreter for the input helper (or set `PYENV` to a Python env dir) |

Then add a stream machine in the dashboard pointing at `<host>:4735`.

## Security

Relay never rolls its own transport crypto — it relies on the network layer, which is the right place for it:

- **VNC** is bridged same-origin through the SvelteKit server; put that server behind TLS (a reverse proxy) for remote use. The bridge and the reachability probe both **refuse any target that isn't loopback or RFC 1918**, so the app can't be used to reach arbitrary hosts.
- **The H.264 stream is not encrypted in-process by design.** Bind it to a **WireGuard/VPN interface** (or reach it over an **SSH tunnel**) and firewall the LAN. Over WireGuard the entire link is encrypted end to end and there's no cleartext video on the wire — which is also why the server needs no in-app auth token.

Do not expose the raw stream port to an untrusted network.

## Project layout

```
src/
  lib/
    types.ts              shared domain types (Profile, Settings, Viewer, …)
    VncViewer.svelte      RFB canvas viewer
    StreamViewer.svelte   WebCodecs H.264 viewer
    server/vnc/           RFB client, decoders, WebSocket bridge, Vite plugin
    stream/keycodes.js    KeyboardEvent.code → Linux keycodes
    ui/                   Icon sprite + primitives
    views/                Dashboard, Session, ConnectionModal, toolbar, panels
    vnc/                  profiles (localStorage) + host:port parsing
  routes/                 SvelteKit routes (+page, +layout, /api/ping)
server/stream/            host-side H.264 streamer + uinput helper
tests/                    Playwright e2e
```

## Development

| Command | What it does |
|---|---|
| `npm run dev` | dev server (stable port via `@bridgerb/port-from-name`) |
| `npm run build` / `npm run preview` | production build / preview it |
| `npm run check` | `svelte-check` (strict TypeScript) |
| `npm run lint` / `npm run format` | Biome lint / format-and-fix |
| `npm run test` | unit + component (Vitest) then e2e (Playwright) |

Tests are split by filename: `*.svelte.spec.ts` run in a real Chromium (component tests), everything else runs in Node, and `*.e2e.ts` are Playwright e2e against the built app.

## Tech stack

SvelteKit (Svelte 5 runes) · TypeScript · `@sveltejs/adapter-node` · `ws` · `pako` (zlib) · WebCodecs · NVENC / `wf-recorder` · evdev `uinput` · Vite · Vitest · Playwright · Biome.

## Roadmap

- Remove the residual server-side cursor from the captured video (KMS capture / `-cursor no`)
- Optional audio (PipeWire → Opus → WebAudio)
- Wire the send-keys palette and clipboard paste for the stream path
- HEVC/AV1 as opt-in codecs; dynamic bitrate to the link
- Pointer-lock relative mode for FPS games

## License

MIT — see [LICENSE](LICENSE).
