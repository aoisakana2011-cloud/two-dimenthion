#include "player.hpp"
#include <filesystem>
#include <iostream>

namespace fs = std::filesystem;

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
    if (argc < 2) { std::cerr << "Usage: novel_player package.nsp.json [--headless]\n"; return 2; }
    return native_player::run(fs::path(argv[1]), argc > 2 ? fs::path(argv[2]).string() : "");
}
#else
int main(int argc, char** argv) {
    if (argc < 2) { std::cerr << "Usage: novel_player package.nsp.json [--headless]\n"; return 2; }
    return native_player::run(fs::path(argv[1]), argc > 2 ? argv[2] : "");
}
#endif
