#include "scene_geometry.hpp"
#include "scene_presentation.hpp"
#include <cmath>
#include <iostream>

static bool close(float actual, float expected) {
    return std::abs(actual - expected) < 0.001f;
}

int main() {
    if (!close(native_player::linearProgress(0, 1000), 0)
        || !close(native_player::linearProgress(500, 1000), 0.5f)
        || !close(native_player::linearProgress(1200, 1000), 1)
        || !close(native_player::linearProgress(0, 0), 1)) {
        std::cerr << "blocking transition progress mismatch\n";
        return 1;
    }

    const auto landscape = native_player::backgroundCoverRect(200, 100, 1280, 720, 10, -20);
    if (!close(landscape.x, -70) || !close(landscape.y, -20)
        || !close(landscape.width, 1440) || !close(landscape.height, 720)) {
        std::cerr << "landscape cover geometry mismatch\n";
        return 1;
    }

    const auto portrait = native_player::backgroundCoverRect(100, 200, 1280, 720);
    if (!close(portrait.x, 0) || !close(portrait.y, -920)
        || !close(portrait.width, 1280) || !close(portrait.height, 2560)) {
        std::cerr << "portrait cover geometry mismatch\n";
        return 1;
    }

    const auto matching = native_player::backgroundCoverRect(1920, 1080, 1280, 720);
    if (!close(matching.x, 0) || !close(matching.y, 0)
        || !close(matching.width, 1280) || !close(matching.height, 720)) {
        std::cerr << "matching-aspect cover geometry mismatch\n";
        return 1;
    }

    const auto videoLandscape = native_player::videoContainRect(640, 480, 1280, 720);
    if (!close(videoLandscape.x, 160) || !close(videoLandscape.y, 0)
        || !close(videoLandscape.width, 960) || !close(videoLandscape.height, 720)) {
        std::cerr << "4:3 video contain geometry mismatch\n";
        return 1;
    }

    const auto videoPortrait = native_player::videoContainRect(480, 640, 1280, 720);
    if (!close(videoPortrait.x, 370) || !close(videoPortrait.y, 0)
        || !close(videoPortrait.width, 540) || !close(videoPortrait.height, 720)) {
        std::cerr << "portrait video contain geometry mismatch\n";
        return 1;
    }

    const auto videoMatch = native_player::videoContainRect(1920, 1080, 1280, 720);
    if (!close(videoMatch.x, 0) || !close(videoMatch.y, 0)
        || !close(videoMatch.width, 1280) || !close(videoMatch.height, 720)) {
        std::cerr << "matching-aspect video contain geometry mismatch\n";
        return 1;
    }

    struct Layer { unsigned long long visualOrder; };
    const std::map<std::string, Layer> insertionOrder{{"ayase", {2}}, {"zara", {1}}};
    const auto rendered = native_player::spritesByVisualOrder(insertionOrder);
    if (rendered.size() != 2 || rendered[0]->visualOrder != 1 || rendered[1]->visualOrder != 2) {
        std::cerr << "sprite insertion order mismatch\n";
        return 1;
    }
    std::cout << "PASS Native presentation geometry/order: background cover, video contain, offsets, aspect match, insertion stacking\n";
}
