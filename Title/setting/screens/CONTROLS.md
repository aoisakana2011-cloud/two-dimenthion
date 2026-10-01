# Shared screen controls

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
```

Place controls in a screen's HTML and style their dimensions/position/colors in
the shared CSS. Ranges use normalized `0..1` values; checkboxes are reserved for
the three `*Muted` keys. A range key must be numeric and a checkbox key boolean.

```html
<input class="volume" type="range" min="0" max="1" step="0.01"
  data-setting="audio.bgm" aria-label="BGM volume">
<input class="mute" type="checkbox" data-setting="audio.bgmMuted"
  aria-label="Mute BGM">
```

The compiler rejects unknown keys, duplicate declarations, mismatched control
types, external HTML resources, scripts, event-handler attributes, and values
outside the normalized range. Browser and Windows Native/WebView2 render the
validated HTML/CSS; a renderer-neutral tree remains for the SDL fallback. Both
players use the same setting keys and initial values.

Changed values are stored in player-local preferences, separate from scenario
variables and save slots. Master/channel volume is applied as a mix after each
scenario or asset's own gain, so adjusting the UI does not rewrite scenario
data. Voice currently has one shared channel; per-character voice mixing is not
part of this control set.
