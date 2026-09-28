#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>

namespace native_player {
inline float fadeProgressFromRemainingFrames(int64_t totalFrames, int64_t signedRemainingFrames) {
    if (totalFrames <= 0 || signedRemainingFrames == 0) return 1.0f;
    const long double remaining = std::abs(static_cast<long double>(signedRemainingFrames));
    return float(std::clamp(1.0L - remaining / static_cast<long double>(totalFrames), 0.0L, 1.0L));
}

inline float gainFromRemainingFrames(float startGain, float targetGain, int64_t totalFrames, int64_t signedRemainingFrames) {
    const float progress = fadeProgressFromRemainingFrames(totalFrames, signedRemainingFrames);
    return startGain + (targetGain - startGain) * progress;
}
}
