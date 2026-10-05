#pragma once

#include <algorithm>

namespace native_player {
struct Rect {
    float x;
    float y;
    float width;
    float height;
};

// Match CSS object-fit: contain, centered in the logical player canvas.
inline Rect videoContainRect(float sourceWidth, float sourceHeight,
                             float canvasWidth, float canvasHeight) {
    const float scale = (canvasWidth / sourceWidth < canvasHeight / sourceHeight)
        ? canvasWidth / sourceWidth
        : canvasHeight / sourceHeight;
    const float width = sourceWidth * scale;
    const float height = sourceHeight * scale;
    return {
        (canvasWidth - width) / 2.0f,
        (canvasHeight - height) / 2.0f,
        width,
        height,
    };
}

// Match CSS background-size: cover, background-position: center, followed by
// translating the full background layer in logical canvas pixels.
inline Rect backgroundCoverRect(float sourceWidth, float sourceHeight,
                                float canvasWidth, float canvasHeight,
                                float offsetX = 0, float offsetY = 0) {
    const float scale = (canvasWidth / sourceWidth > canvasHeight / sourceHeight)
        ? canvasWidth / sourceWidth
        : canvasHeight / sourceHeight;
    const float width = sourceWidth * scale;
    const float height = sourceHeight * scale;
    return {
        (canvasWidth - width) / 2.0f + offsetX,
        (canvasHeight - height) / 2.0f + offsetY,
        width,
        height,
    };
}

// Extend the covered background when camera zoom or panning would otherwise
// expose the canvas edge.  The image remains centered around its original
// cover rect; only the crop grows enough to cover the inverse-transformed view.
inline Rect cameraSafeBackgroundCoverRect(float sourceWidth, float sourceHeight,
                                          float canvasWidth, float canvasHeight,
                                          float offsetX, float offsetY,
                                          float zoom, float focusX, float focusY) {
    const auto base = backgroundCoverRect(sourceWidth, sourceHeight, canvasWidth, canvasHeight);
    const float safeZoom = zoom > 0.0001f ? zoom : 0.0001f;
    const float visibleLeft = focusX - focusX / safeZoom;
    const float visibleRight = focusX + (canvasWidth - focusX) / safeZoom;
    const float visibleTop = focusY - focusY / safeZoom;
    const float visibleBottom = focusY + (canvasHeight - focusY) / safeZoom;
    const float centerX = canvasWidth / 2.0f;
    const float centerY = canvasHeight / 2.0f;
    const float edgeSafety = 1.0f + 2.0f / std::min(base.width, base.height);
    const float scaleX = std::max({edgeSafety,
        2.0f * (centerX + offsetX - visibleLeft) / base.width,
        2.0f * (visibleRight - centerX - offsetX) / base.width});
    const float scaleY = std::max({edgeSafety,
        2.0f * (centerY + offsetY - visibleTop) / base.height,
        2.0f * (visibleBottom - centerY - offsetY) / base.height});
    const float scale = std::max(scaleX, scaleY);
    const float width = base.width * scale;
    const float height = base.height * scale;
    return {
        centerX - width / 2.0f + offsetX,
        centerY - height / 2.0f + offsetY,
        width,
        height,
    };
}
}
