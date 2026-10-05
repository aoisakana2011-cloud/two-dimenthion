# Screen UI rendering compatibility

This document describes the current implementation, not the intended feature set. A CSS declaration accepted by the parser is **not** automatically supported by every renderer.

## Rendering paths

| Path | Renderer | Purpose |
| --- | --- | --- |
| Editor preview | Browser DOM built from the compiled screen tree | Authoring and quick visual feedback |
| Browser player | Browser DOM built from the compiled screen tree | Browser playback and runtime tests |
| Desktop / packaged player | SDL-based Native renderer consuming the compiled screen tree | Native playback and distribution |

WebView2 is not a rendering path. Do not use it as the compatibility baseline.

## Current compatibility by layer

| Layer | Shared behavior | Important limits |
| --- | --- | --- |
| Canvas transform | `contain`, `cover`, and `stretch` use the shared reference-canvas transform; the editor can preview common aspect ratios | `cover` intentionally crops authored content; it does not reflow it |
| Geometry | The screen compiler calculates rectangles consumed by both paths; absolute placement and a subset of flex/grid are represented in that tree. Browser heading defaults are normalized in the tree so `h1`/`h2` margins cannot shift authored coordinates. `vw` / `vh` lengths are resolved against the logical reference canvas and normalized to px before layout | This is a small layout engine, not browser CSS layout. General margins, min/max constraints, wrapping, full grid tracks, and several accepted properties are not fully calculated |
| Selectors | Simple tag, class, id, `:hover`, `:focus`, and `:focus-visible` rules compile into base/interaction styles | Complex selectors are rejected during compilation instead of being silently ignored |
| Paint | Both paths consume common colors, opacity, asset images, basic image fitting, borders, stacking order, and text alignment | Rounded borders, shadows, transforms, transitions, clipping, and advanced fonts are not in the common subset and are rejected |
| Controls | Both paths support screen actions and the declared range/checkbox settings | Browser uses DOM controls; Native draws SDL controls. Their visual details and accessibility behavior are not identical |
| Save thumbnails | Browser composites the story stage into a 320×180 image before showing the save screen; Native caches the last fully rendered SDL story frame and writes `thumb-slot-N.png` when saving. Both omit the save/load overlay itself | Browser composites the background, sprites, images, dialogue panel/nameplate/text, choices, video, player controls, and simple effects; Native captures the actual renderer output. Browser custom CSS not represented by its stage compositor can differ from the live screen. Missing or damaged thumbnails leave the save itself loadable |
| Save-slot status | Both paths classify cards as empty, ready, corrupt, or incompatible and disable loading for every non-ready snapshot. The slot-card root receives `data-state` and its matching state style | Only `.class[data-state="empty|ready|corrupt|incompatible"]` selectors are supported, and they must match the save-slot template root; state selectors on nested fields or unrelated elements are rejected |

## Known silent-mismatch examples

- `Edit/screen-document.js` retains a broad syntax/security allowlist, then rejects known non-portable declarations and selectors before creating the shared tree.
- Native sibling drawing sorts by `z-index`; `<img object-fit="cover">` now crops the source image rather than stretching it.
- The shared title stylesheet no longer contains three complex selectors that were previously ignored by the common-tree compiler. Save slots pass their four-way state into the shared status field and support root-card styling for `empty`, `ready`, `corrupt`, and `incompatible` in both renderers.
- Editor preview success alone does not prove final visual parity: font rasterization, SDL widget appearance, device DPI, and real-window composition still require visual checks on each supported platform.

## Compatibility policy to enforce

1. Keep the parser allowlist for safety, and maintain the separate renderer capability contract enforced during compilation.
2. Treat the compiled screen tree as the semantic source of truth. Geometry and interaction state must not be reinterpreted differently by each renderer.
3. At save/preview/package time, identify unsupported selectors and declarations with file, selector, property, and target renderer. The current common subset rejects known unsupported properties, but diagnostics do not yet consistently include source file and selector context.
4. Add each newly supported visual feature to both renderers and to a paired Browser/Native regression test before documenting it as common.
5. Keep Browser-only authoring features explicitly target-scoped; do not imply that they are portable to Native builds.

Remaining implementation work: report selector/property source context, build explicit paired rendering tests for all common properties, and expand the common subset only when both renderers implement it. Until then, use only the common subset and inspect the packaged Native player for visual acceptance.
