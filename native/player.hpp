#pragma once

#include <filesystem>
#include <string>

namespace native_player {
int run(const std::filesystem::path& packagePath, const std::string& mode);
}

