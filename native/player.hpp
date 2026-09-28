#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace native_player {
int run(const std::filesystem::path& packagePath, const std::vector<std::string>& arguments);
}

