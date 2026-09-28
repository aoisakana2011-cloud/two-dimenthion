#include "player.hpp"
#include <filesystem>
#include <iostream>
#include <vector>

namespace fs = std::filesystem;

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
    if (argc < 2) { std::cerr << "Usage: novel_player package.nsp.json [--headless] [--debug-start file scene line-or-0 variables-json]\n"; return 2; }
    std::vector<std::string> arguments;
    for (int index = 2; index < argc; ++index) arguments.push_back(fs::path(argv[index]).string());
    return native_player::run(fs::path(argv[1]), arguments);
}
#else
int main(int argc, char** argv) {
    if (argc < 2) { std::cerr << "Usage: novel_player package.nsp.json [--headless] [--debug-start file scene line-or-0 variables-json]\n"; return 2; }
    std::vector<std::string> arguments;
    for (int index = 2; index < argc; ++index) arguments.emplace_back(argv[index]);
    return native_player::run(fs::path(argv[1]), arguments);
}
#endif
