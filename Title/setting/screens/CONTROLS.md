# Shared screen controls

Keep the initial value for each setting here. Screen `<input>` elements should not
repeat those values in their `value` attributes. The compiler packages a control
schema from this file; Browser and Native use that schema to validate player preferences.

`game-screens.json` points to `screens/ui-controls.txt`. That file declares the
initial values and the exact setting keys available to screen templates. It is
not executable code, and it cannot declare arbitrary application or OS settings.

```text
audio.master=1
audio.bgm=0.8
audio.se=1
audio.voice=0.5
audio.bgmMuted=false
audio.seMuted=false
audio.voiceMuted=false
ui.dialogOpacity=1
ui.skipUnseen=true
ui.autoAfterChoice=true
ui.skipAfterChoice=true
ui.autoSpeed=0.45
ui.textSpeed=1
ui.fullscreen=false
ui.effects=true
ui.cursorHideDelay=1
ui.fontFamily=default
ui.shortcut.F1=system
ui.shortcut.F2=save
ui.shortcut.F3=load
ui.shortcut.F4=replay-voice
ui.shortcut.F5=auto
ui.shortcut.F6=clear-text
ui.shortcut.F7=fullscreen
ui.shortcut.F8=skip
ui.shortcut.F9=quick-save
ui.shortcut.F10=history
ui.shortcut.F11=quick-load
ui.shortcut.F12=none
```

Place controls in a screen's HTML and style their dimensions/position/colors in
the shared CSS. Ranges use normalized `0..1` values; checkboxes are for boolean
keys. A range key must be numeric and a checkbox key boolean. Playback settings
supported by both players:

Range `step` values must be at least `Number.EPSILON` (`2.220446049250313e-16`)
so the shared Browser/Native control can represent and apply each increment.

| Key | Type | Runtime effect |
| --- | --- | --- |
| `ui.skipUnseen` | checkbox | When enabled, SKIP advances read dialogue only and stops at the first unseen line. |
| `ui.autoAfterChoice` | checkbox | Stop AUTO after a choice is selected. |
| `ui.skipAfterChoice` | checkbox | Stop SKIP after a choice is selected. |
| `ui.autoSpeed` | range | Normalized delay from about 8.5 s (`0`) to 0.9 s (`1`) per line. |
| `ui.textSpeed` | range | Character reveal rate. `1` displays dialogue immediately; lower values reveal it progressively. |
| `ui.fullscreen` | checkbox | Switch the Browser player to the Fullscreen API or the Native window to SDL fullscreen. |
| `ui.effects` | checkbox | Enable or bypass character/effect fade transitions. |
| `ui.cursorHideDelay` | range | Cursor timeout: `0` disables hiding; the three equal steps select 5, 10, or 20 seconds. |
| `ui.fontFamily` | enum | `default`, `gothic`, or `mincho`; changes the player text family and persists per player. Native uses the matching installed Windows Japanese font. |

The `reset-window-size` button action restores the project's authored reference
window dimensions and exits fullscreen. Native applies the window size directly.
Browser requests a window resize; browsers only honor that request for windows
they permit scripts to resize (such as a desktop-player window).

These values persist in player-local preferences, independently of scenario
state and numbered save slots. Opening the in-game pause menu suspends AUTO and
SKIP in both Browser and Native; either mode can be started again from the menu.

```html
<input class="volume" type="range" min="0" max="1" step="0.01"
  data-setting="audio.bgm" aria-label="BGM volume">
<input class="mute" type="checkbox" data-setting="audio.bgmMuted"
  aria-label="Mute BGM">
```

## Image skins

Optional image skins replace the visual parts of a range or checkbox while
keeping the same validated setting, keyboard semantics, and persisted value in
Browser and Native. Declare them in `game-screens.json`, then reference one on
an input with `data-skin`:

```json
{
  "controlSkins": {
    "volume": {
      "type": "range",
      "track": "ui/controls/volume/track.png",
      "fill": "ui/controls/volume/fill.png",
      "thumb": "ui/controls/volume/thumb.png",
      "thumbHover": "ui/controls/volume/thumb-hover.png",
      "trackHeight": 8,
      "thumbWidth": 28,
      "thumbHeight": 28,
      "inset": 14,
      "orientation": "horizontal"
    },
    "mute": {
      "type": "checkbox",
      "off": "ui/controls/volume/mute-off.png",
      "on": "ui/controls/volume/mute-on.png"
    }
  }
}
```

```html
<input type="range" min="0" max="1" step="0.01"
  data-setting="audio.bgm" data-skin="volume" aria-label="BGM volume">
<input type="checkbox" data-setting="audio.bgmMuted"
  data-skin="mute" aria-label="Mute BGM">
```

Skin images are project-relative paths under `asset/`; the packager includes
them automatically. Range skins stretch the track and fill along the selected
axis and use fixed-size thumbs. Set `orientation` to `vertical` for a bottom-to-
top range; it defaults to `horizontal`. `inset` reserves the thumb radius at
both ends for matching pointer/value geometry. Optional checkbox states are
`offHover` and `onHover`; range supports `thumbHover`. This version does not
provide nine-slice, atlas cropping, disabled-state art, or arbitrary custom
interaction scripts. Keep labels as text, not baked into art.

The compiler rejects unknown keys, duplicate declarations, mismatched control
types, external HTML resources, scripts, event-handler attributes, and values
outside the normalized range. Browser renders the validated screen tree as DOM;
the Windows Native player draws the same tree with SDL. Both use the same
setting keys, initial values, image assets, and input geometry.

Changed values are stored in player-local preferences, separate from scenario
variables and numbered save slots. Quick Save/Quick Load use one additional
player-local snapshot and do not consume a numbered slot. Master/channel volume is applied as a mix after each
scenario or asset's own gain, so adjusting the UI does not rewrite scenario
data. Voice currently has one shared channel; per-character voice mixing is not
part of this control set.

The reference SYSTEM page's text-speed control is a runtime preference shared
by Browser and Native. Each F1-F12 binding is editable from the SYSTEM page;
click its current action to cycle through the safe actions listed below. The
selected values persist in player-local preferences and are shared by Browser
and Native. F12 defaults to `none` but can be assigned like the other keys.

| Shortcut value | Action |
| --- | --- |
| `none` | No action |
| `system` | Open SYSTEM |
| `save`, `load` | Open the matching slot screen |
| `replay-voice` | Replay the most recent voice with its original speaker-volume routing |
| `auto`, `skip` | Start or stop the matching playback mode |
| `clear-text` | Clear the visible dialogue text |
| `fullscreen` | Toggle fullscreen |
| `quick-save`, `quick-load` | Use the player-local quick slot |
| `history` | Open LOG |

The project defaults are declared as `ui.shortcut.F1` through
`ui.shortcut.F12` in this file. Values must be one of the actions above; keys
outside F1-F12 and arbitrary commands are rejected. The in-game SYSTEM buttons
cycle values in this order: `none`, `system`, `save`, `load`, `replay-voice`,
`auto`, `clear-text`, `fullscreen`, `skip`, `quick-save`, `history`,
`quick-load`.

The in-game MENU's LOG action opens the project-defined `log` screen. Its
`data-role="dialogue-history"` element is populated from the same runtime
speaker/text history in Browser and Native (newest 500 lines); Browser scrolls
the history region and Native scrolls it with the mouse wheel. HOLD is a
playback latch: while active, dialogue clicks, keyboard advance, and NEXT do
not consume a line. Open MENU and press HOLD again to release it; releasing
HOLD does not advance by itself. Starting AUTO or SKIP also releases HOLD.
