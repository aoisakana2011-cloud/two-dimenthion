#pragma once

#include <algorithm>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace native_player {
inline float linearProgress(uint64_t elapsedMs, int64_t durationMs) {
    if (durationMs <= 0) return 1.0f;
    return std::clamp(static_cast<float>(elapsedMs) / static_cast<float>(durationMs), 0.0f, 1.0f);
}

template <typename Sprite>
std::vector<const Sprite*> spritesByVisualOrder(const std::map<std::string, Sprite>& sprites) {
    std::vector<const Sprite*> ordered;
    ordered.reserve(sprites.size());
    for (const auto& [name, sprite] : sprites) ordered.push_back(&sprite);
    std::stable_sort(ordered.begin(), ordered.end(), [](const Sprite* left, const Sprite* right) {
        return left->visualOrder < right->visualOrder;
    });
    return ordered;
}
}
