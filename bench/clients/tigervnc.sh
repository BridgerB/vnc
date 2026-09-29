#!/usr/bin/env bash
# TigerVNC native viewer. DISPLAY is set by the harness (its own Xvfb).
exec xtigervncviewer -SecurityTypes None -PreferredEncoding ZRLE -Shared \
	127.0.0.1:5900
