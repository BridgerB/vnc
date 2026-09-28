# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A **web-based VNC (RFB) client**: a SvelteKit app (**Svelte 5** + TypeScript, `@sveltejs/adapter-node`) whose Node backend speaks the raw RFB protocol to a VNC server over TCP and streams decoded framebuffer rectangles to the browser, which paints them on a `<canvas>`. Built to replace desktop viewers like TigerVNC. Tested against WayVNC (2560×1440, 32bpp) reached through an SSH tunnel on `127.0.0.1:5900`.

## VNC architecture

The data path is: **VNC server → TCP → RfbClient (Node) → WebSocket bridge → browser canvas**.

- `src/lib/server/vnc/rfb-client.js` — the RFB protocol state machine (`RfbClient extends EventEmitter`). Handles the 3.3/3.7/3.8 handshake (None + VNC-auth DES), requests a **32bpp true-colour pixel format with byte order R,G,B,X** (so decoded bytes drop straight into a browser `ImageData`, alpha forced to 255), and parses `FramebufferUpdate` messages. It emits `init`/`resize`/`rect`/`cursor`/`bell`/`cuttext`/`updateDone`. Input methods: `pointerEvent`, `keyEvent`, `cutText`, `requestUpdate`.
- `src/lib/server/vnc/decoders.js` — pixel decoders producing RGBA: **Raw**, **CopyRect** (handled inline in the client as a canvas blit), **ZRLE** (the main compressed encoding — see below), and the **Cursor** pseudo-encoding. Encodings requested, in order: `[CopyRect, ZRLE, Raw, Cursor, DesktopSize]`.
- `src/lib/server/vnc/bridge.js` — wires one `RfbClient` to one browser WebSocket. Browser framing: JSON control frames (`init`/`resize`/`frame`/`bell`/`cuttext`/`error`) + binary pixel frames (`tag 1`=raw RGBA rect, `tag 2`=copyrect, `tag 3`=cursor). Browser→server is JSON (`pointer`/`key`/`cuttext`/`refresh`). It drives the **pull loop**: after each `updateDone` it requests the next incremental update (non-incremental until the first real pixels arrive — WayVNC answers the first full request with an ExtDesktopSize-only update).
- `src/lib/server/vnc/vite-plugin.js` — attaches a `ws` server at the **`/vnc`** upgrade path on Vite's own HTTP server (dev + preview), so the browser connects same-origin: `ws://<host>/vnc?host=&port=&password=`. Only loopback/RFC1918 targets are allowed. **This module is loaded once at server start and is NOT hot-reloaded — restart `npm run dev` after editing anything under `src/lib/server/vnc/`.**

Frontend: `src/routes/+page.svelte` composes `ConnectionManager.svelte` (saved profiles/recents/quick-connect, persisted via `src/lib/vnc/profiles.js` → localStorage), `Toolbar.svelte` (Ctrl-Alt-Del, special-keys menu, paste, refresh, screenshot, fullscreen, view-only, scale mode, auto-reconnect, stats), and `VncViewer.svelte` (canvas rendering, input, scaling, clipboard, bell, client-side cursor, auto-reconnect, fps/KB-s stats). Browser keyboard events map to X11 keysyms in `src/lib/keysym.js`.

### Two ZRLE gotchas (from RFC 6143)
- **One persistent zlib stream for the whole connection** — `RfbClient._inflate` (a `pako.Inflate`) is fed every ZRLE rect's bytes with `Z_SYNC_FLUSH` and is never reset.
- Inside a tile, a **CPIXEL is 3 bytes** (`[R,G,B]`) because the negotiated depth-24 format leaves the top byte zero.

### Dev-server port
`@bridgerb/port-from-name`'s `autoPort()` gives this project a stable port derived from its name — **4734** for `vnc` (not Vite's 5173).

## Commands

- `npm run dev` — dev server (`-- --open` to open a browser)
- `npm run build` / `npm run preview` — production build / preview it
- `npm run check` — `svelte-check` type/diagnostics pass (runs `svelte-kit sync` first)
- `npm run test` — full suite: unit (`--run`) then e2e
- `npm run test:unit` — Vitest in watch mode; append `-- --run` for one-shot, `-- <path>` to target a file, or `-- --project=client`/`--project=server` to pick a suite
- `npm run test:e2e` — Playwright (installs browsers first)

`.npmrc` sets `engine-strict=true`, so Node/npm engine mismatches will fail installs.

## Testing architecture

`vite.config.ts` defines **two Vitest projects**, split by filename:
- **client** — runs in a real Chromium browser (Playwright provider), for `src/**/*.svelte.{test,spec}.{ts,js}` (component tests). Excludes `src/lib/server/**`.
- **server** — runs in Node, for all other `src/**/*.{test,spec}.{ts,js}`.

So the `.svelte.` infix in a test filename decides whether it runs in-browser or in Node — name accordingly.

Playwright **e2e** tests are separate (`*.e2e.{ts,js}`, `playwright.config.ts`) and run against the built+previewed app on port 4173.

## Conventions

- **Runes mode is forced** for all non-`node_modules` files (`vite.config.ts` compiler option). Use Svelte 5 runes (`$props`, `$state`, `$derived`, etc.); legacy `export let` / reactive `$:` will not work.
- `$lib` → `src/lib`. Put server-only code under `src/lib/server/` (excluded from browser test builds).
- `App` namespace interfaces (`Locals`, `PageData`, etc.) are declared in `src/app.d.ts`.
