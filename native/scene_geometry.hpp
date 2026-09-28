#pragma once

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
}
