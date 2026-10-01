#pragma once

#include <filesystem>
#include <memory>
#include <string>
#include <vector>
#include <utility>
#include <nlohmann/json.hpp>

namespace native_player {

// Hosts trusted, compiler-validated screen documents. All messages still have
// to be matched against the active screen's compiled action/setting contract.
class ScreenWebView {
public:
    ScreenWebView(void* nativeWindow, const std::filesystem::path& packageRoot,
        const std::filesystem::path& userDataRoot);
    ~ScreenWebView();
    ScreenWebView(const ScreenWebView&) = delete;
    ScreenWebView& operator=(const ScreenWebView&) = delete;

    bool ready() const;
    std::string status() const;
    void show(const std::string& screenId, const std::string& markup,
        const std::string& stylesheet, const nlohmann::json& model);
    void hide();
    void resize();
    std::vector<nlohmann::json> takeMessages();
    void clickForTest(const std::string& action, const std::string& target = {});
    void probeImageForTest(const std::string& elementId);
    int imageProbeResult() const;
    void setSettingForTest(const std::string& key, double value);
    std::pair<int,int> boundsForTest() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace native_player
