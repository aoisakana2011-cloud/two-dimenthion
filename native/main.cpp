#include "player.hpp"
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;

#ifdef _WIN32
#include <windows.h>
static std::string utf8Argument(const wchar_t* value) {
    if (!value) return {};
    const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
    if (length <= 0) throw std::runtime_error("Could not encode player argument as UTF-8");
    std::string result(static_cast<size_t>(length), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result.data(), length, nullptr, nullptr) <= 0) {
        throw std::runtime_error("Could not encode player argument as UTF-8");
    }
    result.resize(static_cast<size_t>(length - 1));
    return result;
}
int wmain(int argc, wchar_t** argv) {
    if (argc < 2) { std::cerr << "Usage: novel_player package.nsp.json [--headless] [--debug-start file scene line-or-0 variables-json]\n"; return 2; }
    std::vector<std::string> arguments;
    for (int index = 2; index < argc; ++index) arguments.push_back(utf8Argument(argv[index]));
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
