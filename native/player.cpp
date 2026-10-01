#include "player.hpp"
#include "runtime.hpp"
#include "video.hpp"
#include "scene_geometry.hpp"
#include "scene_presentation.hpp"
#include "audio_transition.hpp"
#include "screen_webview.hpp"
#include <SDL3_image/SDL_image.h>
#include <SDL3_ttf/SDL_ttf.h>
#include <SDL3_mixer/SDL_mixer.h>
#include <algorithm>
#include <cmath>
#include <charconv>
#include <cstdlib>
#include <chrono>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <thread>
#include <unordered_map>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif
using novel::json;
namespace fs = std::filesystem;
static std::string utf8Path(const fs::path& path) {
    const auto value = path.u8string();
    return std::string(reinterpret_cast<const char*>(value.data()), value.size());
}
static void replaceSaveFile(const fs::path& temporary, const fs::path& destination) {
    std::error_code error;
    if (!fs::exists(destination,error)) {
        if (error) throw std::runtime_error("Cannot inspect save destination: " + error.message());
        fs::rename(temporary,destination,error);
        if (error) throw std::runtime_error("Cannot create save file: " + error.message());
        return;
    }
#ifdef _WIN32
    if (!ReplaceFileW(destination.c_str(),temporary.c_str(),nullptr,REPLACEFILE_IGNORE_MERGE_ERRORS,nullptr,nullptr))
        throw std::runtime_error("Cannot atomically replace save file: " + std::to_string(GetLastError()));
#else
    fs::rename(temporary,destination,error);
    if (error) throw std::runtime_error("Cannot replace save file: " + error.message());
#endif
}
static fs::path saveDirectoryFor(const fs::path& packagePath, const json& package) {
    if (const auto* overridePath = std::getenv("NOVEL_SAVE_ROOT")) {
        const auto path = fs::u8path(overridePath);
        if (!path.is_absolute()) throw std::runtime_error("NOVEL_SAVE_ROOT must be absolute");
        return path;
    }
    if (SDL_GetCurrentVideoDriver() && std::string(SDL_GetCurrentVideoDriver()) == "dummy")
        return packagePath.parent_path() / "saves";
    auto id = package.value("native_ui",json::object()).value("save_id",std::string{});
    if (id.empty()) {
        uint64_t hash = 14695981039346656037ull;
        for (const auto byte : utf8Path(fs::absolute(packagePath).parent_path())) { hash ^= static_cast<unsigned char>(byte); hash *= 1099511628211ull; }
        std::ostringstream name; name << "project-" << std::hex << hash; id = name.str();
    }
    if (id.size() > 64 || id.empty() || id.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") != std::string::npos) throw std::runtime_error("Invalid save ID");
    char* raw = SDL_GetPrefPath("NovelScript",id.c_str());
    if (!raw) throw std::runtime_error(SDL_GetError());
    const auto path = fs::u8path(raw); SDL_free(raw);
    return path;
}
static void migrateLegacySaves(const fs::path& packagePath, const fs::path& saveDirectory) {
    fs::create_directories(saveDirectory);
    const auto legacy = packagePath.parent_path() / "saves";
    std::error_code error;
    if (fs::equivalent(legacy,saveDirectory,error) && !error) return;
    error.clear();
    if (!fs::is_directory(legacy,error)) return;
    for (int index = 1; index <= 100; ++index) {
        for (const auto& name : {"slot-" + std::to_string(index) + ".json", "thumb-slot-" + std::to_string(index) + ".png"}) {
            const auto source = legacy / name, destination = saveDirectory / name;
            if (fs::is_regular_file(source,error)) {
                error.clear(); fs::copy_file(source,destination,fs::copy_options::skip_existing,error);
                if (error) throw std::runtime_error("Cannot migrate save file: " + error.message());
            }
            error.clear();
        }
    }
    const auto settings = legacy / "ui-settings.json";
    if (fs::is_regular_file(settings,error)) {
        error.clear(); fs::copy_file(settings,saveDirectory / "ui-settings.json",fs::copy_options::skip_existing,error);
        if (error) throw std::runtime_error("Cannot migrate player settings: " + error.message());
    }
}

struct Quit {};
struct Engine {
    SDL_Window* window = nullptr;
    SDL_Renderer* renderer = nullptr;
    TTF_Font* font = nullptr;
    MIX_Mixer* mixer = nullptr;
    MIX_Track* bgm = nullptr;
    struct AudioPlayback {
        MIX_Track* track;
        MIX_Audio* audio;
        bool bgm;
        bool pinned;
        std::string type, asset;
        int64_t fadeDurationFrames;
        float fadeStartGain = 1, fadeTargetGain = 1;
    };
    std::vector<AudioPlayback> audio;
    std::mutex stoppedAudioMutex;
    std::vector<MIX_Track*> stoppedAudioTracks;
    std::map<std::string, SDL_Texture*> textures;
    struct Sprite {
        SDL_Texture* texture;
        std::string position, asset, pose;
        float alpha = 1, offsetX = 0, offsetY = 0;
        uint64_t visualOrder = 0;
    };
    std::map<std::string, Sprite> characters, images;
    uint64_t nextVisualOrder = 0;
    SDL_Texture *background = nullptr, *dialog = nullptr, *speakerSkin = nullptr, *choiceSkin = nullptr, *choiceActiveSkin = nullptr;
    std::string backgroundAsset, bgmAsset, videoAsset;
    float backgroundOffsetX = 0, backgroundOffsetY = 0;
    uint64_t logicalTimeMs = 0;
    bool captureAnimationMidpoints = false;
    json animationMidpoints = json::array();
    std::unique_ptr<Video> video;
    std::map<std::string, std::string> config;
    std::map<std::string, float> audioVolumeOverrides;
    json uiSettingValues = json::object();
    std::map<std::string, bool> audioTagSeen;
    fs::path uiSettingsPath;
    std::string draggedUiSetting;
    json gameScreens = json::object();
    json playerControls = json::object();
    json queuedLoad = nullptr;
    std::string screenMusicAsset;
    fs::path saveDirectory;
    std::unique_ptr<native_player::ScreenWebView> screenWebView;
    struct CachedSlot { fs::file_time_type modified; json value; std::string state; };
    mutable std::unordered_map<int, CachedSlot> slotCache;
    std::string activeScreen;
    std::vector<std::string> screenHistory;
    int screenHover = 0;
    int controlHover = -1;
    bool titleStarted = false;
    bool storyActive = false;
    std::string speaker, text;
    std::vector<std::string> options;
    int selection = -1;
    int hovered = -1;
    float choiceScroll = 0.0f;
    bool next = false;
    bool automated = false;
    int width = 960, height = 680;
    float overlay = 0;
    float dialogueOpacityOverride = -1.0f;
    SDL_Color overlayColor{0,0,0,255};
    fs::path root;
    novel::Runtime& runtime;
    int number(const std::string& key, int fallback) { return config.contains(key) ? std::stoi(config[key]) : fallback; }
    SDL_Color color(const std::string& key, SDL_Color fallback) {
        if (!config.contains(key)) return fallback;
        std::istringstream in(config[key]); int r,g,b,a; char c;
        if (!(in >> r >> c >> g >> c >> b >> c >> a) || std::min({r,g,b,a}) < 0 || std::max({r,g,b,a}) > 255) throw std::runtime_error("Invalid color: " + key);
        return {Uint8(r),Uint8(g),Uint8(b),Uint8(a)};
    }
    SDL_Texture* image(const fs::path& path) {
        auto key = utf8Path(path); if (textures.contains(key)) return textures[key];
        SDL_Texture* t = nullptr;
        if (auto* surface = IMG_Load(key.c_str())) {
            // Keep the source alpha channel explicit so transparent character
            // poses remain transparent on every renderer and image format.
            auto* rgba = SDL_ConvertSurface(surface, SDL_PIXELFORMAT_RGBA32);
            SDL_DestroySurface(surface);
            if (!rgba) throw std::runtime_error("Cannot convert image " + key + ": " + SDL_GetError());
            t = SDL_CreateTextureFromSurface(renderer, rgba);
            SDL_DestroySurface(rgba);
        }
        if (!t) { Video decoded(renderer, key); decoded.update(); t = decoded.releaseTexture(); }
        if (!t) throw std::runtime_error("Cannot load image " + key + ": " + SDL_GetError());
        SDL_SetTextureBlendMode(t, SDL_BLENDMODE_BLEND); textures[key] = t; return t;
    }
    fs::path asset(const std::string& type, const std::string& id, const std::string& pose = "") {
        std::string relative;
        if (type == "char") {
            for (const auto& c : runtime.program.at("characters")) if (c.at("name") == id) for (const auto& p : c.at("poses")) if (p.at("name") == pose) relative = p.at("path");
        } else for (const auto& a : runtime.program.at("assets")) if (a.at("type") == type && a.at("name") == id) relative = a.at("path");
        std::replace(relative.begin(), relative.end(), '\\', '/');
        if (relative.starts_with("asset/")) relative.erase(0, 6);
        if (relative.empty()) throw std::runtime_error("Unknown asset: " + id);
        auto base = fs::weakly_canonical(root / "asset"), resolved = fs::canonical(base / fs::u8path(relative));
        auto rel = resolved.lexically_relative(base);
        if (rel.empty() || rel.is_absolute() || *rel.begin() == "..") throw std::runtime_error("Asset outside package");
        return resolved;
    }
    SDL_Texture* skinImage(const std::string& relative) {
        if (relative.empty() || fs::path(relative).is_absolute() || relative.find("..") != std::string::npos) return nullptr;
        return image(root / "asset" / fs::u8path(relative));
    }
    json readUiTheme(const json& nativeUi) {
        if (!nativeUi.contains("native_ui_theme")) return json::object();
        const auto themeFile = nativeUi.at("native_ui_theme").get<std::string>();
        if (themeFile.empty() || fs::path(themeFile).is_absolute() || themeFile.find("..") != std::string::npos) throw std::runtime_error("Invalid native UI theme");
        std::ifstream file(root / "asset" / fs::u8path(themeFile));
        if (!file) throw std::runtime_error("Cannot open native UI theme: " + themeFile);
        json theme; file >> theme;
        if (theme.value("version", 0) != 1) throw std::runtime_error("Unsupported native UI theme version");
        return theme;
    }
    json readGameScreens(const json& nativeUi) {
        if (!nativeUi.contains("game_screens")) return json::object();
        const auto relative = nativeUi.at("game_screens").get<std::string>();
        if (relative.empty() || fs::path(relative).is_absolute() || relative.find("..") != std::string::npos) throw std::runtime_error("Invalid game screen configuration path");
        std::ifstream file(root / "asset" / fs::u8path(relative));
        if (!file) throw std::runtime_error("Cannot open game screen configuration: " + relative);
        json value; file >> value;
        if (value.value("version", 0) != 1 || !value.contains("canvas") || !value.contains("screens") || !value.contains("initial") || !value["screens"].contains(value["initial"].get<std::string>())) throw std::runtime_error("Invalid game screen configuration");
        return value;
    }
    void applyUiTheme(const json& nativeUi, const json& theme, bool loadImages) {
        if (theme.empty()) return;
        const auto themeFile = nativeUi.at("native_ui_theme").get<std::string>();
        const auto themeDirectory = fs::path(themeFile).parent_path();
        const auto imagePath = [&](const std::string& name) {
            const auto relative = fs::u8path(name).lexically_normal().generic_string();
            const auto directory = themeDirectory.lexically_normal().generic_string();
            if (!directory.empty() && directory != "." && (relative == directory || relative.starts_with(directory + "/"))) return relative;
            return (themeDirectory / fs::u8path(name)).lexically_normal().generic_string();
        };
        if (theme.contains("screen") && theme.contains("dialog") && theme.contains("choices")) {
            const auto& d = theme.at("dialog"), &m = d.at("message"), &n = d.at("nameplate"), &c = theme.at("choices");
            const auto& screen = theme.at("screen");
            config["window.width"] = std::to_string(screen.at("width").get<int>()); config["window.height"] = std::to_string(screen.at("height").get<int>());
            if (screen.contains("backdrop") && screen.at("backdrop").contains("bottomFog")) {
                const auto& fog = screen.at("backdrop").at("bottomFog");
                config["ui.bottom_fog"] = fog.value("enabled", true) ? "1" : "0";
                if (fog.contains("color")) {
                    const auto color = fog.at("color");
                    if (!color.is_array() || color.size() != 4) throw std::runtime_error("Invalid native UI fog color");
                    config["ui.fog_color"] = std::to_string(color[0].get<int>()) + "," + std::to_string(color[1].get<int>()) + "," + std::to_string(color[2].get<int>()) + "," + std::to_string(color[3].get<int>());
                }
                if (fog.contains("height")) config["ui.fog_height"] = std::to_string(fog.at("height").get<int>());
            }
            config["dialog.x"] = std::to_string(d.at("x").get<int>()); config["dialog.y"] = std::to_string(d.at("y").get<int>()); config["dialog.width"] = std::to_string(d.at("width").get<int>()); config["dialog.height"] = std::to_string(d.at("height").get<int>());
            config["dialog.text_x"] = std::to_string(m.at("x").get<int>()); config["dialog.text_y"] = std::to_string(m.at("y").get<int>()); config["dialog.text_width"] = std::to_string(m.at("width").get<int>()); config["dialog.text_height"] = std::to_string(m.at("height").get<int>()); config["dialog.text_size"] = std::to_string(m.at("size").get<int>());
            config["dialog.speaker_x"] = std::to_string(n.at("x").get<int>()); config["dialog.speaker_y"] = std::to_string(n.at("y").get<int>()); config["dialog.speaker_width"] = std::to_string(n.at("width").get<int>()); config["dialog.speaker_height"] = std::to_string(n.at("height").get<int>()); config["dialog.speaker_size"] = std::to_string(n.at("text").at("size").get<int>());
            const auto colorText = [](const json& value) { return std::to_string(value[0].get<int>()) + "," + std::to_string(value[1].get<int>()) + "," + std::to_string(value[2].get<int>()) + "," + std::to_string(value[3].get<int>()); };
            config["dialog.text_color"] = colorText(m.at("color")); config["dialog.speaker_color"] = colorText(n.at("text").at("color"));
            config["dialog.speaker_text_x"] = std::to_string(n.at("text").value("x", 0)); config["dialog.speaker_text_y"] = std::to_string(n.at("text").value("y", 0));
            config["dialog.speaker_text_width"] = std::to_string(n.at("text").value("width", n.at("width").get<int>())); config["dialog.speaker_text_height"] = std::to_string(n.at("text").value("height", n.at("height").get<int>()));
            config["choice.x"] = std::to_string(c.at("x").get<int>()); config["choice.y"] = std::to_string(c.at("y").get<int>());
            config["choice.width"] = std::to_string(c.at("width").get<int>()); config["choice.view_height"] = std::to_string(c.at("height").get<int>());
            config["choice.height"] = std::to_string(c.at("itemHeight").get<int>()); config["choice.gap"] = std::to_string(c.at("gap").get<int>());
            config["choice.text_x"] = std::to_string(c.at("text").value("x", 24)); config["choice.text_y"] = std::to_string(c.at("text").value("y", 12));
            config["choice.text_width"] = std::to_string(c.at("text").value("width", c.at("width").get<int>() - 42)); config["choice.text_height"] = std::to_string(c.at("text").value("height", c.at("itemHeight").get<int>()));
            config["choice.text_size"] = std::to_string(c.at("text").at("size").get<int>()); config["choice.text_color"] = colorText(c.at("text").at("color"));
            if (loadImages) {
                const auto themedImage = [&](const json& object, const char* key) -> SDL_Texture* {
                    const auto imageName = object.value(key, std::string{});
                    if (imageName.empty()) return nullptr;
                    return skinImage(imagePath(imageName));
                };
                dialog = themedImage(d, "image");
                speakerSkin = themedImage(n, "image");
                choiceSkin = themedImage(c, "image");
                choiceActiveSkin = themedImage(c, "activeImage");
            }
            return;
        }
        const auto setNumber = [&](const json& object, const char* key, const char* target) {
            if (object.contains(key) && object.at(key).is_number_integer()) config[target] = std::to_string(object.at(key).get<int>());
        };
        const auto setColor = [&](const json& object, const char* key, const char* target) {
            if (!object.contains(key) || !object.at(key).is_array() || object.at(key).size() != 4) return;
            const auto& c = object.at(key); for (const auto& value : c) if (!value.is_number_integer() || value.get<int>() < 0 || value.get<int>() > 255) throw std::runtime_error("Invalid native UI color");
            config[target] = std::to_string(c[0].get<int>()) + "," + std::to_string(c[1].get<int>()) + "," + std::to_string(c[2].get<int>()) + "," + std::to_string(c[3].get<int>());
        };
        if (theme.contains("backdrop") && theme["backdrop"].is_object()) {
            const auto& backdrop = theme["backdrop"];
            config["ui.bottom_fog"] = backdrop.value("bottom_fog", true) ? "1" : "0";
            setColor(backdrop, "fog_color", "ui.fog_color"); setNumber(backdrop, "fog_height", "ui.fog_height"); setNumber(backdrop, "fog_opacity", "ui.fog_opacity");
        }
        if (theme.contains("dialog") && theme["dialog"].is_object()) {
            const auto& dialogTheme = theme["dialog"];
            if (dialogTheme.contains("opacity")) {
                const auto opacity = dialogTheme.at("opacity").get<double>();
                if (!std::isfinite(opacity) || opacity < 0 || opacity > 1) throw std::runtime_error("Invalid dialog opacity");
                config["dialog.opacity"] = std::to_string(opacity);
            }
            setNumber(dialogTheme, "x", "dialog.x"); setNumber(dialogTheme, "y", "dialog.y"); setNumber(dialogTheme, "width", "dialog.width"); setNumber(dialogTheme, "height", "dialog.height"); setNumber(dialogTheme, "bottom", "dialog.bottom");
            setColor(dialogTheme, "text_color", "dialog.text_color");
            if (loadImages && dialogTheme.contains("image") && dialogTheme.at("image").is_string()) dialog = skinImage(imagePath(dialogTheme.at("image").get<std::string>()));
            if (dialogTheme.contains("speaker") && dialogTheme.at("speaker").is_object()) { const auto& speakerTheme = dialogTheme["speaker"]; setNumber(speakerTheme, "x", "dialog.speaker_x"); setNumber(speakerTheme, "y", "dialog.speaker_y"); setNumber(speakerTheme, "size", "dialog.speaker_size"); }
            if (dialogTheme.contains("text") && dialogTheme.at("text").is_object()) { const auto& textTheme = dialogTheme["text"]; setNumber(textTheme, "x", "dialog.text_x"); setNumber(textTheme, "y", "dialog.text_y"); setNumber(textTheme, "size", "dialog.text_size"); setColor(textTheme, "color", "dialog.text_color"); }
        }
        if (theme.contains("audio") && theme["audio"].is_object()) for (const auto* kind : {"bgm", "se", "voice"}) {
            if (!theme["audio"].contains(kind)) continue;
            const auto volume = theme["audio"][kind].get<double>();
            if (!std::isfinite(volume) || volume < 0 || volume > 1) throw std::runtime_error("Invalid audio volume");
            config[std::string("audio.") + kind + "_volume"] = std::to_string(volume);
        }
        if (theme.contains("choice") && theme["choice"].is_object()) {
            const auto& choiceTheme = theme["choice"];
            setNumber(choiceTheme, "width", "choice.width"); setNumber(choiceTheme, "height", "choice.height"); setNumber(choiceTheme, "gap", "choice.gap"); setNumber(choiceTheme, "bottom_gap", "choice.bottom_gap"); setNumber(choiceTheme, "top_min", "choice.top_min");
            if (loadImages && choiceTheme.contains("image") && choiceTheme.at("image").is_string()) choiceSkin = skinImage(imagePath(choiceTheme.at("image").get<std::string>()));
            if (loadImages && choiceTheme.contains("active_image") && choiceTheme.at("active_image").is_string()) choiceActiveSkin = skinImage(imagePath(choiceTheme.at("active_image").get<std::string>()));
            if (choiceTheme.contains("text") && choiceTheme.at("text").is_object()) { const auto& textTheme = choiceTheme["text"]; setNumber(textTheme, "x", "choice.text_x"); setNumber(textTheme, "y", "choice.text_y"); setNumber(textTheme, "size", "choice.text_size"); setColor(textTheme, "color", "choice.text_color"); }
        }
    }
    Engine(novel::Runtime& rt, const fs::path& package, const json& packageData) : root(package.parent_path()), runtime(rt) {
        if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO) || !TTF_Init() || !MIX_Init()) throw std::runtime_error(SDL_GetError());
        fs::path data = fs::u8path(SDL_GetBasePath()) / "engine_data";
        std::ifstream file(data / "engine.txt"); std::string line;
        while (std::getline(file, line)) {
            auto equals = line.find('='); if (equals == std::string::npos || line.starts_with('#')) continue;
            auto trim = [](std::string s) { auto a = s.find_first_not_of(" \t\r"); auto b = s.find_last_not_of(" \t\r"); return a == std::string::npos ? std::string() : s.substr(a,b-a+1); };
            config[trim(line.substr(0,equals))] = trim(line.substr(equals+1));
        }
        const auto nativeUi = packageData.value("native_ui", json::object());
        gameScreens = readGameScreens(nativeUi);
        const auto theme = readUiTheme(nativeUi);
        playerControls = theme.value("controls", json::object());
        if (playerControls.empty()) playerControls = {{"enabled", true}, {"anchor", "dialogue-top-left"}, {"buttons", json::array({
            {{"id", "save"}, {"action", "save"}, {"label", "Save"}, {"x", 0}, {"y", -44}, {"width", 84}, {"height", 36}},
            {{"id", "load"}, {"action", "load"}, {"label", "Load"}, {"x", 92}, {"y", -44}, {"width", 84}, {"height", 36}},
        })}};
        applyUiTheme(nativeUi, theme, false);
        width = number("window.width",960); height = number("window.height",680);
        window = SDL_CreateWindow(config.contains("window.title") ? config["window.title"].c_str() : "Novel Script",width,height,0);
        renderer = SDL_CreateRenderer(window,nullptr);
        if (!window || !renderer) throw std::runtime_error(SDL_GetError());
        SDL_SetRenderDrawBlendMode(renderer, SDL_BLENDMODE_BLEND);
        fs::path fontPath = fs::u8path(config.contains("font.path") ? config["font.path"] : "C:/Windows/Fonts/meiryo.ttc");
        if (fontPath.is_relative()) fontPath = data / fontPath;
        font = TTF_OpenFont(utf8Path(fontPath).c_str(), number("font.size",24));
        if (!font) throw std::runtime_error(SDL_GetError());
        applyUiTheme(nativeUi, theme, true);
        if (gameScreens.contains("screens")) for (const auto& [id, screen] : gameScreens.at("screens").items()) {
            const auto backgroundName = screen.value("background", std::string{});
            if (!backgroundName.empty()) skinImage(backgroundName);
            for (const auto& item : screen.at("items")) {
                const auto imageName = item.value("image", std::string{});
                if (!imageName.empty()) skinImage(imageName);
            }
        }
        mixer = MIX_CreateMixerDevice(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK,nullptr);
        if (!mixer) throw std::runtime_error(SDL_GetError());
        saveDirectory = saveDirectoryFor(package,packageData);
        migrateLegacySaves(package,saveDirectory);
        uiSettingsPath = saveDirectory / "ui-settings.json";
        #ifdef _WIN32
        if (std::string(SDL_GetCurrentVideoDriver() ? SDL_GetCurrentVideoDriver() : "") != "dummy") {
            const auto handle = SDL_GetPointerProperty(SDL_GetWindowProperties(window),SDL_PROP_WINDOW_WIN32_HWND_POINTER,nullptr);
            if (handle) screenWebView = std::make_unique<native_player::ScreenWebView>(handle,root,saveDirectory);
        }
        #endif
        uiSettingValues = json::object();
        const std::map<std::string, json> allowedUiSettings = {
            {"audio.master", 1.0}, {"audio.bgm", 1.0}, {"audio.se", 1.0}, {"audio.voice", 0.5},
            {"audio.bgmMuted", false}, {"audio.seMuted", false}, {"audio.voiceMuted", false}, {"ui.dialogOpacity", 1.0},
        };
        const auto declaredUiSettings = gameScreens.value("controlDefaults", json::object());
        for (const auto& [key, safeDefault] : allowedUiSettings) {
            const auto candidate = declaredUiSettings.find(key);
            if (candidate != declaredUiSettings.end() && ((safeDefault.is_boolean() && candidate->is_boolean()) || (safeDefault.is_number() && candidate->is_number() && std::isfinite(candidate->get<double>()) && candidate->get<double>() >= 0 && candidate->get<double>() <= 1))) uiSettingValues[key] = *candidate;
            else uiSettingValues[key] = safeDefault;
        }
        try {
            std::ifstream preferences(uiSettingsPath);
            if (preferences) {
                json saved; preferences >> saved;
                if (saved.is_object()) for (const auto& [key, fallback] : uiSettingValues.items()) {
                    if (!saved.contains(key)) continue;
                    const auto& candidate = saved.at(key);
                    if (fallback.is_boolean() && candidate.is_boolean()) uiSettingValues[key] = candidate;
                    else if (fallback.is_number() && candidate.is_number()) {
                        const double value = candidate.get<double>();
                        if (std::isfinite(value) && value >= 0 && value <= 1) uiSettingValues[key] = value;
                    }
                }
            }
        } catch (...) { /* Invalid preference files fall back to safe defaults. */ }
        applyUiAudioSettings();
    }
    ~Engine() {
        screenWebView.reset();
        video.reset();
        for (const auto& playback : audio) {
            MIX_SetTrackStoppedCallback(playback.track, nullptr, nullptr);
            MIX_StopTrack(playback.track, 0);
            MIX_DestroyTrack(playback.track);
            MIX_DestroyAudio(playback.audio);
        }
        audio.clear();
        if (mixer) MIX_DestroyMixer(mixer);
        for (auto [key,t] : textures) SDL_DestroyTexture(t);
        if (font) TTF_CloseFont(font);
        if (renderer) SDL_DestroyRenderer(renderer);
        if (window) SDL_DestroyWindow(window);
        MIX_Quit(); TTF_Quit(); SDL_Quit();
    }
    void label(const std::string& s, float x, float y, int size, SDL_Color col, float maxWidth = 0, float maxHeight = 0) {
        if (s.empty()) return;
        TTF_SetFontSize(font,size);
        auto* surface = TTF_RenderText_Blended_Wrapped(font,s.c_str(),s.size(),col,Uint32(std::max(1.0f,maxWidth > 0 ? maxWidth : float(width)-x-30)));
        if (!surface) throw std::runtime_error(SDL_GetError());
        auto* texture = SDL_CreateTextureFromSurface(renderer,surface);
        SDL_FRect rect{x,y,float(surface->w),float(surface->h)};
        SDL_Rect clip{int(std::floor(x)), int(std::floor(y)), int(std::ceil(maxWidth > 0 ? maxWidth : float(surface->w))), int(std::ceil(maxHeight))};
        if (maxHeight > 0) SDL_SetRenderClipRect(renderer, &clip);
        SDL_RenderTexture(renderer,texture,nullptr,&rect); SDL_DestroyTexture(texture); SDL_DestroySurface(surface);
        if (maxHeight > 0) SDL_SetRenderClipRect(renderer, nullptr);
    }
    void speakerLabel(const std::string& name, float x, float y, int size, SDL_Color col) {
        TTF_SetFontSize(font, size);
        int labelWidth = 0, labelHeight = 0;
        if (!name.empty() && !TTF_GetStringSize(font, name.c_str(), name.size(), &labelWidth, &labelHeight)) throw std::runtime_error(SDL_GetError());
        const float horizontalPadding = 22.0f, verticalPadding = 7.0f;
        SDL_FRect frame{
            x,
            y,
            float(number("dialog.speaker_width", labelWidth + int(horizontalPadding * 2.0f))),
            float(number("dialog.speaker_height", labelHeight + int(verticalPadding * 2.0f))),
        };
        const auto alpha = dialogueOpacityOverride >= 0 ? dialogueOpacityOverride : float(number("dialog.opacity", 1));
        if (speakerSkin) { SDL_SetTextureAlphaModFloat(speakerSkin, alpha); SDL_RenderTexture(renderer, speakerSkin, nullptr, &frame); SDL_SetTextureAlphaModFloat(speakerSkin, 1); }
        else { auto fill=color("dialog.background_color", {13,20,33,232}), border=color("dialog.border_color", {112,159,201,180}), accent=color("dialog.accent_color", {100,190,255,255}); fill.a=Uint8(fill.a*alpha); border.a=Uint8(border.a*alpha); accent.a=Uint8(accent.a*alpha); outlinedPanel(frame,fill,border,accent); }
        if (!name.empty()) {
            const float textX = frame.x + float(number("dialog.speaker_text_x", 0));
            const float textY = frame.y + float(number("dialog.speaker_text_y", 0));
            const float textWidth = float(number("dialog.speaker_text_width", int(frame.w)));
            const float textHeight = float(number("dialog.speaker_text_height", int(frame.h)));
            label(name, textX + (textWidth - labelWidth) / 2.0f, textY + (textHeight - labelHeight) / 2.0f, size, col, textWidth, textHeight);
        }
    }
    void dialogueLabel(const std::string& value, float x, float y, int size, SDL_Color col, float maxWidth, float maxHeight) {
        label(value, x, y, size, col, maxWidth, maxHeight);
    }
    void outlinedPanel(const SDL_FRect& rect, SDL_Color fill, SDL_Color border, SDL_Color accent) {
        SDL_SetRenderDrawColor(renderer, 0, 0, 0, Uint8(fill.a / 2));
        SDL_FRect shadow{rect.x + 6, rect.y + 8, rect.w, rect.h}; SDL_RenderFillRect(renderer, &shadow);
        SDL_SetRenderDrawColor(renderer, fill.r, fill.g, fill.b, fill.a); SDL_RenderFillRect(renderer, &rect);
        SDL_SetRenderDrawColor(renderer, border.r, border.g, border.b, border.a);
        SDL_FRect top{rect.x, rect.y, rect.w, 1}, bottom{rect.x, rect.y + rect.h - 1, rect.w, 1}, left{rect.x, rect.y, 1, rect.h}, right{rect.x + rect.w - 1, rect.y, 1, rect.h};
        SDL_RenderFillRect(renderer, &top); SDL_RenderFillRect(renderer, &bottom); SDL_RenderFillRect(renderer, &left); SDL_RenderFillRect(renderer, &right);
        SDL_SetRenderDrawColor(renderer, accent.r, accent.g, accent.b, accent.a);
        SDL_FRect bar{rect.x, rect.y, 4, rect.h}; SDL_RenderFillRect(renderer, &bar);
    }
    SDL_FRect fitTexture(SDL_Texture* texture, const SDL_FRect& destination) {
        float sourceWidth = 0, sourceHeight = 0; SDL_GetTextureSize(texture, &sourceWidth, &sourceHeight);
        const float scale = std::min(destination.w / sourceWidth, destination.h / sourceHeight);
        SDL_FRect target{destination.x + (destination.w - sourceWidth * scale) / 2.0f, destination.y + (destination.h - sourceHeight * scale) / 2.0f, sourceWidth * scale, sourceHeight * scale};
        SDL_RenderTexture(renderer, texture, nullptr, &target);
        return target;
    }
    void bottomFog() {
        const float fogHeight = std::min(float(number("ui.fog_height", 330)), float(height) * 0.60f);
        const float start = float(height) - fogHeight;
        const auto fog = color("ui.fog_color", {255, 250, 253, 255});
        const auto opacity = number("ui.fog_opacity", 210);
        const int rows = std::max(1, int(std::ceil(fogHeight)));
        for (int index = 0; index < rows; ++index) {
            const float t = float(index + 1) / rows;
            SDL_SetRenderDrawColor(renderer, fog.r, fog.g, fog.b, Uint8(std::min(255, int(opacity * fog.a / 255.0f * t * t))));
            SDL_FRect band{0, start + float(index), float(width), 1.1f};
            SDL_RenderFillRect(renderer, &band);
        }
    }
    SDL_FRect choiceRect(size_t index) {
        const float cardWidth = float(number("choice.width", 620));
        const float gap = float(number("choice.gap", 10));
        const float cardHeight = float(number("choice.height", 48));
        const float top = config.contains("choice.y") ? float(number("choice.y", 0)) : std::max(float(number("choice.top_min", 58)), float(height) - float(number("dialog.height", 184)) - float(number("choice.bottom_gap", 42)) - float(options.size()) * (cardHeight + gap));
        const float left = config.contains("choice.x") ? float(number("choice.x", 0)) : (float(width) - cardWidth) / 2.0f;
        return { left, top + float(index) * (cardHeight + gap) - choiceScroll, cardWidth, cardHeight };
    }
    SDL_FRect choiceViewport() {
        return { float(number("choice.x", (width - number("choice.width", 620)) / 2)), float(number("choice.y", 0)),
            float(number("choice.width", 620)), float(number("choice.view_height", height)) };
    }
    void clampChoiceScroll() {
        const float itemHeight = float(number("choice.height", 48));
        const float contentHeight = options.empty() ? 0.0f : float(options.size()) * itemHeight + float(options.size() - 1) * float(number("choice.gap", 10));
        choiceScroll = std::clamp(choiceScroll, 0.0f, std::max(0.0f, contentHeight - choiceViewport().h));
    }
    void sprite(const Sprite& s) {
        float w,h; SDL_GetTextureSize(s.texture,&w,&h);
        float scale = std::min(float(height)/h, float(width)/w); w *= scale; h *= scale;
        const auto slot = s.position.c_str();
        const float center = slot == std::string("far_left") ? 0.08f : slot == std::string("left") ? 0.26f : slot == std::string("right") ? 0.74f : slot == std::string("far_right") ? 0.92f : 0.50f;
        const float scaleX = float(width) / float(number("screen.width", 1280));
        const float scaleY = float(height) / float(number("screen.height", 720));
        float x = width * center - w / 2.0f + s.offsetX * scaleX;
        SDL_FRect rect{x,height-h + s.offsetY * scaleY,w,h}; SDL_SetTextureAlphaModFloat(s.texture,s.alpha);
        SDL_RenderTexture(renderer,s.texture,nullptr,&rect); SDL_SetTextureAlphaModFloat(s.texture,1);
    }
    void renderBackground() {
        if (!background) return;
        const float scaleX = float(width) / float(number("screen.width", 1280));
        const float scaleY = float(height) / float(number("screen.height", 720));
        float sourceWidth = 0, sourceHeight = 0;
        SDL_GetTextureSize(background, &sourceWidth, &sourceHeight);
        const auto cover = native_player::backgroundCoverRect(
            sourceWidth, sourceHeight, float(width), float(height),
            backgroundOffsetX * scaleX, backgroundOffsetY * scaleY);
        SDL_FRect rect{cover.x, cover.y, cover.width, cover.height};
        SDL_RenderTexture(renderer, background, nullptr, &rect);
    }
    float uiSettingGain(const std::string& channel) const {
        const auto volumeKey = "audio." + channel;
        const auto muteKey = volumeKey + "Muted";
        if (uiSettingValues.value(muteKey, false)) return 0.0f;
        return uiSettingValues.value(volumeKey, channel == "voice" ? 0.5f : 1.0f);
    }
    void applyUiAudioSettings() {
        if (!mixer) return;
        const float master = uiSettingValues.value("audio.master", 1.0f);
        if (!MIX_SetMixerGain(mixer, master)) throw std::runtime_error(SDL_GetError());
        for (const auto& channel : {std::string("bgm"), std::string("se"), std::string("voice")}) {
            if (!audioTagSeen[channel]) continue;
            const auto tag = "ui_" + channel;
            if (!MIX_SetTagGain(mixer, tag.c_str(), uiSettingGain(channel))) throw std::runtime_error(SDL_GetError());
        }
    }
    void saveUiSettings() {
        const auto temporary = fs::path(uiSettingsPath.string() + ".tmp");
        { std::ofstream file(temporary, std::ios::binary | std::ios::trunc); if (!file) throw std::runtime_error("Cannot write player settings"); file << uiSettingValues.dump(2); file.flush(); if (!file) throw std::runtime_error("Cannot write player settings"); }
        replaceSaveFile(temporary,uiSettingsPath);
    }
    bool updateUiSetting(const std::string& key, const json& value) {
        if (!uiSettingValues.contains(key)) return false;
        const auto& fallback = uiSettingValues.at(key);
        if (fallback.is_boolean()) { if (!value.is_boolean()) return false; }
        else if (!fallback.is_number() || !value.is_number() || !std::isfinite(value.get<double>()) || value.get<double>() < 0 || value.get<double>() > 1) return false;
        uiSettingValues[key] = value;
        applyUiAudioSettings();
        saveUiSettings();
        return true;
    }
    const json& currentScreen() const { return gameScreens.at("screens").at(activeScreen); }
    fs::path slotPath(int index) const { return saveDirectory / ("slot-" + std::to_string(index + 1) + ".json"); }
    const json& readSlot(int index) const {
        static const json empty = nullptr;
        std::error_code error;
        const auto modified = fs::last_write_time(slotPath(index), error);
        if (error) { slotCache.erase(index); return empty; }
        const auto cached = slotCache.find(index);
        if (cached != slotCache.end() && cached->second.modified == modified) return cached->second.value;
        json value = nullptr;
        std::string state = "corrupt";
        try {
            std::ifstream file(slotPath(index)); file >> value;
            if (value.is_object() && (value.value("version",0) != 1
                || (value.contains("saveId") && value.at("saveId") != gameScreens.value("saveId",std::string{})))) state = "incompatible";
            if (!value.is_object() || value.value("version", 0) != 1
                || (value.contains("saveId") && value.at("saveId") != gameScreens.value("saveId",std::string{}))
                || !value.contains("file") || !value.at("file").is_string() || value.at("file").get<std::string>().empty()
                || !value.contains("scene") || !value.at("scene").is_string() || value.at("scene").get<std::string>().empty()
                || !value.contains("line") || !value.at("line").is_number_integer() || value.at("line").get<int64_t>() < 1
                || !value.contains("variables") || !value.at("variables").is_object()) value = nullptr;
            else state = "ready";
        }
        catch (...) { value = nullptr; }
        return slotCache.insert_or_assign(index,CachedSlot{modified,std::move(value),std::move(state)}).first->second.value;
    }
    std::string slotState(int index) const {
        readSlot(index);
        const auto found = slotCache.find(index);
        return found == slotCache.end() ? "empty" : found->second.state;
    }
    static std::string slotText(const json& saved, const char* key, const std::string& fallback = {}) {
        return saved.is_object() && saved.contains(key) && saved.at(key).is_string() ? saved.at(key).get<std::string>() : fallback;
    }
    static int64_t slotTimestamp(const json& saved) {
        return saved.is_object() && saved.contains("savedAt") && saved.at("savedAt").is_number_integer() ? saved.at("savedAt").get<int64_t>() : 0;
    }
    std::optional<int> latestSaveSlotIndex() const {
        int count = 8;
        for (const auto& [id, screen] : gameScreens.at("screens").items()) if (screen.value("role",std::string{}) == "load-slots") {
            count = screen.value("slotLayout",json::object()).value("count",8); break;
        }
        std::optional<int> latest;
        int64_t latestTime = -1;
        for (int index = 0; index < count; ++index) {
            const auto& saved = readSlot(index);
            if (!saved.is_object()) continue;
            const auto timestamp = slotTimestamp(saved);
            if (timestamp > latestTime) { latest = index; latestTime = timestamp; }
        }
        return latest;
    }
    json visibleScreenItems() const {
        json items = currentScreen().value("items", json::array());
        for (auto& item : items) if (item.value("action",std::string{}) == "continue" && !latestSaveSlotIndex()) item["disabled"] = true;
        if (currentScreen().contains("uiTree")) {
            for (auto& item : items) if (item.contains("slotIndex")) {
                const int index = item.at("slotIndex").get<int>(); const auto& saved = readSlot(index);
                item["slotSummary"] = saved.is_object() ? json{{"scene",slotText(saved,"scene")},{"speaker",slotText(saved,"speaker")},{"text",slotText(saved,"text")},{"savedAt",slotTimestamp(saved)}} : json(nullptr);
                item["label"] = saved.is_object()
                    ? "Slot " + std::to_string(index + 1) + "  |  " + slotText(saved,"speaker","語り手") + ": " + slotText(saved,"text")
                    : "Slot " + std::to_string(index + 1) + "  |  Empty";
                if (item.value("action",std::string{}) == "load" && !saved.is_object()) item["disabled"] = true;
            }
            return items;
        }
        const auto role = currentScreen().value("role", std::string{});
        if (role != "save-slots" && role != "load-slots") return items;
        const auto layout = currentScreen().value("slotLayout", json{{"x",420},{"y",190},{"width",440},{"height",420},{"rowHeight",42},{"gap",8},{"count",8}});
        const auto style = currentScreen().value("slotStyle", json::object());
        for (int index = 0; index < layout.value("count", 8); ++index) {
            const auto& saved = readSlot(index);
            std::string label = "Slot " + std::to_string(index + 1);
            if (saved.is_object()) label += "  |  " + slotText(saved,"speaker","Narrator") + ": " + slotText(saved,"text");
            else label += "  |  Empty";
            const int row = index;
            items.push_back({{"id", "__slot_" + std::to_string(index)}, {"slotIndex", index}, {"type", "button"},
                {"label", label}, {"action", role == "save-slots" ? "save" : "load"},
                {"image", style.value("image", std::string{})}, {"hoverImage", style.value("hoverImage", std::string{})},
                {"fontSize", style.value("fontSize", 15)},
                {"x", layout.value("x", 420)},
                {"y", layout.value("y", 190) + row * (layout.value("rowHeight", 42) + layout.value("gap", 8))},
                {"width", layout.value("width", 440)}, {"height", layout.value("rowHeight", 42)}});
        }
        return items;
    }
    std::string screenForRole(const std::string& role) const {
        for (const auto& [id, screen] : gameScreens.at("screens").items()) if (screen.value("role", std::string{}) == role) return id;
        return {};
    }
    json webScreenModel() const {
        const auto loadId = screenForRole("load-slots");
        const int count = loadId.empty() ? 8 : gameScreens.at("screens").at(loadId).value("slotLayout",json::object()).value("count",8);
        json slots = json::array();
        for (int index = 0; index < count; ++index) {
            const auto& saved = readSlot(index);
            if (!saved.is_object()) {
                const auto state = slotState(index);
                slots.push_back(state == "empty" ? json(nullptr) : json{{"status",state},{"loadable",false}});
                continue;
            }
            std::string savedAtText;
            const auto timestamp = slotTimestamp(saved);
            if (timestamp > 0) {
                const auto time = std::time_t(timestamp / 1000);
                if (const auto* local = std::localtime(&time)) {
                    char buffer[32]{};
                    if (std::strftime(buffer,sizeof(buffer),"%Y/%m/%d %H:%M",local)) savedAtText = buffer;
                }
            }
            const auto thumbnail = saveDirectory / ("thumb-slot-" + std::to_string(index + 1) + ".png");
            slots.push_back({{"status","ready"},{"loadable",true},{"scene",slotText(saved,"scene")},{"speaker",slotText(saved,"speaker")},
                {"text",slotText(saved,"text")},{"savedAtText",savedAtText},
                {"thumbnail",fs::is_regular_file(thumbnail) ? "https://novel-save.invalid/thumb-slot-" + std::to_string(index + 1) + ".png?v=" + std::to_string(timestamp) : ""}});
        }
        return {{"canvasWidth",gameScreens.at("canvas").at("width")},{"canvasHeight",gameScreens.at("canvas").at("height")},
            {"slots",slots},{"settings",uiSettingValues},{"continueAvailable",latestSaveSlotIndex().has_value()},
            {"canSave",!runtime.currentSceneName.empty() && !runtime.currentSourceFile.empty() && runtime.currentLine > 0}};
    }
    void handleWebScreenMessage(const json& message) {
        if (activeScreen.empty() || !message.is_object()) return;
        const auto kind = message.value("kind",std::string{});
        if (kind == "back") {
            if (!screenHistory.empty()) { activeScreen = screenHistory.back(); screenHistory.pop_back(); screenHover = 0; }
            else if (storyActive) activeScreen.clear();
            return;
        }
        if (kind == "setting") {
            if (message.contains("key") && message.at("key").is_string() && message.contains("value"))
                updateUiSetting(message.at("key").get<std::string>(),message.at("value"));
            return;
        }
        if (kind != "action" || !message.contains("action") || !message.at("action").is_string()) return;
        const auto action = message.at("action").get<std::string>();
        const auto target = message.value("target",std::string{});
        const bool hasSlot = message.contains("slotIndex") && message.at("slotIndex").is_string();
        int requestedSlot = -1;
        if (hasSlot) {
            try { requestedSlot = std::stoi(message.at("slotIndex").get<std::string>()); }
            catch (...) { return; }
        }
        for (const auto& item : visibleScreenItems()) {
            if (item.value("action",std::string{}) != action || item.value("target",std::string{}) != target) continue;
            if (hasSlot != item.contains("slotIndex") || hasSlot && item.at("slotIndex").get<int>() != requestedSlot) continue;
            activateScreenItem(item); return;
        }
    }
    void openSlotScreen(const std::string& action) {
        const auto id = screenForRole(action == "save" ? "save-slots" : "load-slots");
        if (id.empty()) return;
        screenHistory.push_back(activeScreen); activeScreen = id; screenHover = 0;
    }
    void saveSlot(int index) {
        if (runtime.currentSceneName.empty() || runtime.currentSourceFile.empty() || runtime.currentLine < 1) return;
        json readonlyLocals = json::array(); for (const auto& frame : runtime.readonlyLocals) readonlyLocals.push_back(frame);
        json loopScopes = json::array(); for (const auto frame : runtime.loopScopes) loopScopes.push_back(frame);
        const auto savedAt = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        const json state = {{"version", 1}, {"saveId",gameScreens.value("saveId",std::string{})}, {"file", runtime.currentSourceFile}, {"scene", runtime.currentSceneName},
            {"line", runtime.currentLine}, {"variables", runtime.globals}, {"locals", runtime.locals},
            {"readonlyLocals", readonlyLocals}, {"loopScopes", loopScopes},
            {"presentation", presentationSnapshot()}, {"speaker", speaker}, {"text", text}, {"savedAt", savedAt}};
        const auto destination = slotPath(index); auto temporary = destination; temporary += ".tmp";
        { std::ofstream file(temporary, std::ios::binary | std::ios::trunc); if (!file) throw std::runtime_error("Cannot create save slot"); file << state.dump(2); file.flush(); if (!file) throw std::runtime_error("Cannot write save slot"); }
        replaceSaveFile(temporary,destination);
        slotCache.erase(index);
        // Capture the story layers independently of the currently open save UI.
        SDL_Texture* target = SDL_CreateTexture(renderer,SDL_PIXELFORMAT_RGBA8888,SDL_TEXTUREACCESS_TARGET,width,height);
        if (target) {
            SDL_Texture* previous = SDL_GetRenderTarget(renderer);
            SDL_Surface* pixels = nullptr;
            if (SDL_SetRenderTarget(renderer,target)) {
                SDL_SetRenderDrawColor(renderer,12,15,22,255); SDL_RenderClear(renderer);
                renderBackground();
                for (const auto* sprite : native_player::spritesByVisualOrder(characters)) this->sprite(*sprite);
                for (const auto* sprite : native_player::spritesByVisualOrder(images)) this->sprite(*sprite);
                pixels = SDL_RenderReadPixels(renderer,nullptr);
                SDL_SetRenderTarget(renderer,previous);
            }
            if (pixels) {
                SDL_Surface* scaled = SDL_ScaleSurface(pixels,320,180,SDL_SCALEMODE_LINEAR);
                if (scaled) {
                    const auto destination = saveDirectory / ("thumb-slot-" + std::to_string(index + 1) + ".png");
                    auto temporary = destination; temporary += ".tmp";
                    if (IMG_SavePNG(scaled,temporary.string().c_str())) {
                        try { replaceSaveFile(temporary,destination); }
                        catch (const std::exception&) { /* The snapshot remains valid even if preview generation fails. */ }
                    }
                    SDL_DestroySurface(scaled);
                }
                SDL_DestroySurface(pixels);
            }
            SDL_DestroyTexture(target);
        }
    }
    void loadSlot(int index) {
        const auto& saved = readSlot(index);
        if (!saved.is_object() || !saved.contains("file") || !saved.contains("scene") || !saved.contains("line")) return;
        activeScreen.clear(); screenHistory.clear();
        if (runtime.currentSceneName.empty()) { queuedLoad = saved; titleStarted = true; storyActive = true; }
        else runtime.pendingLoad = saved;
    }
    json takeQueuedLoad() { auto value = std::move(queuedLoad); queuedLoad = nullptr; return value; }
    static SDL_Color screenCssColor(std::string value, SDL_Color fallback) {
        if (value.empty() || value == "transparent") return value == "transparent" ? SDL_Color{0,0,0,0} : fallback;
        if (value[0] == '#') {
            try {
                const auto hex = value.substr(1);
                if (hex.size() == 6 || hex.size() == 8) {
                    const auto number = static_cast<unsigned long>(std::stoul(hex, nullptr, 16));
                    if (hex.size() == 6) return {Uint8((number >> 16) & 255), Uint8((number >> 8) & 255), Uint8(number & 255), 255};
                    return {Uint8((number >> 24) & 255), Uint8((number >> 16) & 255), Uint8((number >> 8) & 255), Uint8(number & 255)};
                }
            } catch (...) { return fallback; }
        }
        if (value.starts_with("rgb")) {
            const auto open = value.find('('), close = value.find(')');
            if (open != std::string::npos && close > open) {
                std::replace(value.begin() + open + 1, value.begin() + close, ',', ' ');
                std::istringstream input(value.substr(open + 1, close - open - 1));
                float r=0,g=0,b=0,a=1; if (input >> r >> g >> b) { input >> a; if (a <= 1) a *= 255; return {Uint8(std::clamp(r,0.0f,255.0f)), Uint8(std::clamp(g,0.0f,255.0f)), Uint8(std::clamp(b,0.0f,255.0f)), Uint8(std::clamp(a,0.0f,255.0f))}; }
            }
        }
        if (value == "white") return {255,255,255,255};
        if (value == "black") return {0,0,0,255};
        return fallback;
    }
    static float screenCssNumber(const json& style, const char* key, float fallback) {
        if (!style.contains(key) || !style.at(key).is_string()) return fallback;
        try { return std::stof(style.at(key).get<std::string>()); } catch (...) { return fallback; }
    }
    void drawScreenNode(const json& node, float sx, float sy, const json& items, float parentOpacity = 1.0f, int inheritedSlot = -1) {
        const auto& r = node.at("rect");
        SDL_FRect rect{r.value("x",0.0f)*sx, r.value("y",0.0f)*sy, r.value("width",0.0f)*sx, r.value("height",0.0f)*sy};
        if (rect.w <= 0 || rect.h <= 0) return;
        json style = node.value("style", json::object());
        float opacity = parentOpacity * std::clamp(screenCssNumber(style,"opacity",1.0f),0.0f,1.0f);
        const auto id = node.value("attrs", json::object()).value("id", std::string{});
        int itemIndex = -1;
        for (size_t i=0; i<items.size(); ++i) if (items[i].value("id", std::string{}) == id) { itemIndex = int(i); break; }
        const bool active = itemIndex >= 0 && itemIndex == screenHover;
        if (active && node.contains("hoverStyle")) for (const auto& [key, value] : node.at("hoverStyle").items()) style[key] = value;
        const auto attrs = node.value("attrs", json::object());
        const int slotIndex = attrs.contains("data-slot-index") ? std::stoi(attrs.at("data-slot-index").get<std::string>()) : inheritedSlot;
        const json* actionItem = itemIndex >= 0 ? &items[size_t(itemIndex)] : nullptr;
        if (slotIndex >= 0) for (const auto& candidate : items) if (candidate.value("slotIndex", -1) == slotIndex) { actionItem = &candidate; break; }
        if (attrs.contains("data-action") && actionItem && actionItem->value("disabled",false)) opacity *= 0.45f;
        SDL_SetRenderDrawBlendMode(renderer, SDL_BLENDMODE_BLEND);
        if (style.value("display", std::string{}) == "none") return;
        std::string fillValue = style.value("background-color", std::string{});
        if (fillValue.empty() && style.contains("background") && !style.at("background").get<std::string>().starts_with("url(")) fillValue = style.at("background").get<std::string>();
        if (!fillValue.empty()) {
            auto fill = screenCssColor(fillValue, {0,0,0,0});
            fill.a = Uint8(float(fill.a) * opacity);
            SDL_SetRenderDrawColor(renderer,fill.r,fill.g,fill.b,fill.a); SDL_RenderFillRect(renderer,&rect);
        }
        std::string backgroundImage = style.value("background-image", std::string{});
        if (backgroundImage.empty() && style.contains("background") && style.at("background").get<std::string>().starts_with("url(")) backgroundImage = style.at("background").get<std::string>();
        if (backgroundImage.starts_with("url(")) {
            const auto start = backgroundImage.find_first_of("\"'"), end = backgroundImage.find_last_of("\"'");
            std::string imageName = backgroundImage.substr(start == std::string::npos ? 4 : start + 1, start == std::string::npos ? backgroundImage.size() - 5 : end - start - 1);
            if (imageName.starts_with("asset/")) imageName.erase(0, 6);
            auto* texture = skinImage(imageName);
            if (texture) {
                SDL_SetTextureAlphaModFloat(texture, opacity);
                const auto fit = style.value("background-size",std::string{});
                if (fit == "contain") fitTexture(texture,rect);
                else if (fit == "cover") {
                    float sourceWidth=0,sourceHeight=0; SDL_GetTextureSize(texture,&sourceWidth,&sourceHeight);
                    const float scale=std::max(rect.w/sourceWidth,rect.h/sourceHeight);
                    SDL_FRect source{(sourceWidth-rect.w/scale)/2,(sourceHeight-rect.h/scale)/2,rect.w/scale,rect.h/scale};
                    SDL_RenderTexture(renderer,texture,&source,&rect);
                } else SDL_RenderTexture(renderer, texture, nullptr, &rect);
                SDL_SetTextureAlphaModFloat(texture, 1);
            }
        }
        if (node.value("tag", std::string{}) == "img") {
            auto imageName = attrs.value("src", std::string{}); if (imageName.starts_with("asset/")) imageName.erase(0, 6);
            if (auto* texture = skinImage(imageName)) {
                SDL_SetTextureAlphaModFloat(texture,opacity);
                if (style.value("object-fit",std::string{}) == "contain") fitTexture(texture,rect);
                else SDL_RenderTexture(renderer, texture, nullptr, &rect);
                SDL_SetTextureAlphaModFloat(texture,1);
            }
        }
        std::string borderValue = style.value("border-color", std::string{});
        if (borderValue.empty() && style.contains("border")) { const auto border = style.at("border").get<std::string>(); const auto split = border.find_last_of(' '); borderValue = split == std::string::npos ? border : border.substr(split + 1); }
        if (!borderValue.empty()) {
            auto border = screenCssColor(borderValue,{0,0,0,0});
            border.a = Uint8(float(border.a)*opacity);
            const int thickness = std::clamp(int(screenCssNumber(style,"border-width",1)*std::min(sx,sy)),0,12);
            SDL_SetRenderDrawColor(renderer,border.r,border.g,border.b,border.a);
            for(int n=0;n<thickness;++n) { SDL_FRect top{rect.x+float(n),rect.y+float(n),rect.w-2*n,1}, bottom{rect.x+float(n),rect.y+rect.h-float(n+1),rect.w-2*n,1}, left{rect.x+float(n),rect.y+float(n),1,rect.h-2*n}, right{rect.x+rect.w-float(n+1),rect.y+float(n),1,rect.h-2*n}; SDL_RenderFillRect(renderer,&top); SDL_RenderFillRect(renderer,&bottom); SDL_RenderFillRect(renderer,&left); SDL_RenderFillRect(renderer,&right); }
        }
        if (node.value("tag", std::string{}) == "input") {
            const auto key = attrs.value("data-setting", std::string{});
            const auto type = attrs.value("type", std::string{});
            const auto accent = screenCssColor(style.value("accent-color", std::string{}), {145,181,232,255});
            if (type == "checkbox") {
                SDL_FRect box{rect.x + rect.w * 0.25f, rect.y + rect.h * 0.18f, rect.w * 0.5f, rect.h * 0.64f};
                SDL_SetRenderDrawColor(renderer, 18, 25, 37, Uint8(235 * opacity)); SDL_RenderFillRect(renderer, &box);
                SDL_SetRenderDrawColor(renderer, accent.r, accent.g, accent.b, Uint8(accent.a * opacity)); SDL_RenderRect(renderer, &box);
                if (uiSettingValues.value(key, false)) {
                    SDL_FRect mark{box.x + box.w * 0.22f, box.y + box.h * 0.22f, box.w * 0.56f, box.h * 0.56f};
                    SDL_SetRenderDrawColor(renderer, accent.r, accent.g, accent.b, Uint8(accent.a * opacity)); SDL_RenderFillRect(renderer, &mark);
                }
            } else if (type == "range") {
                const float minimum = std::stof(attrs.value("min", std::string("0"))), maximum = std::stof(attrs.value("max", std::string("1")));
                const float value = std::clamp(uiSettingValues.value(key, minimum), minimum, maximum);
                const float ratio = (value - minimum) / (maximum - minimum);
                SDL_FRect rail{rect.x + rect.w * 0.04f, rect.y + rect.h * 0.38f, rect.w * 0.92f, std::max(2.0f, rect.h * 0.24f)};
                SDL_SetRenderDrawColor(renderer, 44, 56, 72, Uint8(245 * opacity)); SDL_RenderFillRect(renderer, &rail);
                SDL_FRect fill{rail.x, rail.y, rail.w * ratio, rail.h};
                SDL_SetRenderDrawColor(renderer, accent.r, accent.g, accent.b, Uint8(accent.a * opacity)); SDL_RenderFillRect(renderer, &fill);
                SDL_FRect thumb{rail.x + rail.w * ratio - rect.h * 0.28f, rect.y + rect.h * 0.1f, rect.h * 0.56f, rect.h * 0.8f};
                SDL_RenderFillRect(renderer, &thumb);
            }
        }
        std::string textValue = node.value("text",std::string{});
        const auto field = attrs.value("data-slot-field",std::string{});
        if (actionItem && slotIndex >= 0 && !field.empty()) {
            const auto saved = actionItem->value("slotSummary", json(nullptr));
            if (field == "number") { textValue = std::to_string(slotIndex + 1); if (slotIndex < 9) textValue.insert(0,"0"); }
            else if (field == "status") textValue = saved.is_object() ? "記録あり" : "空き";
            else if (field == "scene") textValue = saved.is_object() ? saved.value("scene",std::string{}) : "";
            else if (field == "speaker") textValue = saved.is_object() ? saved.value("speaker",std::string{}) : "";
            else if (field == "text") textValue = saved.is_object() ? saved.value("text",std::string{}) : "";
            else if (field == "saved-at") {
                textValue.clear();
                if (saved.is_object() && saved.contains("savedAt") && saved.at("savedAt").is_number_integer()) {
                    const auto time = std::time_t(saved.at("savedAt").get<int64_t>() / 1000);
                    if (const auto* local = std::localtime(&time)) { char buffer[32]{}; if (std::strftime(buffer,sizeof(buffer),"%Y/%m/%d %H:%M",local)) textValue = buffer; }
                }
            }
        } else if (actionItem && attrs.contains("data-slot-index") && node.value("children",json::array()).empty()) textValue = actionItem->value("label",textValue);
        if (!textValue.empty()) {
            auto textColor = screenCssColor(style.value("color",std::string{}),{245,247,248,255});
            textColor.a = Uint8(float(textColor.a)*opacity);
            const float fontSize = screenCssNumber(style,"font-size",22)*sy;
            int textWidth=0,textHeight=0; TTF_SetFontSize(font,std::max(1,int(fontSize))); TTF_GetStringSize(font,textValue.c_str(),textValue.size(),&textWidth,&textHeight);
            const float padLeft=screenCssNumber(style,"padding-left",screenCssNumber(style,"padding",5))*sx;
            const float padTop=screenCssNumber(style,"padding-top",screenCssNumber(style,"padding",0))*sy;
            const float padRight=screenCssNumber(style,"padding-right",screenCssNumber(style,"padding",5))*sx;
            float tx=rect.x+padLeft, ty=rect.y+padTop+std::max(0.0f,(rect.h-padTop-float(textHeight))/2.0f);
            if (style.value("text-align",std::string{}) == "center") tx=rect.x+std::max(0.0f,(rect.w-float(textWidth))/2.0f);
            else if (style.value("text-align",std::string{}) == "right") tx=rect.x+std::max(0.0f,rect.w-float(textWidth)-padRight);
            label(textValue,tx,ty,std::max(1,int(fontSize)),textColor,std::max(1.0f,rect.w-padLeft-padRight),rect.h-padTop);
        }
        for (const auto& child : node.value("children",json::array())) drawScreenNode(child,sx,sy,items,opacity,slotIndex);
    }
    const json* findScreenInput(const json& nodes, float mouseX, float mouseY) const {
        const json empty = json::array();
        const float sx = float(width) / float(gameScreens.at("canvas").at("width").get<int>());
        const float sy = float(height) / float(gameScreens.at("canvas").at("height").get<int>());
        for (auto it = nodes.rbegin(); it != nodes.rend(); ++it) {
            const auto& node = *it;
            if (node.value("style", json::object()).value("display", std::string{}) == "none") continue;
            const auto& children = node.contains("children") ? node.at("children") : empty;
            if (const auto* child = findScreenInput(children, mouseX, mouseY)) return child;
            if (node.value("tag", std::string{}) != "input") continue;
            const auto& rect = node.at("rect");
            const float x = rect.value("x", 0.0f) * sx, y = rect.value("y", 0.0f) * sy;
            const float w = rect.value("width", 0.0f) * sx, h = rect.value("height", 0.0f) * sy;
            if (mouseX >= x && mouseX <= x + w && mouseY >= y && mouseY <= y + h) return &node;
        }
        return nullptr;
    }
    const json* findScreenInputBySetting(const json& nodes, const std::string& key) const {
        const json empty = json::array();
        for (const auto& node : nodes) {
            if (node.value("tag", std::string{}) == "input" && node.value("attrs", json::object()).value("data-setting", std::string{}) == key) return &node;
            const auto& children = node.contains("children") ? node.at("children") : empty;
            if (const auto* child = findScreenInputBySetting(children, key)) return child;
        }
        return nullptr;
    }
    void updateScreenInput(const json& node, float mouseX) {
        const auto attrs = node.value("attrs", json::object());
        const auto key = attrs.value("data-setting", std::string{});
        if (key.empty()) return;
        if (attrs.value("type", std::string{}) == "checkbox") {
            updateUiSetting(key, !uiSettingValues.value(key, false));
            return;
        }
        const auto& rect = node.at("rect");
        const float sx = float(width) / float(gameScreens.at("canvas").at("width").get<int>());
        const float minimum = std::stof(attrs.value("min", std::string("0"))), maximum = std::stof(attrs.value("max", std::string("1")));
        const float left = rect.value("x", 0.0f) * sx, widthPx = rect.value("width", 0.0f) * sx;
        const float ratio = std::clamp((mouseX - left) / std::max(1.0f, widthPx), 0.0f, 1.0f);
        const float step = std::stof(attrs.value("step", std::string("0.01")));
        const float raw = minimum + ratio * (maximum - minimum);
        const float stepped = std::clamp(minimum + std::round((raw - minimum) / step) * step, minimum, maximum);
        updateUiSetting(key, stepped);
    }
    SDL_FRect screenItemRect(const json& item) const {
        const float sx = float(width) / float(gameScreens.at("canvas").at("width").get<int>());
        const float sy = float(height) / float(gameScreens.at("canvas").at("height").get<int>());
        return { item.at("x").get<float>() * sx, item.at("y").get<float>() * sy, item.at("width").get<float>() * sx, item.at("height").get<float>() * sy };
    }
    SDL_FRect playerControlRect(const json& item) {
        const float sx = float(width) / number("screen.width", 1280), sy = float(height) / number("screen.height", 720);
        const float dialogWidth = float(number("dialog.width", 900)), dialogHeight = float(number("dialog.height", 184));
        const float dx = config.contains("dialog.x") ? float(number("dialog.x", 0)) : (float(width) - dialogWidth) / 2.0f;
        const float dy = config.contains("dialog.y") ? float(number("dialog.y", 0)) : float(height) - dialogHeight - float(number("dialog.bottom", 26));
        const bool anchored = playerControls.value("anchor", std::string("dialogue-top-left")) == "dialogue-top-left";
        return {(anchored ? dx : 0.0f) + item.value("x", 0) * sx,
            (anchored ? dy : 0.0f) + item.value("y", -44) * sy,
            item.value("width", 84) * sx, item.value("height", 36) * sy};
    }
    json controlItems() const {
        if (playerControls.value("enabled", true) == false) return json::array();
        return playerControls.value("buttons", json::array());
    }
    void drawPlayerControls() {
        const auto items = controlItems();
        for (size_t i = 0; i < items.size(); ++i) {
            const auto& item = items[i]; const auto rect = playerControlRect(item); const bool active = int(i) == controlHover;
            const auto imageName = active ? item.value("hoverImage", item.value("image", std::string{})) : item.value("image", std::string{});
            if (!imageName.empty()) SDL_RenderTexture(renderer, skinImage(imageName), nullptr, &rect);
            else outlinedPanel(rect, active ? SDL_Color{44,61,73,248} : SDL_Color{17,24,31,230}, active ? SDL_Color{220,234,241,255} : SDL_Color{135,151,160,230}, active ? SDL_Color{197,219,230,255} : SDL_Color{100,119,130,220});
            if (item.value("display", std::string{}) != "image") {
                const auto labelText = active ? item.value("hoverLabel", item.value("label", item.value("action", std::string{}))) : item.value("label", item.value("action", std::string{}));
                label(labelText, rect.x + 5, rect.y + (rect.h - 24) / 2, item.value("fontSize", 15), {245,247,248,255}, rect.w - 10, rect.h);
            }
        }
    }
    void activateScreenItem(const json& item) {
        if (item.value("disabled", false)) return;
        if (item.contains("slotIndex")) {
            const int index = item.at("slotIndex").get<int>();
            if (item.value("action", std::string{}) == "save") saveSlot(index); else loadSlot(index);
            return;
        }
        const auto action = item.value("action", std::string{});
        if (action == "start") { activeScreen.clear(); titleStarted = true; storyActive = true; screenHistory.clear(); }
        else if (action == "continue") { if (const auto index = latestSaveSlotIndex()) loadSlot(*index); }
        else if (action == "resume") { activeScreen.clear(); screenHistory.clear(); }
        else if (action == "save" || action == "load") openSlotScreen(action);
        else if (action == "open-screen") {
            const auto target = item.value("target", std::string{});
            if (!gameScreens.at("screens").contains(target)) throw std::runtime_error("Missing game screen: " + target);
            screenHistory.push_back(activeScreen); activeScreen = target; screenHover = 0;
        } else if (action == "back") {
            if (!screenHistory.empty()) { activeScreen = screenHistory.back(); screenHistory.pop_back(); screenHover = 0; }
            else if (storyActive) activeScreen.clear();
        } else if (action == "quit") throw Quit{};
    }
    void runTitleScreen() {
        if (gameScreens.empty()) { titleStarted = true; return; }
        activeScreen = gameScreens.at("initial").get<std::string>();
        while (!titleStarted) pump();
    }
    static void SDLCALL audioTrackStopped(void* userdata, MIX_Track* track) {
        auto* engine = static_cast<Engine*>(userdata);
        std::lock_guard<std::mutex> lock(engine->stoppedAudioMutex);
        engine->stoppedAudioTracks.push_back(track);
    }
    void cleanupStoppedAudio() {
        std::vector<MIX_Track*> stopped;
        {
            std::lock_guard<std::mutex> lock(stoppedAudioMutex);
            stopped.swap(stoppedAudioTracks);
        }
        std::vector<MIX_Track*> pinned;
        for (auto* track : stopped) {
            const auto found = std::find_if(audio.begin(), audio.end(), [track](const AudioPlayback& playback) { return playback.track == track; });
            if (found == audio.end()) continue;
            if (found->pinned) { pinned.push_back(track); continue; }
            // BGM loops for its lifetime; if the selected incoming track stops
            // unexpectedly, retire its still-fading outgoing layers as well.
            // Otherwise SceneState reports no BGM while those layers remain audible.
            if (bgm == found->track) stopBgm();
            MIX_SetTrackStoppedCallback(found->track, nullptr, nullptr);
            if (bgm == found->track) bgm = nullptr;
            MIX_DestroyTrack(found->track);
            MIX_DestroyAudio(found->audio);
            audio.erase(found);
        }
        if (!pinned.empty()) {
            std::lock_guard<std::mutex> lock(stoppedAudioMutex);
            stoppedAudioTracks.insert(stoppedAudioTracks.end(), pinned.begin(), pinned.end());
        }
    }
    static float currentBgmGain(const AudioPlayback& playback) {
        const auto remaining = MIX_GetTrackFadeFrames(playback.track);
        return native_player::gainFromRemainingFrames(playback.fadeStartGain, playback.fadeTargetGain,
            playback.fadeDurationFrames, remaining);
    }
    json activeBgmGains() const {
        json layers=json::array();
        for(const auto& playback:audio) if(playback.bgm && MIX_TrackPlaying(playback.track))
            layers.push_back({{"asset",playback.asset},{"gain",currentBgmGain(playback)}});
        return layers;
    }
    json currentBgmProgress() const {
        if (!bgm) return nullptr;
        const auto current = std::find_if(audio.begin(), audio.end(), [this](const AudioPlayback& playback) { return playback.track == bgm; });
        if (current == audio.end()) return nullptr;
        const auto gain = currentBgmGain(*current);
        const auto distance = current->fadeTargetGain - current->fadeStartGain;
        return distance == 0 ? json(1.0f) : json(std::clamp((gain - current->fadeStartGain) / distance, 0.0f, 1.0f));
    }
    void stopBgm(int64_t fadeOutMs = 0, MIX_Track* keep = nullptr) {
        for (auto& playback : audio) {
            if (!playback.bgm || playback.track == keep || !MIX_TrackPlaying(playback.track)) continue;
            const auto startGain = fadeOutMs > 0 ? currentBgmGain(playback) : 0.0f;
            if (fadeOutMs > 0 && !MIX_SetTrackGain(playback.track, startGain)) throw std::runtime_error(SDL_GetError());
            const auto frames = fadeOutMs > 0 ? MIX_TrackMSToFrames(playback.track, fadeOutMs) : 0;
            if (!MIX_StopTrack(playback.track, frames)) throw std::runtime_error(SDL_GetError());
            playback.fadeStartGain = startGain;
            playback.fadeTargetGain = 0;
            playback.fadeDurationFrames = frames;
        }
        bgm = keep;
        if (!keep) bgmAsset.clear();
    }
    json presentationSnapshot() const {
        json characterState = json::array();
        for (const auto& [id, sprite] : characters) {
            characterState.push_back({{"id", id}, {"pose", sprite.pose}, {"slot", sprite.position},
                {"opacity", sprite.alpha}, {"offsetX", sprite.offsetX}, {"offsetY", sprite.offsetY},
                {"visualOrder", sprite.visualOrder}});
        }
        json imageState = json::array();
        for (const auto& [id, sprite] : images) {
            imageState.push_back({{"asset", id}, {"slot", sprite.position}, {"opacity", sprite.alpha},
                {"offsetX", sprite.offsetX}, {"offsetY", sprite.offsetY}, {"visualOrder", sprite.visualOrder}});
        }
        json activeMedia = json::array();
        for (const auto& playback : audio) {
            if (playback.bgm || !MIX_TrackPlaying(playback.track)) continue;
            activeMedia.push_back({{"kind", playback.type}, {"asset", playback.asset}});
        }
        std::sort(activeMedia.begin(), activeMedia.end(), [](const json& left, const json& right) {
            return std::pair(left.at("kind").get<std::string>(), left.at("asset").get<std::string>())
                < std::pair(right.at("kind").get<std::string>(), right.at("asset").get<std::string>());
        });
        json bgmState = nullptr;
        if (bgm && MIX_TrackPlaying(bgm)) {
            const auto current = std::find_if(audio.begin(), audio.end(), [this](const AudioPlayback& playback) { return playback.track == bgm; });
            if (current != audio.end()) {
                const auto gain = currentBgmGain(*current);
                const auto distance = current->fadeTargetGain - current->fadeStartGain;
                const float progress = distance == 0 ? 1.0f
                    : std::clamp((gain - current->fadeStartGain) / distance, 0.0f, 1.0f);
                bgmState = {{"asset", bgmAsset}, {"gain", gain}, {"transition", progress >= 1.0f ? "complete" : "running"}};
            }
        }
        json backgroundState = nullptr;
        if (background) backgroundState = {{"asset", backgroundAsset}, {"offsetX", backgroundOffsetX}, {"offsetY", backgroundOffsetY}};
        json videoState = video ? json{{"asset", videoAsset}} : json(nullptr);
        json effectState = overlay > 0 ? json{{"type", "fade"}, {"color", overlayColor.r > 127 ? "white" : "black"}, {"opacity", overlay}} : json(nullptr);
        json volumes=json::object(), volumeOverrides=json::object();
        for(const auto* kind:{"bgm","se","voice"}) {
            const auto found=config.find(std::string("audio.")+kind+"_volume");
            volumes[kind]=found==config.end() ? (std::string(kind)=="voice"?0.5f:1.0f) : std::stof(found->second);
        }
        for(const auto& [kind,gain]:audioVolumeOverrides) volumeOverrides[kind]=gain;
        return {{"logicalTimeMs", logicalTimeMs}, {"background", backgroundState}, {"video", videoState},
            {"characters", characterState}, {"images", imageState}, {"bgm", bgmState},
            {"audio",{{"volumes",volumes},{"volumeOverrides",volumeOverrides}}},{"ui",{{"dialogOpacity",config.contains("dialog.opacity")?std::stof(config.at("dialog.opacity")):1.0f}}},
            {"activeMedia", activeMedia}, {"effect", effectState}};
    }
    void restorePresentation(const json& state) {
        characters.clear(); images.clear(); nextVisualOrder = 0;
        audioVolumeOverrides.clear();
        const auto audioState=state.value("audio",json::object());
        const auto savedVolumes=audioState.value("volumes",json::object());
        for(const auto* kind:{"bgm","se","voice"}) {
            if(savedVolumes.contains(kind)) { const auto gain=savedVolumes.at(kind).get<float>(); if(!std::isfinite(gain)||gain<0||gain>1) throw std::runtime_error("Invalid saved audio volume"); config[std::string("audio.")+kind+"_volume"]=std::to_string(gain); }
            const auto gain=audioState.value("volumeOverrides",json::object()).value(kind,-1.0f);
            if(gain>=0) audioVolumeOverrides[kind]=gain;
        }
        const auto dialogOpacity=state.value("ui",json::object()).value("dialogOpacity",float(number("dialog.opacity",1)));
        if(!std::isfinite(dialogOpacity)||dialogOpacity<0||dialogOpacity>1) throw std::runtime_error("Invalid saved dialog opacity");
        config["dialog.opacity"]=std::to_string(dialogOpacity);
        background = nullptr; backgroundAsset.clear(); backgroundOffsetX = backgroundOffsetY = 0;
        if (state.contains("background") && state["background"].is_object()) {
            const auto& bg = state["background"];
            backgroundAsset = bg.value("asset", std::string{});
            backgroundOffsetX = bg.value("offsetX", 0.0f); backgroundOffsetY = bg.value("offsetY", 0.0f);
            if (!backgroundAsset.empty()) background = image(asset("bg", backgroundAsset));
        }
        for (const auto& value : state.value("characters", json::array())) {
            const auto id = value.at("id").get<std::string>(), pose = value.value("pose", std::string{});
            Sprite sprite; sprite.texture = image(asset("char", id, pose)); sprite.asset = id; sprite.pose = pose;
            sprite.position = value.value("slot", std::string("center")); sprite.alpha = value.value("opacity", 1.0f);
            sprite.offsetX = value.value("offsetX", 0.0f); sprite.offsetY = value.value("offsetY", 0.0f);
            sprite.visualOrder = value.value("visualOrder", uint64_t(++nextVisualOrder));
            nextVisualOrder = std::max(nextVisualOrder, sprite.visualOrder); characters[id] = std::move(sprite);
        }
        for (const auto& value : state.value("images", json::array())) {
            const auto id = value.at("asset").get<std::string>();
            Sprite sprite; sprite.texture = image(asset("image", id)); sprite.asset = id;
            sprite.position = value.value("slot", std::string("center")); sprite.alpha = value.value("opacity", 1.0f);
            sprite.offsetX = value.value("offsetX", 0.0f); sprite.offsetY = value.value("offsetY", 0.0f);
            sprite.visualOrder = value.value("visualOrder", uint64_t(++nextVisualOrder));
            nextVisualOrder = std::max(nextVisualOrder, sprite.visualOrder); images[id] = std::move(sprite);
        }
        logicalTimeMs = state.value("logicalTimeMs", uint64_t(0));
        const auto effect = state.value("effect", json(nullptr));
        overlay = effect.is_object() ? effect.value("opacity", 0.0f) : 0.0f;
        const auto effectColor = effect.is_object() ? effect.value("color", std::string("black")) : std::string("black");
        overlayColor = effectColor == "white" ? SDL_Color{255,255,255,255} : SDL_Color{0,0,0,255};
        stopBgm();
        const auto bgmState = state.value("bgm", json(nullptr));
        if (bgmState.is_object() && bgmState.contains("asset")) sound("bgm", bgmState.at("asset").get<std::string>(),0,false,bgmState.value("gain",-1.0f));
    }
    void pump() {
        if (screenWebView) for (const auto& message : screenWebView->takeMessages()) handleWebScreenMessage(message);
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            if (screenWebView && e.type == SDL_EVENT_WINDOW_RESIZED) screenWebView->resize();
            if (e.type == SDL_EVENT_QUIT) throw Quit{};
            if (!activeScreen.empty() && screenWebView && screenWebView->ready()
                && (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN || e.type == SDL_EVENT_MOUSE_BUTTON_UP
                    || e.type == SDL_EVENT_MOUSE_MOTION || e.type == SDL_EVENT_MOUSE_WHEEL || e.type == SDL_EVENT_KEY_DOWN)) continue;
            if (!activeScreen.empty() && currentScreen().contains("uiTree")) {
                bool consumed = false;
                const auto& tree = currentScreen().at("uiTree");
                if (e.type == SDL_EVENT_MOUSE_BUTTON_UP) draggedUiSetting.clear();
                if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
                    if (const auto* input = findScreenInput(tree, float(e.button.x), float(e.button.y))) {
                        const auto attrs = input->value("attrs", json::object());
                        draggedUiSetting = attrs.value("data-setting", std::string{});
                        updateScreenInput(*input, float(e.button.x));
                        if (attrs.value("type", std::string{}) == "checkbox") draggedUiSetting.clear();
                        consumed = true;
                    }
                } else if (e.type == SDL_EVENT_MOUSE_MOTION && !draggedUiSetting.empty()) {
                    if (const auto* input = findScreenInputBySetting(tree, draggedUiSetting)) updateScreenInput(*input, float(e.motion.x));
                    consumed = true;
                }
                if (consumed) continue;
            }
            if (e.type == SDL_EVENT_KEY_DOWN && e.key.scancode == SDL_SCANCODE_ESCAPE) {
                if (!activeScreen.empty() && activeScreen == "pause") activeScreen.clear();
                else if (activeScreen.empty() && storyActive && gameScreens.contains("screens") && gameScreens["screens"].contains("pause")) { activeScreen = "pause"; screenHover = 0; }
                else if (!activeScreen.empty() && !screenHistory.empty()) { activeScreen = screenHistory.back(); screenHistory.pop_back(); screenHover = 0; }
            } else if (!activeScreen.empty() && e.type == SDL_EVENT_KEY_DOWN) {
                const auto items = visibleScreenItems();
                if (!items.empty() && (e.key.scancode == SDL_SCANCODE_DOWN || e.key.scancode == SDL_SCANCODE_UP)) {
                    const int delta = e.key.scancode == SDL_SCANCODE_DOWN ? 1 : -1;
                    screenHover = (screenHover + delta + int(items.size())) % int(items.size());
                } else if (!items.empty() && (e.key.scancode == SDL_SCANCODE_RETURN || e.key.scancode == SDL_SCANCODE_SPACE)) activateScreenItem(items.at(size_t(std::clamp(screenHover, 0, int(items.size()) - 1))));
            } else if (!activeScreen.empty() && e.type == SDL_EVENT_MOUSE_MOTION) {
                const auto items = visibleScreenItems(); screenHover = -1;
                for (size_t i = 0; i < items.size(); ++i) { const auto r = screenItemRect(items[i]); if (e.motion.x >= r.x && e.motion.x <= r.x + r.w && e.motion.y >= r.y && e.motion.y <= r.y + r.h) screenHover = int(i); }
            } else if (!activeScreen.empty() && e.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
                const auto items = visibleScreenItems();
                for (size_t cursor = items.size(); cursor > 0; --cursor) { const size_t i = cursor - 1; const auto r = screenItemRect(items[i]); if (!items[i].value("disabled",false) && e.button.x >= r.x && e.button.x <= r.x + r.w && e.button.y >= r.y && e.button.y <= r.y + r.h) { screenHover = int(i); activateScreenItem(items[i]); break; } }
            } else if (e.type == SDL_EVENT_KEY_DOWN) {
                if (options.empty()) next = true;
                else if (e.key.scancode == SDL_SCANCODE_DOWN) { hovered = (hovered + 1 + int(options.size())) % int(options.size()); const auto box = choiceRect(size_t(hovered)); const auto view = choiceViewport(); if (box.y + box.h > view.y + view.h) choiceScroll += box.y + box.h - (view.y + view.h); clampChoiceScroll(); }
                else if (e.key.scancode == SDL_SCANCODE_UP) { hovered = (hovered - 1 + int(options.size())) % int(options.size()); const auto box = choiceRect(size_t(hovered)); const auto view = choiceViewport(); if (box.y < view.y) choiceScroll -= view.y - box.y; clampChoiceScroll(); }
                else if (e.key.scancode == SDL_SCANCODE_RETURN || e.key.scancode == SDL_SCANCODE_SPACE) selection = hovered < 0 ? 0 : hovered;
            }
            if (e.type == SDL_EVENT_MOUSE_WHEEL && !options.empty()) { const auto view = choiceViewport(); if (e.wheel.mouse_x >= view.x && e.wheel.mouse_x <= view.x + view.w && e.wheel.mouse_y >= view.y && e.wheel.mouse_y <= view.y + view.h) { choiceScroll -= e.wheel.y * float(number("choice.height", 48) + number("choice.gap", 10)); clampChoiceScroll(); } }
            if (e.type == SDL_EVENT_MOUSE_MOTION && !options.empty()) {
                hovered = -1;
                const auto view = choiceViewport();
                if (e.motion.x >= view.x && e.motion.x <= view.x + view.w && e.motion.y >= view.y && e.motion.y <= view.y + view.h)
                    for (size_t i = 0; i < options.size(); ++i) { const auto box = choiceRect(i); if (e.motion.x >= box.x && e.motion.x <= box.x + box.w && e.motion.y >= box.y && e.motion.y <= box.y + box.h) hovered = int(i); }
            }
            if (e.type == SDL_EVENT_MOUSE_MOTION && activeScreen.empty() && storyActive) {
                const auto items = controlItems(); controlHover = -1;
                for (size_t i = 0; i < items.size(); ++i) { const auto r = playerControlRect(items[i]); if (e.motion.x >= r.x && e.motion.x <= r.x + r.w && e.motion.y >= r.y && e.motion.y <= r.y + r.h) controlHover = int(i); }
            }
            if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
                bool controlActivated = false;
                if (activeScreen.empty() && storyActive) {
                    const auto items = controlItems();
                    for (const auto& item : items) { const auto r = playerControlRect(item); if (e.button.x >= r.x && e.button.x <= r.x + r.w && e.button.y >= r.y && e.button.y <= r.y + r.h) { openSlotScreen(item.value("action", std::string{})); controlActivated = true; break; } }
                }
                if (!controlActivated) {
                    if (options.empty()) next = true;
                    else { const auto view = choiceViewport(); if (e.button.x >= view.x && e.button.x <= view.x + view.w && e.button.y >= view.y && e.button.y <= view.y + view.h) for (size_t i = 0; i < options.size(); ++i) { const auto box = choiceRect(i); if (e.button.x >= box.x && e.button.x <= box.x + box.w && e.button.y >= box.y && e.button.y <= box.y + box.h) selection = int(i); } }
                }
            }
        }
        cleanupStoppedAudio();
        if (video) { video->update(); if (video->finished) { video.reset(); videoAsset.clear(); } }
        SDL_SetRenderDrawColor(renderer,12,15,22,255); SDL_RenderClear(renderer);
        if (!activeScreen.empty()) {
            const auto& screen = currentScreen();
            const auto screenMusic = screen.value("music", std::string{});
            if (!screenMusic.empty() && screenMusic != screenMusicAsset) { sound("bgm", screenMusic); screenMusicAsset = screenMusic; }
            if (background) SDL_RenderTexture(renderer, background, nullptr, nullptr);
            for (const auto* s : native_player::spritesByVisualOrder(characters)) sprite(*s);
            for (const auto* s : native_player::spritesByVisualOrder(images)) sprite(*s);
            const auto bgName = screen.value("background", std::string{});
            if (!bgName.empty()) { auto* bg = skinImage(bgName); SDL_RenderTexture(renderer, bg, nullptr, nullptr); }
            else { SDL_SetRenderDrawColor(renderer, 8, 12, 18, 175); SDL_RenderFillRect(renderer, nullptr); }
            const float sx = float(width) / float(gameScreens.at("canvas").at("width").get<int>());
            const float sy = float(height) / float(gameScreens.at("canvas").at("height").get<int>());
            const auto items = visibleScreenItems();
            bool webReady = false;
            if (screenWebView && screen.contains("webDocument") && screen.at("webDocument").is_object()) {
                const auto& document = screen.at("webDocument");
                screenWebView->show(activeScreen,document.value("markup",std::string{}),document.value("stylesheet",std::string{}),webScreenModel());
                webReady = screenWebView->ready();
            }
            if (webReady) {
                // The WebView child renders the validated HTML/CSS over the SDL stage.
            } else if (screen.contains("uiTree")) {
                for (const auto& node : screen.at("uiTree")) drawScreenNode(node,sx,sy,items);
            } else {
            const auto title = screen.value("title", std::string{});
            if (!title.empty()) label(title, 64 * sx, 42 * sy, int(34 * sy), {245,247,248,255}, float(width) - 128 * sx);
            const auto description = screen.value("description", std::string{});
            if (!description.empty()) label(description, 64 * sx, 112 * sy, int(21 * sy), {240,238,232,255}, std::min(560.0f, float(gameScreens.at("canvas").at("width").get<int>() - 128)) * sx, float(gameScreens.at("canvas").at("height").get<int>() - 150) * sy);
            for (size_t i = 0; i < items.size(); ++i) {
                const auto& item = items[i]; const auto rect = screenItemRect(item); const bool active = int(i) == screenHover;
                const auto imageName = active ? item.value("hoverImage", item.value("image", std::string{})) : item.value("image", std::string{});
                if (!imageName.empty()) SDL_RenderTexture(renderer, skinImage(imageName), nullptr, &rect);
                else outlinedPanel(rect, active ? SDL_Color{44,61,73,240} : SDL_Color{17,24,31,215}, active ? SDL_Color{205,221,230,255} : SDL_Color{135,151,160,210}, active ? SDL_Color{197,219,230,255} : SDL_Color{100,119,130,220});
                if (item.value("display", std::string{}) != "image") label(active ? item.value("hoverLabel", item.value("label", std::string{})) : item.value("label", std::string{}), rect.x + 12 * sx, rect.y + (rect.h - 28 * sy) / 2, int(item.value("fontSize", 22) * sy), {245,247,248,255}, rect.w - 24 * sx, rect.h);
            }
            }
            SDL_RenderPresent(renderer); SDL_Delay(8);
            if (automated) { activeScreen.clear(); titleStarted = true; }
            return;
        }
        if (screenWebView) screenWebView->hide();
        renderBackground();
        for (const auto* s : native_player::spritesByVisualOrder(characters)) sprite(*s);
        for (const auto* s : native_player::spritesByVisualOrder(images)) sprite(*s);
        if (number("ui.bottom_fog", 1)) bottomFog();
        const float dialogWidth = float(number("dialog.width", 900));
        const float dialogHeight = float(number("dialog.height", 184));
        const float dx = config.contains("dialog.x") ? float(number("dialog.x", 0)) : (float(width) - dialogWidth) / 2.0f;
        const float dy = config.contains("dialog.y") ? float(number("dialog.y", 0)) : float(height) - dialogHeight - float(number("dialog.bottom", 26));
        SDL_FRect box{dx, dy, dialogWidth, dialogHeight};
        auto col=color("dialog.text_color",{235,241,248,255});
        SDL_FRect dialogBox = box;
        const float dialogOpacity = (dialogueOpacityOverride >= 0 ? dialogueOpacityOverride : float(number("dialog.opacity", 1))) * uiSettingValues.value("ui.dialogOpacity", 1.0f);
        if (dialog) { SDL_SetTextureAlphaModFloat(dialog, dialogOpacity); SDL_RenderTexture(renderer, dialog, nullptr, &box); SDL_SetTextureAlphaModFloat(dialog, 1); }
        else { auto fill=color("dialog.background_color", {13,20,33,232}), border=color("dialog.border_color", {112,159,201,180}), accent=color("dialog.accent_color", {100,190,255,255}); fill.a=Uint8(fill.a*dialogOpacity); border.a=Uint8(border.a*dialogOpacity); accent.a=Uint8(accent.a*dialogOpacity); outlinedPanel(box,fill,border,accent); }
        const float textX = dialogBox.x + float(number("dialog.text_x", 190));
        const float textY = dialogBox.y + float(number("dialog.text_y", 63));
        const float textWidth = float(number("dialog.text_width", 844));
        speakerLabel(speaker, dialogBox.x + float(number("dialog.speaker_x", 90)), dialogBox.y + float(number("dialog.speaker_y", -52)), number("dialog.speaker_size", number("font.size", 24)), color("dialog.speaker_color", col));
        dialogueLabel(text, textX, textY, number("dialog.text_size", number("font.size", 24)), col, textWidth, float(number("dialog.text_height", 0)));
        if (options.empty() && !text.empty()) label("竕ｫ", float(width) - 66, float(height) - 68, 34, {230,240,250,210}, 48);
        drawPlayerControls();
        const auto choiceView = choiceViewport();
        SDL_Rect choiceClip{ int(choiceView.x), int(choiceView.y), int(choiceView.w), int(choiceView.h) };
        SDL_SetRenderClipRect(renderer, &choiceClip);
        for (size_t i=0;i<options.size();++i) {
            SDL_FRect b = choiceRect(i); const bool active = int(i) == hovered;
            if (active ? choiceActiveSkin : choiceSkin) SDL_RenderTexture(renderer, active ? choiceActiveSkin : choiceSkin, nullptr, &b);
            else outlinedPanel(b, active ? SDL_Color{31,65,98,245} : SDL_Color{14,24,39,232}, active ? SDL_Color{125,210,255,255} : SDL_Color{92,128,163,190}, active ? SDL_Color{112,208,255,255} : SDL_Color{67,114,159,220});
            label(options[i], b.x + float(number("choice.text_x", 24)), b.y + float(number("choice.text_y", 12)), number("choice.text_size", 19), color("choice.text_color", {240,246,252,255}), float(number("choice.text_width", int(b.w) - 42)), float(number("choice.text_height", 0)));
        }
        SDL_SetRenderClipRect(renderer, nullptr);
        if (video) {
            float sourceWidth = 0, sourceHeight = 0;
            SDL_GetTextureSize(video->texture, &sourceWidth, &sourceHeight);
            const auto fit = native_player::videoContainRect(sourceWidth, sourceHeight, float(width), float(height));
            SDL_FRect videoRect{fit.x, fit.y, fit.width, fit.height};
            SDL_RenderTexture(renderer, video->texture, nullptr, &videoRect);
        }
        if (overlay>0) { SDL_SetRenderDrawColor(renderer,overlayColor.r,overlayColor.g,overlayColor.b,Uint8(255*overlay)); SDL_RenderFillRect(renderer,nullptr); }
        SDL_RenderPresent(renderer); SDL_Delay(8);
    }
    void delay(int64_t ms, std::function<void(float)> animate = {}) {
        if (ms<0 || ms>2147483647) throw std::runtime_error("Invalid duration");
        auto start = SDL_GetTicks();
        bool midpointCaptured = false;
        do {
            const auto elapsed = SDL_GetTicks()-start;
            float progress=native_player::linearProgress(elapsed,ms);
            if(animate) animate(progress);
            if(captureAnimationMidpoints && animate && !midpointCaptured && progress>=0.48f && progress<=0.56f) {
                animationMidpoints.push_back({{"durationMs",ms},{"progress",progress},{"state",presentationSnapshot()},{"bgmProgress",currentBgmProgress()},{"bgmLayers",activeBgmGains()}});
                midpointCaptured = true;
            }
            pump();
        } while(SDL_GetTicks()-start<uint64_t(ms));
        if(animate) animate(1);
        logicalTimeMs += uint64_t(ms);
    }
    float configuredAudioVolume(const std::string& type, const std::string& id) const {
        if (const auto override = audioVolumeOverrides.find(type); override != audioVolumeOverrides.end()) return override->second;
        for (const auto& definition : runtime.program.at("assets")) if (definition.value("type", std::string{}) == type && definition.value("name", std::string{}) == id) {
            if (definition.contains("volume")) return definition.at("volume").get<float>();
            break;
        }
        const auto found = config.find("audio." + type + "_volume");
        if (found == config.end()) return type == "voice" ? 0.5f : 1.0f;
        return std::stof(found->second);
    }
    MIX_Track* sound(const std::string& type,const std::string& id,int64_t crossfadeMs=0,bool pinned=false,float requestedGain=-1.0f) {
        // Keep existing BGM layers until the replacement track has started,
        // for both instant switches and crossfades. A failed candidate must
        // never leave the scene state claiming that a stopped track is active.
        auto* a=MIX_LoadAudio(mixer,utf8Path(asset(type,id)).c_str(),true); if(!a) throw std::runtime_error(SDL_GetError());
        auto* track=MIX_CreateTrack(mixer);
        if(!track) { MIX_DestroyAudio(a); throw std::runtime_error(SDL_GetError()); }
        if(!MIX_SetTrackAudio(track,a)) { const auto error=SDL_GetError(); MIX_DestroyTrack(track); MIX_DestroyAudio(a); throw std::runtime_error(error); }
        const float gain = requestedGain < 0 ? configuredAudioVolume(type,id) : requestedGain;
        if (!std::isfinite(gain) || gain < 0 || gain > 1) { MIX_DestroyTrack(track); MIX_DestroyAudio(a); throw std::runtime_error("Audio volume must be between 0.0 and 1.0"); }
        if (!MIX_SetTrackGain(track, gain)) { const auto error=SDL_GetError(); MIX_DestroyTrack(track); MIX_DestroyAudio(a); throw std::runtime_error(error); }
        const std::string channel = type == "bgm" ? "bgm" : type == "voice" ? "voice" : "se";
        const std::string tag = "ui_" + channel;
        if (!MIX_TagTrack(track, tag.c_str())) { const auto error=SDL_GetError(); MIX_DestroyTrack(track); MIX_DestroyAudio(a); throw std::runtime_error(error); }
        audioTagSeen[channel] = true;
        if (!MIX_SetTagGain(mixer, tag.c_str(), uiSettingGain(channel))) { const auto error=SDL_GetError(); MIX_DestroyTrack(track); MIX_DestroyAudio(a); throw std::runtime_error(error); }
        auto props=SDL_CreateProperties();
        if(!props) { const auto error=SDL_GetError(); MIX_DestroyTrack(track); MIX_DestroyAudio(a); throw std::runtime_error(error); }
        if(type=="bgm") {SDL_SetNumberProperty(props,MIX_PROP_PLAY_LOOPS_NUMBER,-1);if(crossfadeMs>0)SDL_SetNumberProperty(props,MIX_PROP_PLAY_FADE_IN_MILLISECONDS_NUMBER,crossfadeMs);}
        const auto fadeFrames = type=="bgm" && crossfadeMs>0 ? MIX_TrackMSToFrames(track,crossfadeMs) : 0;
        audio.push_back({track,a,type=="bgm",pinned,type,id,fadeFrames,
            type=="bgm" && crossfadeMs>0 ? 0.0f : gain, gain});
        if (!MIX_SetTrackStoppedCallback(track, &Engine::audioTrackStopped, this)) {
            const auto error=SDL_GetError(); audio.pop_back(); SDL_DestroyProperties(props); MIX_DestroyTrack(track); MIX_DestroyAudio(a); throw std::runtime_error(error);
        }
        const bool ok=MIX_PlayTrack(track,props);
        SDL_DestroyProperties(props);
        if(!ok) {
            const auto error=SDL_GetError();
            MIX_SetTrackStoppedCallback(track,nullptr,nullptr);
            if(bgm==track) bgm=nullptr;
            const auto found=std::find_if(audio.begin(),audio.end(),[track](const AudioPlayback& playback){return playback.track==track;});
            if(found!=audio.end()) audio.erase(found);
            MIX_DestroyTrack(track); MIX_DestroyAudio(a); throw std::runtime_error(error);
        }
        if(type=="bgm") {
            if(crossfadeMs>0) stopBgm(crossfadeMs,track);
            else stopBgm(0,track);
            bgmAsset=id;
        }
        return track;
    }
    void command(const std::string& name,const json& args) {
        auto s=[&](size_t i){return args.at(i).get<std::string>();};
        auto pixelOffset=[&](const std::string& option,size_t& index) -> float {
            if(option.size()<2 || (option[0]!='x' && option[0]!='y') || (option[1]!='+' && option[1]!='-')) throw std::runtime_error("Invalid pixel offset");
            double amount=0;
            if(option.size()==2) {
                if(++index>=args.size() || !args.at(index).is_number()) throw std::runtime_error("Invalid pixel offset expression");
                amount=args.at(index).get<double>();
            } else {
                int64_t integer=0;
                const auto parsed=std::from_chars(option.data()+2,option.data()+option.size(),integer);
                if(parsed.ec!=std::errc{} || parsed.ptr!=option.data()+option.size()) throw std::runtime_error("Invalid pixel offset");
                amount=double(integer);
            }
            if(!std::isfinite(amount) || std::abs(amount)>1000000) throw std::runtime_error("Pixel offset magnitude must not exceed 1000000");
            return float(option[1]=='-'?-amount:amount);
        };
        if(name=="volume") {
            const auto kind=s(0); const float gain=args.at(1).get<float>();
            if((kind!="bgm" && kind!="se" && kind!="voice") || !std::isfinite(gain) || gain<0 || gain>1) throw std::runtime_error("Invalid audio volume");
            audioVolumeOverrides[kind]=gain;
        }
        else if(name=="dialog") {
            const float opacity=args.at(1).get<float>();
            if(s(0)!="opacity" || !std::isfinite(opacity) || opacity<0 || opacity>1) throw std::runtime_error("Invalid dialog opacity");
            config["dialog.opacity"]=std::to_string(opacity);
        }
        else if(name=="say") {
            const float previousOpacity=dialogueOpacityOverride;
            if(args.size()==4) {
                const float opacity=args.at(3).get<float>();
                if(s(2)!="opacity" || !std::isfinite(opacity) || opacity<0 || opacity>1) throw std::runtime_error("Invalid per-line dialog opacity");
                dialogueOpacityOverride=opacity;
            }
            speaker=(s(0)=="none" || s(0)=="narrator") ? "" : s(0);
            if(!speaker.empty()) {
                try { auto actor=runtime.get(speaker); if(actor.is_object() && actor.contains("name") && actor.at("name").is_string())speaker=actor.at("name").get<std::string>(); }
                catch(const std::runtime_error&) {}
            }
            try { text=runtime.interpolate(args.at(1));next=false;if(automated)pump();else while(!next && !runtime.pendingLoad.is_object())pump(); }
            catch(...) { dialogueOpacityOverride=previousOpacity; throw; }
            dialogueOpacityOverride=previousOpacity;
        }
        else if(name=="wait") delay(args.at(0).get<int64_t>());
        else if(name=="bg") { background=image(asset("bg",s(0))); backgroundAsset=s(0); backgroundOffsetX=0; backgroundOffsetY=0; }
        else if(name=="bgm") sound("bgm",s(0));
        else if(name=="play") {
            if(s(0)=="video") {video=std::make_unique<Video>(renderer,utf8Path(asset("video",s(1))));videoAsset=s(1);if(args.size()>2 && s(2)=="blocking")while(video)pump();}
            else if(s(0)=="bgm") {
                int64_t crossfadeMs=0;
                float gain=-1.0f;
                for(size_t i=2;i<args.size();) {
                    const auto option=s(i++);
                    if(option=="crossfade") { if(i>=args.size()) throw std::runtime_error("Missing BGM crossfade duration"); crossfadeMs=args.at(i++).get<int64_t>(); if(crossfadeMs<0 || crossfadeMs>2147483647) throw std::runtime_error("Invalid BGM crossfade duration"); }
                    else if(option=="volume") { if(i>=args.size()) throw std::runtime_error("Missing BGM volume"); gain=args.at(i++).get<float>(); }
                    else throw std::runtime_error("Invalid BGM option");
                }
                sound("bgm",s(1),crossfadeMs,false,gain);
            } else {
                const auto kind=s(0); bool blockingVoice=false; float gain=-1.0f;
                for(size_t i=2;i<args.size();) { const auto option=s(i++); if(option=="volume") { if(i>=args.size()) throw std::runtime_error("Missing audio volume"); gain=args.at(i++).get<float>(); } else if(option=="blocking" || option=="async") blockingVoice=option=="blocking"; else throw std::runtime_error("Invalid audio option"); }
                auto* track=sound(kind,s(1),0,blockingVoice,gain);
                if(blockingVoice) {
                    while(MIX_TrackPlaying(track)) pump();
                    const auto found=std::find_if(audio.begin(),audio.end(),[track](const AudioPlayback& playback){return playback.track==track;});
                    if(found!=audio.end()) found->pinned=false;
                    cleanupStoppedAudio();
                }
            }
        } else if(name=="move") {
            const auto kind=s(0);
            const bool isCharacter=kind=="character";
            if(!isCharacter && kind!="bg") throw std::runtime_error("move target must be character or bg");
            const auto id=isCharacter?s(1):std::string("bg");
            const size_t offsetStart=isCharacter?3:2;
            if(s(isCharacter?2:1)!="by") throw std::runtime_error("move requires by before pixel offsets");
            Sprite* actor=nullptr;
            if(isCharacter) {
                const auto found=characters.find(id);
                if(found==characters.end()) throw std::runtime_error("move target character is not visible: "+id);
                actor=&found->second;
            } else if(!background) throw std::runtime_error("move target background is not set");
            float dx=0,dy=0; bool hasX=false,hasY=false;
            size_t index=offsetStart;
            for(;index<args.size();++index) {
                if(!args.at(index).is_string()) break;
                const auto option=args.at(index).get<std::string>();
                if(option=="over") break;
                if(option.size()<2 || (option[0]!='x' && option[0]!='y') || (option[1]!='+' && option[1]!='-')) throw std::runtime_error("Invalid move pixel offset");
                const bool isX=option[0]=='x';
                if((isX && hasX)||(!isX && hasY)) throw std::runtime_error("Duplicate move pixel offset axis");
                const float value=pixelOffset(option,index);
                if(isX) {dx=value;hasX=true;} else {dy=value;hasY=true;}
            }
            if(!hasX&&!hasY) throw std::runtime_error("move requires at least one pixel offset");
            int64_t duration=0;
            if(index<args.size()) {
                if(index+2!=args.size() || s(index)!="over") throw std::runtime_error("Invalid move duration syntax");
                duration=args.at(index+1).get<int64_t>();
            }
            if(duration<0 || duration>2147483647) throw std::runtime_error("Invalid move duration");
            const float fromX=isCharacter?actor->offsetX:backgroundOffsetX;
            const float fromY=isCharacter?actor->offsetY:backgroundOffsetY;
            const float toX=fromX+float(dx),toY=fromY+float(dy);
            if(std::abs(toX)>1000000 || std::abs(toY)>1000000) throw std::runtime_error("move target position exceeds +/-1000000 px");
            auto apply=[&](float t) {
                if(isCharacter) { actor->offsetX=fromX+(toX-fromX)*t; actor->offsetY=fromY+(toY-fromY)*t; }
                else { backgroundOffsetX=fromX+(toX-fromX)*t; backgroundOffsetY=fromY+(toY-fromY)*t; }
            };
            if(duration) delay(duration,apply); else apply(1);
        } else if(name=="show") {
            if(s(0)=="image") {
                Sprite sprite; sprite.texture=image(asset("image",s(1))); sprite.position=s(2); sprite.asset=s(1); sprite.visualOrder=++nextVisualOrder;
                images[s(1)]=std::move(sprite);
            }
            else {
                const auto dot=s(0).find('.');
                if(dot==std::string::npos) throw std::runtime_error("show requires character.pose or image id");
                const auto id=s(0).substr(0,dot), pose=s(0).substr(dot+1);
                const auto position=s(1);
                float offsetX=0,offsetY=0; bool hasX=false,hasY=false;
                size_t transitionIndex=2;
                for(;transitionIndex<args.size();++transitionIndex) {
                    if(!args.at(transitionIndex).is_string()) break;
                    const auto option=args.at(transitionIndex).get<std::string>();
                    if(option.size()<2 || (option[0]!='x' && option[0]!='y') || (option[1]!='+' && option[1]!='-')) break;
                    if(option[0]=='x' ? hasX : hasY) throw std::runtime_error("Duplicate show pixel offset axis");
                    const float value=pixelOffset(option,transitionIndex);
                    if(option[0]=='x') hasX=true; else hasY=true;
                    if(option[0]=='x') offsetX=value; else offsetY=value;
                }
                auto* texture=image(asset("char",id,pose));
                for(auto it=characters.begin();it!=characters.end();) {
                    if(it->first!=id && it->second.position==position) it=characters.erase(it); else ++it;
                }
                const auto existing=characters.find(id);
                const auto order=existing==characters.end()?++nextVisualOrder:existing->second.visualOrder;
                Sprite sprite; sprite.texture=texture; sprite.position=position; sprite.asset=id; sprite.pose=pose;
                sprite.offsetX=offsetX; sprite.offsetY=offsetY; sprite.visualOrder=order;
                characters[id]=std::move(sprite);
                if(transitionIndex<args.size() && s(transitionIndex)=="fade")delay(args.at(transitionIndex+1).get<int64_t>(),[&](float t){characters.at(id).alpha=t;});
            }
        } else if(name=="hide") {
            const auto id=s(0);
            if(characters.contains(id) && args.size()>1 && s(1)=="fade")delay(args.at(2).get<int64_t>(),[&](float t){characters.at(id).alpha=1-t;});characters.erase(id);
        }
        else if(name=="clear") {if(s(0)=="image")images.erase(s(1));else if(s(0)=="bg"){background=nullptr;backgroundAsset.clear();backgroundOffsetX=0;backgroundOffsetY=0;}else if(s(0)=="bgm")stopBgm();}
        else if(name=="effect") {overlayColor=s(1)=="white"?SDL_Color{255,255,255,255}:SDL_Color{0,0,0,255};delay(args.size()>2?args.at(2).get<int64_t>():500,[&](float t){overlay=1-t;});}
        else throw std::runtime_error("Unknown command: "+name);
        pump();
    }
};
namespace native_player {
static json debugPrimitiveValue(const std::string& type, const json& value) {
    if (type == "int" && (value.is_number_integer() || value.is_string())) return novel::integer(novel::text(value));
    if (type == "float" && (value.is_number() || value.is_string())) return novel::floating(novel::text(value));
    if (type == "str" && value.is_string()) return value;
    if (type == "bool" && value.is_boolean()) return value;
    throw std::runtime_error("Invalid debug value for type: " + type);
}
static json debugValue(const json& entry) {
    const auto type = entry.at("type").get<std::string>();
    if (type == "str") return entry.at("value").get<std::string>();
    if (type == "int") return novel::integer(entry.at("value").get<std::string>());
    if (type == "float") return novel::floating(entry.at("value").get<std::string>());
    if (type == "bool") {
        const auto& value = entry.at("value");
        if (value.is_boolean()) return value;
        if (value.is_string() && (value == "true" || value == "false")) return value == "true";
        throw std::runtime_error("Invalid debug bool value");
    }
    auto value = json::parse(entry.at("value").get<std::string>());
    if (type.starts_with("list<") && type.ends_with(">")) {
        const auto itemType = type.substr(5, type.size() - 6);
        if (!value.is_array()) throw std::runtime_error("Debug list value must be an array");
        for (auto& item : value) item = debugPrimitiveValue(itemType, item);
        return value;
    }
    if (type.starts_with("dict<") && type.ends_with(">")) {
        const auto itemType = type.substr(5, type.size() - 6);
        if (!value.is_object()) throw std::runtime_error("Debug dictionary value must be an object");
        for (auto it = value.begin(); it != value.end(); ++it) it.value() = debugPrimitiveValue(itemType, it.value());
        return value;
    }
    if (type == "struct") {
        if (!value.is_object() || !entry.contains("fields") || !entry.at("fields").is_object() || value.size() != entry.at("fields").size()) throw std::runtime_error("Invalid debug structure shape");
        for (auto field = entry.at("fields").begin(); field != entry.at("fields").end(); ++field) {
            if (!value.contains(field.key())) throw std::runtime_error("Missing debug structure field: " + field.key());
            auto& current = value[field.key()];
            const auto fieldType = field.value().get<std::string>();
            try { current = debugPrimitiveValue(fieldType, current); }
            catch (const std::exception&) { throw std::runtime_error("Invalid debug structure field: " + field.key()); }
        }
        return value;
    }
    throw std::runtime_error("Unsupported debug variable type: " + type);
}

int run(const fs::path& packagePath, const std::vector<std::string>& arguments) {
    try {
        std::ifstream file(packagePath);json package;file>>package;
        if(package.value("format","")!="novel-script-package" || package.at("version")!=1)throw std::runtime_error("Unsupported package format/version");
        std::string mode;
        json debug = nullptr;
        for (size_t index = 0; index < arguments.size(); ++index) {
            const auto& argument = arguments[index];
            if (argument == "--headless" || argument == "--smoke" || argument == "--screen-smoke" || argument == "--screen-control-smoke" || argument == "--screen-slot-smoke" || argument == "--screen-web-smoke" || argument == "--screen-save-smoke") { mode = argument; continue; }
            if (argument == "--load-slot") {
                if (index + 1 >= arguments.size()) throw std::runtime_error("Usage: --load-slot <1-100>");
                size_t consumed = 0; const int slot = std::stoi(arguments[++index], &consumed);
                if (consumed != arguments[index].size() || slot < 1 || slot > 100) throw std::runtime_error("Save slot number must be between 1 and 100");
                const auto directory = saveDirectoryFor(packagePath,package);
                migrateLegacySaves(packagePath,directory);
                std::ifstream savedFile(directory / ("slot-" + std::to_string(slot) + ".json"));
                if (!savedFile) throw std::runtime_error("Cannot open requested save slot");
                debug = json::parse(savedFile);
                if (!debug.is_object() || debug.value("version", 0) != 1 || !debug.contains("file") || !debug.contains("scene") || !debug.contains("line") || !debug.contains("variables")) throw std::runtime_error("Invalid save slot format");
                if (debug.contains("saveId") && debug.at("saveId") != package.value("native_ui",json::object()).value("save_id",std::string{})) throw std::runtime_error("Save slot belongs to another work");
                continue;
            }
            if (argument == "--debug-start") {
                if (index + 4 >= arguments.size()) throw std::runtime_error("Usage: --debug-start <file> <scene> <line-or-0> <variables-json>");
                if (!package.value("debug", false)) throw std::runtime_error("Debug start requires a package built with --debug");
                auto sourceFile = arguments[++index];
                std::replace(sourceFile.begin(), sourceFile.end(), '\\', '/');
                const auto sceneName = arguments[++index];
                size_t consumed = 0;
                const auto line = std::stoll(arguments[++index], &consumed);
                if (consumed != arguments[index].size() || line < 0) throw std::runtime_error("Debug line must be a non-negative integer");
                const auto supplied = json::parse(arguments[++index]);
                if (!supplied.is_object()) throw std::runtime_error("Debug variables must be a JSON object");
                json variables = json::object();
                for (auto it = supplied.begin(); it != supplied.end(); ++it) variables[it.key()] = debugValue(it.value());
                debug = {{"file", sourceFile}, {"scene", sceneName}, {"line", line ? json(line) : json(nullptr)}, {"variables", variables}};
                continue;
            }
            throw std::runtime_error("Unknown player argument: " + argument);
        }
        novel::Runtime runtime;
        runtime.load=[&](std::string name){
            if(name.ends_with(".txt")) throw std::runtime_error("Legacy .txt scene files are not supported");
            if(!name.ends_with(".tds"))name+=".tds";
            if(!package.contains("files")||!package["files"].contains(name))throw std::runtime_error("Missing packaged scene: "+name);
            std::set<std::string> visited;
            std::function<void(const json&, json&)> mergeIncludes = [&](const json& source, json& target){
                for(const auto& include : source.value("includes", json::array())) {
                    auto includeName = include.get<std::string>();
                    if(includeName.ends_with(".txt")) throw std::runtime_error("Legacy .txt scene files are not supported");
                    if(!includeName.ends_with(".tds"))includeName += ".tds";
                    if(!package["files"].contains(includeName) || !visited.insert(includeName).second) continue;
                    const auto& dependency = package["files"][includeName];
                    mergeIncludes(dependency, target);
                    for(const auto& fn : dependency.value("functions", json::array())) target["functions"].push_back(fn);
                }
            };
            auto result = package["files"][name];
            mergeIncludes(result, result);
            return result;
        };
        auto program = package.at("program");
        if (debug.is_object()) {
            const auto sourceFile = debug.at("file").get<std::string>();
            if (!package.contains("files") || !package.at("files").contains(sourceFile)) throw std::runtime_error("Debug source file is not in this package: " + sourceFile);
            program = runtime.load(sourceFile);
        }
        runtime.program = program;
        bool headless=mode=="--headless";
        if(headless){
            json transcript=json::array();
            runtime.command=[&](const std::string& n,const json& a){
                auto recorded=a;
                if(n=="say" && recorded.size()>1) recorded[1]=runtime.interpolate(recorded.at(1));
                transcript.push_back({{"name",n},{"args",recorded}});
            };
            runtime.choice=[](const std::string&,const std::vector<std::string>&){return size_t(0);};
            runtime.run(program, debug);std::cout<<json{{"globals",runtime.globals},{"commands",transcript}}.dump()<<"\n";
        }else{
            Engine engine(runtime,fs::absolute(packagePath), package);
            engine.captureAnimationMidpoints=mode=="--smoke";
            json playbackTimings=json::array();
            bool failedCrossfadeRetained=false;
            bool failedInstantBgmRetained=false;
            bool failedVideoReplacementRetained=false;
            bool failedSpriteReplacementRetained=false;
            bool failedBackgroundReplacementRetained=false;
            bool failedSePlaybackRejected=false;
            bool failedVoicePlaybackRejected=false;
            bool failedIncomingBgmRetiredOutgoing=false;
            bool pendingIncomingBgmFailureProbe=false;
            bool repeatedImageRaised=false;
            bool completedBgmCrossfadeAfterBlockingWait=false;
            bool relativeCharacterMoveMatched=false;
            bool relativeBackgroundMoveMatched=false;
            bool characterSlotReplacementMatched=false;
            bool bgmCrossfadeCompletedDuringBlockingVoice=false;
            json presentationTrace=json::array();
            int64_t lastBgmCrossfadeDurationMs=0;
            MIX_Track* lastBgmCrossfadeTrack=nullptr;
            engine.automated = mode=="--smoke" || mode=="--screen-smoke";
            const bool tdsTitle = engine.gameScreens.contains("titleScene") && engine.gameScreens["titleScene"].is_object();
            if (mode == "--screen-save-smoke") {
                runtime.currentSourceFile = "main.tds"; runtime.currentSceneName = "main"; runtime.currentLine = 1;
                engine.speaker = "Narrator"; engine.text = "checkpoint";
                engine.saveSlot(0);
                engine.text = "revised"; engine.saveSlot(0);
                const auto thumbnail = engine.saveDirectory / "thumb-slot-1.png";
                std::ifstream savedFile(engine.slotPath(0)); json reloaded; savedFile >> reloaded;
                std::cout << json{{"save",fs::is_regular_file(engine.slotPath(0))},{"thumbnail",fs::is_regular_file(thumbnail)},{"text",reloaded.value("text","")}}.dump() << "\n";
                return fs::is_regular_file(thumbnail) ? 0 : 1;
            }
            if (mode == "--screen-web-smoke") {
                if (!engine.screenWebView) throw std::runtime_error("WebView2 host is unavailable");
                engine.activeScreen = engine.gameScreens.at("initial").get<std::string>();
                const auto deadline = SDL_GetTicks() + 12000;
                while (!engine.screenWebView->ready() && SDL_GetTicks() < deadline) engine.pump();
                if (!engine.screenWebView->ready()) throw std::runtime_error("WebView2 document did not become ready: " + engine.screenWebView->status());
                engine.screenWebView->probeImageForTest("package-art");
                while (engine.screenWebView->imageProbeResult() < 0 && SDL_GetTicks() < deadline) engine.pump();
                if (engine.screenWebView->imageProbeResult() != 1) throw std::runtime_error("WebView2 could not load a packaged screen image");
                engine.screenWebView->clickForTest("open-screen","system");
                while (engine.activeScreen != "system" && SDL_GetTicks() < deadline) engine.pump();
                if (engine.activeScreen != "system") throw std::runtime_error("WebView2 action bridge did not navigate to system");
                while (!engine.screenWebView->ready() && SDL_GetTicks() < deadline) engine.pump();
                engine.screenWebView->clickForTest("open-screen","sound");
                while (engine.activeScreen != "sound" && SDL_GetTicks() < deadline) engine.pump();
                if (engine.activeScreen != "sound") throw std::runtime_error("WebView2 did not navigate to sound settings");
                while (!engine.screenWebView->ready() && SDL_GetTicks() < deadline) engine.pump();
                engine.screenWebView->setSettingForTest("audio.bgm",0.37);
                while (std::abs(engine.uiSettingValues.value("audio.bgm",1.0) - 0.37) > 0.001 && SDL_GetTicks() < deadline) engine.pump();
                if (std::abs(engine.uiSettingValues.value("audio.bgm",1.0) - 0.37) > 0.001) throw std::runtime_error("WebView2 range setting did not reach Native");
                SDL_SetWindowSize(engine.window,1000,600);
                int windowWidth = 0, windowHeight = 0; SDL_GetWindowSize(engine.window,&windowWidth,&windowHeight);
                while (engine.screenWebView->boundsForTest() != std::pair<int,int>{windowWidth,windowHeight} && SDL_GetTicks() < deadline) engine.pump();
                if (engine.screenWebView->boundsForTest() != std::pair<int,int>{windowWidth,windowHeight}) throw std::runtime_error("WebView2 bounds did not follow SDL resize");
                std::cout << json{{"webReady",true},{"imageLoaded",true},{"activeScreen",engine.activeScreen},{"bgmVolume",engine.uiSettingValues.value("audio.bgm",1.0)},{"resized",true}}.dump() << "\n";
                return 0;
            }
            if (mode == "--screen-slot-smoke") {
                json result = json::object();
                result["continueAvailable"] = engine.latestSaveSlotIndex().has_value();
                for (const auto& role : {"save-slots", "load-slots"}) {
                    const auto id = engine.screenForRole(role);
                    if (id.empty()) throw std::runtime_error("Missing slot screen");
                    engine.activeScreen = id;
                    const auto items = engine.visibleScreenItems();
                    const auto tree = engine.currentScreen().value("uiTree", json::array());
                    const auto count = engine.currentScreen().value("slotLayout", json::object()).value("count", 0);
                    if (count < 1 || items.empty() || !items[0].contains("slotSummary")) throw std::runtime_error("Slot cards did not reach Native UI items");
                    const float sx = float(engine.width) / float(engine.gameScreens.at("canvas").at("width").get<int>());
                    const float sy = float(engine.height) / float(engine.gameScreens.at("canvas").at("height").get<int>());
                    for (const auto& node : tree) engine.drawScreenNode(node,sx,sy,items);
                    SDL_RenderPresent(engine.renderer);
                    result[role] = {{"count",count},{"firstStatus",items[0].at("slotSummary").is_object() ? "saved" : "empty"},{"secondStatus",items[1].at("slotSummary").is_object() ? "saved" : "empty"},{"thirdStatus",items[2].at("slotSummary").is_object() ? "saved" : "empty"},{"thirdState",engine.slotState(2)}};
                }
                std::cout << result.dump() << "\n";
                return 0;
            }
            if (mode == "--screen-control-smoke") {
                engine.automated = true;
                engine.activeScreen = engine.gameScreens.at("initial").get<std::string>();
                const auto& initialScreen = engine.currentScreen();
                const auto inputEvent = [&](Uint32 type, float x, float y) {
                    SDL_Event event{}; event.type = type;
                    if (type == SDL_EVENT_MOUSE_BUTTON_DOWN || type == SDL_EVENT_MOUSE_BUTTON_UP) { event.button.button = SDL_BUTTON_LEFT; event.button.x = x; event.button.y = y; }
                    else { event.motion.x = x; event.motion.y = y; }
                    if (!SDL_PushEvent(&event)) throw std::runtime_error(SDL_GetError());
                };
                const auto initialTree = initialScreen.value("uiTree", json::array());
                const auto* slider = engine.findScreenInputBySetting(initialTree, "audio.bgm");
                const auto* toggle = engine.findScreenInputBySetting(initialTree, "audio.bgmMuted");
                if (!slider || !toggle) throw std::runtime_error("Control smoke requires BGM slider and mute toggle in the initial screen");
                const auto canvasWidth = float(engine.gameScreens.at("canvas").at("width").get<int>()), canvasHeight = float(engine.gameScreens.at("canvas").at("height").get<int>());
                const float sx = float(engine.width) / canvasWidth, sy = float(engine.height) / canvasHeight;
                const auto sliderRect = slider->at("rect");
                const float sliderX = (sliderRect.value("x", 0.0f) + sliderRect.value("width", 0.0f) * 0.75f) * sx;
                const float sliderY = (sliderRect.value("y", 0.0f) + sliderRect.value("height", 0.0f) / 2.0f) * sy;
                inputEvent(SDL_EVENT_MOUSE_BUTTON_DOWN, sliderX, sliderY); inputEvent(SDL_EVENT_MOUSE_BUTTON_UP, sliderX, sliderY);
                const auto toggleRect = toggle->at("rect");
                const float toggleX = (toggleRect.value("x", 0.0f) + toggleRect.value("width", 0.0f) / 2.0f) * sx;
                const float toggleY = (toggleRect.value("y", 0.0f) + toggleRect.value("height", 0.0f) / 2.0f) * sy;
                inputEvent(SDL_EVENT_MOUSE_BUTTON_DOWN, toggleX, toggleY); inputEvent(SDL_EVENT_MOUSE_BUTTON_UP, toggleX, toggleY);
                const auto startItems = engine.visibleScreenItems();
                bool queuedStart = false;
                for (const auto& item : startItems) if (item.value("action", std::string{}) == "start") {
                    const auto rect = engine.screenItemRect(item);
                    inputEvent(SDL_EVENT_MOUSE_BUTTON_DOWN, rect.x + rect.w / 2.0f, rect.y + rect.h / 2.0f);
                    queuedStart = true; break;
                }
                if (!queuedStart) throw std::runtime_error("Control smoke requires a start button in the initial screen");
                engine.runTitleScreen();
                if (std::abs(engine.uiSettingValues.value("audio.bgm", 0.0f) - 0.75f) > 0.03f || !engine.uiSettingValues.value("audio.bgmMuted", false)) throw std::runtime_error("Native screen controls did not update expected settings");
            } else if ((!engine.automated || mode=="--screen-smoke") && !debug.is_object() && !tdsTitle) engine.runTitleScreen();
            if (tdsTitle) engine.storyActive = true;
            auto queuedLoad = engine.takeQueuedLoad();
            if (queuedLoad.is_object()) {
                debug = queuedLoad;
                program = runtime.load(debug.at("file").get<std::string>());
            }
            runtime.beforeInstruction = [&](const json& instruction, const std::string& scene) {
                runtime.currentSceneName = scene;
                runtime.currentSourceFile = instruction.value("file", runtime.program.value("sourceFile", std::string{}));
                runtime.currentLine = instruction.value("line", int64_t(0));
            };
            runtime.restorePresentation = [&](const json& state) { engine.restorePresentation(state); };
            runtime.command=[&](const std::string& n,const json& a){
                const auto started=SDL_GetTicks();
                bool commandSucceeded=true;
                try { if (!(n == "say" && runtime.pendingLoad.is_object())) engine.command(n,a); }
                catch (...) {
                    const bool expectedFailureProbe=mode=="--smoke" && n=="play" && a.size()>2
                        && a.at(0)=="bgm" && a.at(1)=="broken_bgm" && a.at(2)=="crossfade";
                    const bool expectedInstantBgmFailureProbe=mode=="--smoke" && n=="bgm" && a.size()>0
                        && a.at(0)=="broken_bgm";
                    const bool expectedVideoFailureProbe=mode=="--smoke" && n=="play" && a.size()>1
                        && a.at(0)=="video" && a.at(1)=="broken_video";
                    const bool expectedSpriteFailureProbe=mode=="--smoke" && n=="show" && a.size()>1
                        && a.at(0)=="ghost.normal";
                    const bool expectedBackgroundFailureProbe=mode=="--smoke" && n=="bg" && a.size()>0
                        && a.at(0)=="broken_bg";
                    const bool expectedSeFailureProbe=mode=="--smoke" && n=="play" && a.size()>1
                        && a.at(0)=="se" && a.at(1)=="broken_se";
                    const bool expectedVoiceFailureProbe=mode=="--smoke" && n=="play" && a.size()>1
                        && a.at(0)=="voice" && a.at(1)=="broken_voice";
                    if(expectedFailureProbe) {
                        commandSucceeded=false;
                        failedCrossfadeRetained=engine.bgm && MIX_TrackPlaying(engine.bgm);
                        if(!failedCrossfadeRetained) throw std::runtime_error("Failed BGM crossfade stopped the previous Native track");
                    } else if(expectedInstantBgmFailureProbe) {
                        commandSucceeded=false;
                        failedInstantBgmRetained=engine.bgm && MIX_TrackPlaying(engine.bgm);
                        if(!failedInstantBgmRetained) throw std::runtime_error("Failed instant BGM replacement stopped the previous Native track");
                    } else if(expectedVideoFailureProbe) {
                        commandSucceeded=false;
                        failedVideoReplacementRetained=engine.video && !engine.video->finished;
                        if(!failedVideoReplacementRetained) throw std::runtime_error("Failed video replacement discarded the previous Native video");
                    } else if(expectedSpriteFailureProbe) {
                        commandSucceeded=false;
                        failedSpriteReplacementRetained=engine.characters.contains("hero")
                            && engine.characters.at("hero").position==a.at(1).get<std::string>()
                            && !engine.characters.contains("ghost");
                        if(!failedSpriteReplacementRetained) throw std::runtime_error("Failed sprite replacement discarded the previous Native slot occupant");
                    } else if(expectedBackgroundFailureProbe) {
                        commandSucceeded=false;
                        failedBackgroundReplacementRetained=engine.background && engine.backgroundAsset=="room";
                        if(!failedBackgroundReplacementRetained) throw std::runtime_error("Failed background replacement discarded the previous Native background");
                    } else if(expectedSeFailureProbe) {
                        commandSucceeded=false;
                        failedSePlaybackRejected=true;
                    } else if(expectedVoiceFailureProbe) {
                        commandSucceeded=false;
                        failedVoicePlaybackRejected=true;
                    } else throw;
                }
                if(commandSucceeded && mode=="--smoke" && n=="play" && a.size()>1
                   && (a.at(0)=="voice" || a.at(0)=="video" || a.at(0)=="se" || a.at(0)=="bgm")) {
                    const std::string type=a.at(0).get<std::string>();
                    const auto optionBegin=a.begin()+std::min<size_t>(2,a.size());
                    const bool crossfade=std::find(optionBegin,a.end(),json("crossfade"))!=a.end();
                    const bool blocking=std::find(optionBegin,a.end(),json("blocking"))!=a.end();
                    const bool async=std::find(optionBegin,a.end(),json("async"))!=a.end();
                    const auto playbackMode=type=="bgm"?(crossfade?"crossfade":"instant")
                        :(blocking?"blocking":async?"async":type=="se"?"nonblocking":"async");
                    playbackTimings.push_back({{"type",type},{"mode",playbackMode},{"elapsedMs",SDL_GetTicks()-started}});
                }
                if(commandSucceeded && mode=="--smoke" && n=="play" && a.size()>2
                   && a.at(0)=="voice" && std::find(a.begin()+2,a.end(),json("blocking"))!=a.end() && lastBgmCrossfadeDurationMs>0) {
                    bgmCrossfadeCompletedDuringBlockingVoice=engine.bgm && engine.bgm==lastBgmCrossfadeTrack
                        && MIX_TrackPlaying(engine.bgm) && MIX_GetTrackFadeFrames(engine.bgm)==0;
                    if(!bgmCrossfadeCompletedDuringBlockingVoice) throw std::runtime_error("Native BGM crossfade did not progress during blocking Voice playback");
                }
                if(commandSucceeded && mode=="--smoke" && n=="play" && a.size()>1
                   && a.at(0)=="bgm" && a.at(1)=="simulate_late_failure") {
                    if(!engine.bgm || !MIX_StopTrack(engine.bgm, 0)) throw std::runtime_error("Could not inject late incoming BGM failure");
                    pendingIncomingBgmFailureProbe=true;
                }
                if(commandSucceeded && pendingIncomingBgmFailureProbe && mode=="--smoke" && n=="wait") {
                    const bool liveBgm=std::any_of(engine.audio.begin(),engine.audio.end(),[](const Engine::AudioPlayback& playback) {
                        return playback.bgm && MIX_TrackPlaying(playback.track);
                    });
                    failedIncomingBgmRetiredOutgoing=!engine.bgm && !liveBgm;
                    if(!failedIncomingBgmRetiredOutgoing) throw std::runtime_error("Late incoming BGM failure left an outgoing Native layer playing");
                    pendingIncomingBgmFailureProbe=false;
                }
                if(commandSucceeded && mode=="--smoke" && n=="play" && a.size()>3
                   && a.at(0)=="bgm" && std::find(a.begin()+2,a.end(),json("crossfade"))!=a.end()) {
                    const auto crossfade=std::find(a.begin()+2,a.end(),json("crossfade"));
                    if(crossfade+1==a.end()) throw std::runtime_error("Smoke trace found crossfade without its duration");
                    lastBgmCrossfadeDurationMs=(crossfade+1)->get<int64_t>();
                    lastBgmCrossfadeTrack=engine.bgm;
                }
                if(commandSucceeded && mode=="--smoke" && n=="wait" && lastBgmCrossfadeDurationMs>0
                   && a.at(0).get<int64_t>()>=lastBgmCrossfadeDurationMs) {
                    const auto bgmTrackCount=std::count_if(engine.audio.begin(),engine.audio.end(),[](const Engine::AudioPlayback& playback){return playback.bgm;});
                    completedBgmCrossfadeAfterBlockingWait=engine.bgm && engine.bgm==lastBgmCrossfadeTrack
                        && MIX_TrackPlaying(engine.bgm) && MIX_GetTrackFadeFrames(engine.bgm)==0 && bgmTrackCount==1;
                }
                if(commandSucceeded && mode=="--smoke" && n=="show" && a.size()>1
                   && a.at(0)=="image" && a.at(1)=="first" && engine.images.contains("second")) {
                    repeatedImageRaised=engine.images.at("first").visualOrder>engine.images.at("second").visualOrder;
                    if(!repeatedImageRaised) throw std::runtime_error("Redisplaying a Native image did not raise it in visual order");
                }
                if(commandSucceeded && mode=="--smoke" && n=="move" && a.size()>1 && a.at(0)=="character" && a.at(1)=="friend") {
                    const auto found=engine.characters.find("friend");
                    relativeCharacterMoveMatched=found!=engine.characters.end()
                        && std::abs(found->second.offsetX-(-4.25f))<0.001f
                        && std::abs(found->second.offsetY-29.25f)<0.001f;
                    if(!relativeCharacterMoveMatched) throw std::runtime_error("Native relative character movement produced an unexpected final offset");
                }
                if(commandSucceeded && mode=="--smoke" && n=="move" && a.size()==6
                   && a.at(0)=="bg" && a.at(1)=="by" && a.at(2)=="x+" && a.at(3).is_number()
                   && std::abs(a.at(3).get<double>()-6.5)<0.001 && a.at(4)=="y-" && a.at(5).is_number()
                   && std::abs(a.at(5).get<double>()-3.25)<0.001) {
                    relativeBackgroundMoveMatched=std::abs(engine.backgroundOffsetX-6.5f)<0.001f
                        && std::abs(engine.backgroundOffsetY-(-3.25f))<0.001f;
                    if(!relativeBackgroundMoveMatched) throw std::runtime_error("Native relative background movement produced an unexpected final offset");
                }
                if(commandSucceeded && mode=="--smoke" && n=="show" && a.size()>1
                   && a.at(0)=="friend.normal" && a.at(1)=="left") {
                    characterSlotReplacementMatched=engine.characters.contains("friend")
                        && engine.characters.at("friend").position=="left"
                        && !engine.characters.contains("hero");
                    if(!characterSlotReplacementMatched) throw std::runtime_error("Native slot replacement left multiple characters visible in one position");
                }
                if (mode=="--smoke") presentationTrace.push_back({{"command",n},{"state",engine.presentationSnapshot()}});
            };
            runtime.choice=[&](const std::string& p,const std::vector<std::string>& labels){engine.text=p;engine.options=labels;engine.choiceScroll=0;engine.hovered=labels.empty()?-1:0;engine.selection=engine.automated?0:-1;engine.pump();while(engine.selection<0)engine.pump();auto selected=engine.selection;engine.options.clear();engine.hovered=-1;return size_t(selected);};
            try {
                runtime.run(program, debug);
                while(engine.video)engine.pump();
                if (mode == "--smoke") {
                    for (int attempt = 0; attempt < 25 && !engine.audio.empty(); ++attempt) { engine.cleanupStoppedAudio(); SDL_Delay(4); }
                    if (!engine.audio.empty()) throw std::runtime_error("Audio tracks did not release after all blocking and cleared playback ended");
                    std::cout << json{{"playbackTimings",playbackTimings},{"presentationTrace",presentationTrace},{"animationMidpoints",engine.animationMidpoints},{"dialogue",{{"speaker",engine.speaker},{"text",engine.text}}},{"failedCrossfadeRetained",failedCrossfadeRetained},{"failedInstantBgmRetained",failedInstantBgmRetained},{"failedVideoReplacementRetained",failedVideoReplacementRetained},{"failedSpriteReplacementRetained",failedSpriteReplacementRetained},{"failedBackgroundReplacementRetained",failedBackgroundReplacementRetained},{"failedSePlaybackRejected",failedSePlaybackRejected},{"failedVoicePlaybackRejected",failedVoicePlaybackRejected},{"failedIncomingBgmRetiredOutgoing",failedIncomingBgmRetiredOutgoing},{"repeatedImageRaised",repeatedImageRaised},{"completedBgmCrossfadeAfterBlockingWait",completedBgmCrossfadeAfterBlockingWait},{"relativeCharacterMoveMatched",relativeCharacterMoveMatched},{"relativeBackgroundMoveMatched",relativeBackgroundMoveMatched},{"characterSlotReplacementMatched",characterSlotReplacementMatched},{"bgmCrossfadeCompletedDuringBlockingVoice",bgmCrossfadeCompletedDuringBlockingVoice}}.dump() << "\n";
                }
                if (mode == "--screen-control-smoke") std::cout << json{{"uiSettings",engine.uiSettingValues}}.dump() << "\n";
            }
            catch(const Quit&){}
        }
        return 0;
    }catch(const std::exception&e){std::cerr<<"PLAYER ERROR: "<<e.what()<<"\n";return 1;}
}

} // namespace native_player
