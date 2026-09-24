#include <SDL3/SDL.h>
#include <SDL3_image/SDL_image.h>

#include <filesystem>
#include <iostream>
#include <string>

namespace fs = std::filesystem;

static std::string toUtf8(const fs::path& path) {
    const auto value = path.u8string();
    return {reinterpret_cast<const char*>(value.data()), value.size()};
}

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
#else
int main(int argc, char** argv) {
#endif
    if (argc < 2) {
        std::cerr << "Usage: check_image image-path [image-path ...]\n";
        return 2;
    }
    if (!SDL_Init(SDL_INIT_VIDEO)) {
        std::cerr << "SDL init failed: " << SDL_GetError() << '\n';
        return 1;
    }
    SDL_Window* window = SDL_CreateWindow("Image check", 16, 16, SDL_WINDOW_HIDDEN);
    SDL_Renderer* renderer = window ? SDL_CreateRenderer(window, nullptr) : nullptr;
    if (!renderer) {
        std::cerr << "SDL renderer failed: " << SDL_GetError() << '\n';
        if (window) SDL_DestroyWindow(window);
        SDL_Quit();
        return 1;
    }

    int failures = 0;
    for (int i = 1; i < argc; ++i) {
        const fs::path file(argv[i]);
        const auto utf8Path = toUtf8(file);
        SDL_Texture* texture = IMG_LoadTexture(renderer, utf8Path.c_str());
        if (!texture) {
            ++failures;
            std::cout << "FAIL " << utf8Path << " : " << SDL_GetError() << '\n';
        } else {
            std::cout << "OK " << utf8Path << '\n';
            SDL_DestroyTexture(texture);
        }
    }

    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return failures == 0 ? 0 : 1;
}
