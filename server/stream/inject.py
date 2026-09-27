#!/usr/bin/env python3
# Persistent virtual input device for Relay. Reads simple commands on stdin and
# injects them via uinput (kernel level -> works in games; held keys stay held).
#   a <x> <y>       absolute pointer (x,y in 0..65535, resolution-independent)
#   m <dx> <dy>     relative pointer move (game/pointer-lock mode)
#   d <btn> / u <btn>   button 0=left 1=right 2=middle down/up
#   w <v>           vertical wheel (+up/-down), hw <v> horizontal
#   kd <code> / ku <code>   key down/up (Linux input keycode)
import sys
from evdev import UInput, AbsInfo, ecodes as e

BTN = {0: e.BTN_LEFT, 1: e.BTN_RIGHT, 2: e.BTN_MIDDLE}
# Absolute range is normalized 0..65535 so the client is resolution-independent;
# libinput maps it across the output.
cap = {
    e.EV_ABS: [
        (e.ABS_X, AbsInfo(0, 0, 65535, 0, 0, 0)),
        (e.ABS_Y, AbsInfo(0, 0, 65535, 0, 0, 0)),
    ],
    e.EV_REL: [e.REL_X, e.REL_Y, e.REL_WHEEL, e.REL_HWHEEL],
    e.EV_KEY: [e.BTN_LEFT, e.BTN_RIGHT, e.BTN_MIDDLE] + list(range(1, 249)),
}
ui = UInput(cap, name="relay-virtual-input")
sys.stderr.write("relay uinput ready\n"); sys.stderr.flush()

for line in sys.stdin:
    p = line.split()
    if not p:
        continue
    try:
        c = p[0]
        if c == "a":
            ui.write(e.EV_ABS, e.ABS_X, int(p[1])); ui.write(e.EV_ABS, e.ABS_Y, int(p[2]))
        elif c == "m":
            ui.write(e.EV_REL, e.REL_X, int(p[1])); ui.write(e.EV_REL, e.REL_Y, int(p[2]))
        elif c == "d":
            ui.write(e.EV_KEY, BTN[int(p[1])], 1)
        elif c == "u":
            ui.write(e.EV_KEY, BTN[int(p[1])], 0)
        elif c == "w":
            ui.write(e.EV_REL, e.REL_WHEEL, int(p[1]))
        elif c == "hw":
            ui.write(e.EV_REL, e.REL_HWHEEL, int(p[1]))
        elif c == "kd":
            ui.write(e.EV_KEY, int(p[1]), 1)
        elif c == "ku":
            ui.write(e.EV_KEY, int(p[1]), 0)
        ui.syn()
    except Exception as ex:
        sys.stderr.write(f"err {line!r}: {ex}\n"); sys.stderr.flush()
