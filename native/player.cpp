#include "player.hpp"
#include "runtime.hpp"
#include "video.hpp"
#include "scene_geometry.hpp"
#include "scene_presentation.hpp"
#include "audio_transition.hpp"
#include <SDL3_image/SDL_image.h>
#include <SDL3_ttf/SDL_ttf.h>
#include <SDL3_mixer/SDL_mixer.h>
#include <algorithm>
#include <cmath>
#include <charconv>
#include <cctype>
#include <cstdlib>
#include <chrono>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <iterator>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <regex>
#include <set>
#include <sstream>
#include <thread>
#include <unordered_map>
#include <string_view>
#include <vector>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif
using novel::json;
namespace fs = std::filesystem;
static bool saveIdCompatible(const json& saved, const std::string& expected) {
    if (!saved.is_object() || !saved.contains("saveId")) return true;
    const auto& value = saved.at("saveId");
    return value.is_string() && (value.get<std::string>().empty() || value.get<std::string>() == expected);
}
static bool validSavedSceneName(const json& value) {
    if (!value.is_string()) return false;
    static const std::regex sceneNamePattern("^[A-Za-z_][A-Za-z0-9_]*$");
    return std::regex_match(value.get<std::string>(), sceneNamePattern);
}
static bool validSavedLine(const json& value) {
    constexpr uint64_t maxSafeInteger = 9007199254740991ULL;
    if (value.is_number_unsigned()) {
        const auto line = value.get<uint64_t>();
        return line >= 1 && line <= maxSafeInteger;
    }
    if (value.is_number_integer()) {
        const auto line = value.get<int64_t>();
        return line >= 1 && static_cast<uint64_t>(line) <= maxSafeInteger;
    }
    if (!value.is_number_float()) return false;
    const double line = value.get<double>();
    return std::isfinite(line) && line >= 1 && line <= static_cast<double>(maxSafeInteger) && std::floor(line) == line;
}
static bool validSavedFrames(const json& value) {
    const size_t localCount = value.contains("locals") && value.at("locals").is_array() ? value.at("locals").size() : 0;
    if (value.contains("locals")) {
        if (!value.at("locals").is_array()) return false;
        for (const auto& frame : value.at("locals")) if (!frame.is_object()) return false;
    }
    if (value.contains("readonlyLocals")) {
        if (!value.at("readonlyLocals").is_array()) return false;
        for (const auto& frame : value.at("readonlyLocals")) {
            if (!frame.is_array()) return false;
            for (const auto& name : frame) if (!name.is_string()) return false;
        }
        if (value.at("readonlyLocals").size() != (value.contains("locals") ? value.at("locals").size() : 0)) return false;
    }
    if (value.contains("loopScopes")) {
        if (!value.at("loopScopes").is_array()) return false;
        for (const auto& frame : value.at("loopScopes")) {
            if (!frame.is_number_unsigned() && (!frame.is_number_integer() || frame.get<int64_t>() < 0)) return false;
            if (frame.get<uint64_t>() >= localCount) return false;
        }
    }
    return true;
}
static std::string utf8Path(const fs::path& path) {
    const auto value = path.u8string();
    return std::string(reinterpret_cast<const char*>(value.data()), value.size());
}
static void replaceSaveFile(const fs::path& temporary, const fs::path& destination) {
    std::error_code error;
    if (!fs::exists(destination,error)) {
        if (error) throw std::runtime_error("保存先を確認できませんでした: " + error.message());
        fs::rename(temporary,destination,error);
        if (error) throw std::runtime_error("Save file の作成に失敗しました: " + error.message());
        return;
    }
#ifdef _WIN32
    if (!ReplaceFileW(destination.c_str(),temporary.c_str(),nullptr,REPLACEFILE_IGNORE_MERGE_ERRORS,nullptr,nullptr))
        throw std::runtime_error("Save file を安全に置き換えられませんでした: " + std::to_string(GetLastError()));
#else
    fs::rename(temporary,destination,error);
    if (error) throw std::runtime_error("Save file を置き換えられませんでした: " + error.message());
#endif
}
static fs::path saveDirectoryFor(const fs::path& packagePath, const json& package) {
    std::optional<fs::path> overridePath;
#ifdef _WIN32
    SetLastError(ERROR_SUCCESS);
    const DWORD required = GetEnvironmentVariableW(L"NOVEL_SAVE_ROOT", nullptr, 0);
    if (required > 0) {
        std::wstring value(required, L'\0');
        const DWORD length = GetEnvironmentVariableW(L"NOVEL_SAVE_ROOT", value.data(), required);
        if (length == 0 || length >= required) throw std::runtime_error("NOVEL_SAVE_ROOT ???????????");
        value.resize(length);
        overridePath = fs::path(value);
    } else if (GetLastError() != ERROR_ENVVAR_NOT_FOUND) {
        throw std::runtime_error("NOVEL_SAVE_ROOT ????????????");
    }
#else
    if (const auto* value = std::getenv("NOVEL_SAVE_ROOT")) overridePath = fs::u8path(value);
#endif
    if (overridePath) {
        if (!overridePath->is_absolute()) throw std::runtime_error("NOVEL_SAVE_ROOT ?? absolute path ?????????");
        return *overridePath;
    }
    if (SDL_GetCurrentVideoDriver() && std::string(SDL_GetCurrentVideoDriver()) == "dummy")
        return packagePath.parent_path() / "saves";
    auto id = package.value("native_ui",json::object()).value("save_id",std::string{});
    if (id.empty()) {
        uint64_t hash = 14695981039346656037ull;
        for (const auto byte : utf8Path(fs::absolute(packagePath).parent_path())) { hash ^= static_cast<unsigned char>(byte); hash *= 1099511628211ull; }
        std::ostringstream name; name << "project-" << std::hex << hash; id = name.str();
    }
    if (id.size() > 64 || id.empty() || id.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") != std::string::npos) throw std::runtime_error("Save ID が正しくありません");
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
    for (int index = 1; index <= 120; ++index) {
        for (const auto& name : {"slot-" + std::to_string(index) + ".json", "thumb-slot-" + std::to_string(index) + ".png"}) {
            const auto source = legacy / name, destination = saveDirectory / name;
            if (fs::is_regular_file(source,error)) {
                error.clear(); fs::copy_file(source,destination,fs::copy_options::skip_existing,error);
                if (error) throw std::runtime_error("Save file を移行できませんでした: " + error.message());
            }
            error.clear();
        }
    }
    const auto settings = legacy / "ui-settings.json";
    if (fs::is_regular_file(settings,error)) {
        error.clear(); fs::copy_file(settings,saveDirectory / "ui-settings.json",fs::copy_options::skip_existing,error);
        if (error) throw std::runtime_error("Player settings を移行できませんでした: " + error.message());
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
        std::string voiceCharacter;
        float sourceGain = 1;
    };
    std::vector<AudioPlayback> audio;
    std::unordered_map<SDL_JoystickID, SDL_Gamepad*> gamepads;
    std::mutex stoppedAudioMutex;
    std::vector<MIX_Track*> stoppedAudioTracks;
    std::map<std::string, SDL_Texture*> textures;
    struct AnimatedTexture {
        IMG_Animation* animation = nullptr;
        Uint64 startedAt = 0;
        int currentFrame = -1;
        int repeatCount = -1; // -1 means repeat indefinitely; GIF count is additional repeats after the first play.
        bool finished = false;
    };
    std::map<std::string, AnimatedTexture> animatedTextures;
    uint64_t animatedFrameChanges = 0;
    uint64_t animatedFiniteAnimationsCompleted = 0;
    std::vector<int> animatedGifRepeatCounts;
    int gifRepeatCount(const fs::path& path) const {
        auto extension = path.extension().string();
        std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char c) { return char(std::tolower(c)); });
        if (extension != ".gif") return -1;
        std::ifstream input(path, std::ios::binary);
        if (!input) return 0;
        const std::vector<unsigned char> data((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
        const std::string_view identifier = "NETSCAPE2.0";
        for (size_t i = 0; i + identifier.size() + 5 < data.size(); ++i) {
            if (!std::equal(identifier.begin(), identifier.end(), data.begin() + i)) continue;
            // Application data follows the 11-byte identifier as sub-blocks:
            // size=3, id=1, little-endian repeat count, terminator.
            const size_t block = i + identifier.size();
            for (size_t j = block; j + 4 < data.size() && j < block + 32; ++j) {
                if (data[j] == 3 && data[j + 1] == 1) return int(data[j + 2]) | (int(data[j + 3]) << 8);
                if (data[j] == 0) break;
            }
            return 0;
        }
        return 0; // GIF without a loop extension plays once.
    }
    struct Sprite {
        SDL_Texture* texture;
        std::string position, asset, pose;
        float alpha = 1, offsetX = 0, offsetY = 0;
        uint64_t visualOrder = 0;
        std::optional<double> layer;
    };
    std::map<std::string, Sprite> characters, images;
    uint64_t nextVisualOrder = 0;
    SDL_Texture *background = nullptr, *dialog = nullptr, *speakerSkin = nullptr, *choiceSkin = nullptr, *choiceActiveSkin = nullptr;
    SDL_Texture *previousBackground = nullptr;
    float previousBackgroundOffsetX = 0, previousBackgroundOffsetY = 0;
    float backgroundTransitionProgress = 1.0f;
    std::string backgroundTransitionType;
    SDL_Surface* lastStoryFrame = nullptr;
    std::string backgroundAsset, bgmAsset, videoAsset;
    std::string lastVoiceAsset;
    std::string lastVoiceCharacter;
    float backgroundOffsetX = 0, backgroundOffsetY = 0;
    uint64_t logicalTimeMs = 0;
    bool captureAnimationMidpoints = false;
    json animationMidpoints = json::array();
    std::vector<std::string> lastRenderedCategories;
    struct ParallelTrack { int64_t duration; std::function<void(float)> update; bool midpointCaptured = false; float previousProgress = 0.0f; };
    std::unique_ptr<Video> video;
    std::map<std::string, std::string> config;
    std::map<std::string, double> renderLayers{{"background",0},{"video",1},{"character",2},{"image",3},{"fog",4},{"dialogue",5},{"controls",6},{"menu",7}};
    std::optional<double> backgroundLayer, videoLayer;
    std::map<std::string, float> audioVolumeOverrides;
    json uiSettingValues = json::object();
    json uiSettingsBeforeReset = nullptr;
    json uiSettingsPersistedBeforeReset = nullptr;
    fs::path uiSettingsPath;
    fs::path baseFontPath;
    fs::path activeFontPath;
    int baseFontSize = 24;
    int baseWindowWidth = 960, baseWindowHeight = 680;
    std::string draggedUiSetting;
    static const std::vector<std::string>& legacyShortcutActions() {
        static const std::vector<std::string> actions{"none","system","save","load","replay-voice","auto","clear-text","fullscreen","skip","quick-save","history","quick-load"};
        return actions;
    }
    const std::vector<std::string>& shortcutActions() const {
        return configuredShortcutActions.empty() ? legacyShortcutActions() : configuredShortcutActions;
    }
    std::string shortcutActionLabel(const std::string& action) const {
        const auto configured = configuredShortcutActionLabels.find(action);
        if (configured != configuredShortcutActionLabels.end()) return configured->second;
        static const std::map<std::string,std::string> labels{{"none","Disabled"},{"system","System"},{"save","Save"},{"load","Load"},{"replay-voice","Replay Last Voice"},{"auto","Auto Play"},{"clear-text","Clear Text"},{"fullscreen","Toggle Fullscreen"},{"skip","Skip"},{"quick-save","Quick Save"},{"history","Text History"},{"quick-load","Quick Load"}};
        const auto found=labels.find(action); return found==labels.end()?action:found->second;
    }
    std::string screenFocusedSetting;
    std::string screenFocusedNodeKey;
    json gameScreens = json::object();
    std::vector<std::string> configuredShortcutActions;
    std::map<std::string, std::string> configuredShortcutActionLabels;
    bool hasControlSchema = false;
    json playerControls = json::object();
    json queuedLoad = nullptr;
    std::string screenMusicAsset;
    fs::path saveDirectory;
    struct CachedSlot { fs::file_time_type modified; json value; std::string state; };
    mutable std::unordered_map<int, CachedSlot> slotCache;
    std::string activeScreen;
    std::vector<std::string> screenHistory;
    mutable std::map<std::string, int> slotPages;
    int selectedSlotIndex = -1;
    int deleteArmedSlotIndex = -1;
    int screenHover = -1;
    int screenFocusedItem = 0;
    bool screenKeyboardFocus = true;
    float screenPointerX = -1.0f, screenPointerY = -1.0f;
    fs::path captureNextScreenFrame;
    int controlHover = -1;
    bool titleStarted = false;
    bool storyActive = false;
    bool videoBlocksStory = false;
    std::string visualOnlyKind, visualOnlyId;
    float videoOpacity = 1.0f;
    bool dialogueVisible = true;
    float cameraZoom = 1.0f, cameraFocusX = 640.0f, cameraFocusY = 360.0f;
    std::string speaker, text;
    std::string saveNotice;
    Uint64 saveNoticeUntil = 0;
    fs::path captureSaveNoticeFrame;
    std::vector<std::pair<std::string, std::string>> dialogueHistory;
    int dialogueHistoryScroll = 0;
    std::vector<std::string> options;
    int selection = -1;
    int hovered = -1;
    float choiceScroll = 0.0f;
    bool next = false;
    bool automated = false;
    bool autoPlayActive = false;
    bool skipActive = false;
    bool holdActive = false;
    bool cursorHidden = false;
    Uint64 lastMouseActivity = 0;
    std::set<std::string> seenSayLines;
    int width = 960, height = 680;
    std::vector<SDL_Texture*> screenOpacityTargets;
    std::vector<std::pair<int,int>> screenOpacityTargetSizes;
    float overlay = 0;
    float dialogueOpacityOverride = -1.0f;
    SDL_Color overlayColor{0,0,0,255};
    fs::path root;
    novel::Runtime& runtime;
    int number(const std::string& key, int fallback) { return config.contains(key) ? std::stoi(config[key]) : fallback; }
    double renderLayer(const std::string& category, std::optional<double> overrideValue = std::nullopt) const {
        const auto found = renderLayers.find(category);
        return overrideValue.value_or(found == renderLayers.end() ? 0.0 : found->second);
    }
    static double checkedRenderLayer(const json& value) {
        if (!value.is_number()) throw std::runtime_error("layer value\u306fnumber\u3067\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044");
        const double layer = value.get<double>();
        if (!std::isfinite(layer) || layer < 0 || layer >= 8 || std::abs(layer * 1000.0 - std::round(layer * 1000.0)) > 1e-7)
            throw std::runtime_error("layer value\u306f0\u301c7.999\u306e\u7bc4\u56f2\u30670.001\u523b\u307f\u3067\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044");
        return layer;
    }
    static std::optional<double> commandLayer(const json& args) {
        for (size_t index = 0; index < args.size(); ++index) {
            if (args.at(index).is_string() && args.at(index).get<std::string>() == "--layer") {
                if (index + 1 >= args.size()) throw std::runtime_error("--layer\u306e\u5f8c\u306bnumber\u3092\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044");
                return checkedRenderLayer(args.at(index + 1));
            }
        }
        return std::nullopt;
    }
    SDL_Color color(const std::string& key, SDL_Color fallback) {
        if (!config.contains(key)) return fallback;
        std::istringstream in(config[key]); int r,g,b,a; char c;
        if (!(in >> r >> c >> g >> c >> b >> c >> a) || std::min({r,g,b,a}) < 0 || std::max({r,g,b,a}) > 255) throw std::runtime_error("color value\u304c\u4e0d\u6b63\u3067\u3059: " + key);
        return {Uint8(r),Uint8(g),Uint8(b),Uint8(a)};
    }
    SDL_Texture* image(const fs::path& path) {
        auto key = utf8Path(path); if (textures.contains(key)) return textures[key];
        SDL_Texture* t = nullptr;
        auto extension = path.extension().string();
        std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char c) { return char(std::tolower(c)); });
        if (extension == ".png" || extension == ".gif" || extension == ".webp") {
            if (auto* animation = IMG_LoadAnimation(key.c_str())) {
                if (animation->count > 1) {
                    t = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STREAMING, animation->w, animation->h);
                    if (!t) { IMG_FreeAnimation(animation); throw std::runtime_error("animated image texture\u3092\u4f5c\u6210\u3067\u304d\u307e\u305b\u3093: " + key + ": " + SDL_GetError()); }
                    if (!SDL_SetTextureBlendMode(t, SDL_BLENDMODE_BLEND)) { SDL_DestroyTexture(t); IMG_FreeAnimation(animation); throw std::runtime_error("animated image\u306ealpha blend mode\u3092\u6709\u52b9\u306b\u3067\u304d\u307e\u305b\u3093: " + key + ": " + SDL_GetError()); }
                    textures[key] = t;
                    const int repeats = gifRepeatCount(path);
                    if (path.extension() == ".gif" && repeats >= 0) animatedGifRepeatCounts.push_back(repeats);
                    animatedTextures.emplace(key, AnimatedTexture{animation, SDL_GetTicks(), -1, repeats, false});
                    return t;
                }
                if (animation->count == 1 && animation->frames && animation->frames[0]) {
                    auto* rgba = SDL_ConvertSurface(animation->frames[0], SDL_PIXELFORMAT_RGBA32);
                    IMG_FreeAnimation(animation);
                    if (!rgba) throw std::runtime_error("image\u3092pixel format\u306b\u5909\u63db\u3067\u304d\u307e\u305b\u3093: " + key + ": " + SDL_GetError());
                    t = SDL_CreateTextureFromSurface(renderer, rgba);
                    SDL_DestroySurface(rgba);
                    if (!t) throw std::runtime_error("image texture\u3092\u4f5c\u6210\u3067\u304d\u307e\u305b\u3093: " + key + ": " + SDL_GetError());
                    if (!SDL_SetTextureBlendMode(t, SDL_BLENDMODE_BLEND)) { SDL_DestroyTexture(t); throw std::runtime_error("image\u306ealpha blend mode\u3092\u6709\u52b9\u306b\u3067\u304d\u307e\u305b\u3093: " + key + ": " + SDL_GetError()); }
                    textures[key] = t;
                    return t;
                }
                IMG_FreeAnimation(animation);
            }
        }
        if (auto* surface = IMG_Load(key.c_str())) {
            // Keep the source alpha channel explicit so transparent character
            // poses remain transparent on every renderer and image format.
            auto* rgba = SDL_ConvertSurface(surface, SDL_PIXELFORMAT_RGBA32);
            SDL_DestroySurface(surface);
            if (!rgba) throw std::runtime_error("image\u3092pixel format\u306b\u5909\u63db\u3067\u304d\u307e\u305b\u3093: " + key + ": " + SDL_GetError());
            t = SDL_CreateTextureFromSurface(renderer, rgba);
            SDL_DestroySurface(rgba);
        }
        if (!t) { Video decoded(renderer, key); decoded.update(); t = decoded.releaseTexture(); }
        if (!t) throw std::runtime_error("image\u3092\u8aad\u307f\u8fbc\u3081\u307e\u305b\u3093: " + key + ": " + SDL_GetError());
        SDL_SetTextureBlendMode(t, SDL_BLENDMODE_BLEND); textures[key] = t; return t;
    }
    void updateAnimatedTextures() {
        const Uint64 now = SDL_GetTicks();
        for (auto& [key, animated] : animatedTextures) {
            const auto* animation = animated.animation;
            Uint64 totalDelay = 0;
            for (int i = 0; i < animation->count; ++i) totalDelay += Uint64(std::max(1, animation->delays[i]));
            if (totalDelay <= 0) continue;
            const Uint64 elapsed = now - animated.startedAt;
            if (animated.repeatCount >= 0) {
                const Uint64 totalDuration = totalDelay * (Uint64(animated.repeatCount) + 1);
                if (elapsed >= totalDuration && !animated.finished) {
                    animated.finished = true;
                    ++animatedFiniteAnimationsCompleted;
                }
            }
            Uint64 frameTime = animated.finished ? totalDelay - 1 : elapsed % totalDelay;
            int frameIndex = 0;
            while (frameIndex + 1 < animation->count && frameTime >= std::max(1, animation->delays[frameIndex])) {
                frameTime -= std::max(1, animation->delays[frameIndex]);
                ++frameIndex;
            }
            if (frameIndex == animated.currentFrame) continue;
            auto* rgba = SDL_ConvertSurface(animation->frames[frameIndex], SDL_PIXELFORMAT_RGBA32);
            if (!rgba) throw std::runtime_error("animated image\u3092pixel format\u306b\u5909\u63db\u3067\u304d\u307e\u305b\u3093: " + key + ": " + SDL_GetError());
            const bool updated = SDL_UpdateTexture(textures.at(key), nullptr, rgba->pixels, rgba->pitch);
            SDL_DestroySurface(rgba);
            if (!updated) throw std::runtime_error("animated image\u3092\u66f4\u65b0\u3067\u304d\u307e\u305b\u3093: " + key + ": " + SDL_GetError());
            if (animated.currentFrame >= 0) ++animatedFrameChanges;
            animated.currentFrame = frameIndex;
        }
    }
    std::string resolveAssetId(const std::string& type, const std::string& id) const {
        const auto normalized = [](std::string value) {
            std::replace(value.begin(),value.end(),char(92),'/');
            if(value.starts_with("asset/")) value.erase(0,6);
            std::transform(value.begin(),value.end(),value.begin(),[](unsigned char c){return char(std::tolower(c));});
            return value;
        };
        std::string match;
        for(const auto& a:runtime.program.at("assets")) if(a.at("type")==type) {
            const auto path=a.at("path").get<std::string>(), leaf=fs::u8path(path).filename().generic_string();
            if(a.at("name")==id || normalized(path)==normalized(id) || normalized(leaf)==normalized(id)) {
                if(!match.empty() && match!=a.at("name").get<std::string>()) throw std::runtime_error("\u540c\u3058file name\u306easset\u304c\u8907\u6570\u3042\u308a\u307e\u3059: "+id);
                match=a.at("name").get<std::string>();
            }
        }
        if(match.empty()) throw std::runtime_error("asset \u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093: "+id);
        return match;
    }
    fs::path asset(const std::string& type, const std::string& id, const std::string& pose = "") {
        std::string relative;
        if (type == "char") {
            for (const auto& c : runtime.program.at("characters")) if (c.at("name") == id) for (const auto& p : c.at("poses")) if (p.at("name") == pose) relative = p.at("path");
        } else { const auto resolvedId=resolveAssetId(type,id); for(const auto& a:runtime.program.at("assets")) if(a.at("type")==type && a.at("name")==resolvedId) { relative=a.at("path"); break; } }
        std::replace(relative.begin(), relative.end(), '\\', '/');
        if (relative.starts_with("asset/")) relative.erase(0, 6);
        if (relative.empty()) throw std::runtime_error("asset \u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093: " + id);
        auto base = fs::weakly_canonical(root / "asset"), resolved = fs::canonical(base / fs::u8path(relative));
        auto rel = resolved.lexically_relative(base);
        if (rel.empty() || rel.is_absolute() || *rel.begin() == "..") throw std::runtime_error("asset path\u304cpackage\u5916\u3067\u3059");
        return resolved;
    }
    float poseYOffset(const std::string& id, const std::string& pose) const {
        for (const auto& character : runtime.program.at("characters")) {
            if (character.at("name") != id) continue;
            for (const auto& definition : character.at("poses")) {
                if (definition.at("name") == pose) return definition.value("yOffset", 0.0f);
            }
        }
        return 0.0f;
    }
    static bool hasParentPathComponent(const fs::path& value) {
        return std::any_of(value.begin(), value.end(), [](const fs::path& component) { return component == ".."; });
    }
    SDL_Texture* skinImage(const std::string& relative) {
        const fs::path imagePath = fs::u8path(relative);
        if (relative.empty() || imagePath.is_absolute() || hasParentPathComponent(imagePath)) return nullptr;
        return image(root / "asset" / fs::u8path(relative));
    }
    json readUiTheme(const json& nativeUi) {
        if (!nativeUi.contains("native_ui_theme")) return json::object();
        const auto themeFile = nativeUi.at("native_ui_theme").get<std::string>();
        const fs::path themePath = fs::u8path(themeFile);
        if (themeFile.empty() || themePath.is_absolute() || hasParentPathComponent(themePath)) throw std::runtime_error("Native UI theme\u306epath\u304c\u4e0d\u6b63\u3067\u3059");
        std::ifstream file(root / "asset" / fs::u8path(themeFile));
        if (!file) throw std::runtime_error("Native UI theme\u3092\u958b\u3051\u307e\u305b\u3093: " + themeFile);
        json theme; file >> theme;
        if (theme.value("version", 0) != 1) throw std::runtime_error("\u672a\u5bfe\u5fdc\u306eNative UI theme version\u3067\u3059");
        return theme;
    }
    json readGameScreens(const json& nativeUi) {
        if (!nativeUi.contains("game_screens")) return json::object();
        const auto relative = nativeUi.at("game_screens").get<std::string>();
        const fs::path screenPath = fs::u8path(relative);
        if (relative.empty() || screenPath.is_absolute() || hasParentPathComponent(screenPath)) throw std::runtime_error("game screen configuration\u306epath\u304c\u4e0d\u6b63\u3067\u3059");
        std::ifstream file(root / "asset" / fs::u8path(relative));
        if (!file) throw std::runtime_error("game screen configuration\u3092\u958b\u3051\u307e\u305b\u3093: " + relative);
        json value; file >> value;
        if (value.value("version", 0) != 1 || !value.contains("canvas") || !value.contains("screens") || !value.contains("initial") || !value["screens"].contains(value["initial"].get<std::string>())) throw std::runtime_error("game screen configuration\u304c\u4e0d\u6b63\u3067\u3059");
        const auto scaleMode = value.value("scaleMode", std::string("contain"));
        if (scaleMode != "contain" && scaleMode != "cover" && scaleMode != "stretch") throw std::runtime_error("game screen\u306escaleMode\u304c\u4e0d\u6b63\u3067\u3059");
        return value;
    }
    void applyUiTheme(const json& nativeUi, const json& theme, bool loadImages) {
        if (theme.empty()) return;
        if (theme.contains("layers")) {
            if (!theme.at("layers").is_object()) throw std::runtime_error("render layer configuration\u304c\u4e0d\u6b63\u3067\u3059");
            for (const auto& [category, value] : theme.at("layers").items()) {
                if (!renderLayers.contains(category)) throw std::runtime_error("\u672a\u5bfe\u5fdc\u306elayer category\u3067\u3059: " + category);
                renderLayers[category] = checkedRenderLayer(value);
            }
        }
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
                    if (!color.is_array() || color.size() != 4) throw std::runtime_error("Native UI fog color\u306b\u306f4\u3064\u306e\u5024\u304c\u5fc5\u8981\u3067\u3059");
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
            const auto& c = object.at(key); for (const auto& value : c) if (!value.is_number_integer() || value.get<int>() < 0 || value.get<int>() > 255) throw std::runtime_error("Native UI color value\u306f0\u301c255\u306einteger\u3067\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044");
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
                if (!std::isfinite(opacity) || opacity < 0 || opacity > 1) throw std::runtime_error("dialog opacity\u306f0\u301c1\u306e\u7bc4\u56f2\u3067\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044");
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
            if (!std::isfinite(volume) || volume < 0 || volume > 1) throw std::runtime_error("audio volume\u306f0\u301c1\u306e\u7bc4\u56f2\u3067\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044");
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
        if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_GAMEPAD) || !TTF_Init() || !MIX_Init()) throw std::runtime_error(SDL_GetError());
        int gamepadCount = 0;
        if (SDL_JoystickID* gamepadIds = SDL_GetGamepads(&gamepadCount)) {
            for (int index = 0; index < gamepadCount; ++index) if (SDL_Gamepad* gamepad = SDL_OpenGamepad(gamepadIds[index])) gamepads.emplace(gamepadIds[index], gamepad);
            SDL_free(gamepadIds);
        }
        fs::path data = fs::u8path(SDL_GetBasePath()) / "engine_data";
        std::ifstream file(data / "engine.txt"); std::string line;
        while (std::getline(file, line)) {
            auto equals = line.find('='); if (equals == std::string::npos || line.starts_with('#')) continue;
            auto trim = [](std::string s) { auto a = s.find_first_not_of(" \t\r"); auto b = s.find_last_not_of(" \t\r"); return a == std::string::npos ? std::string() : s.substr(a,b-a+1); };
            config[trim(line.substr(0,equals))] = trim(line.substr(equals+1));
        }
        const auto nativeUi = packageData.value("native_ui", json::object());
        gameScreens = readGameScreens(nativeUi);
        const auto controlSchema = gameScreens.value("controlSchema", json::object());
        hasControlSchema = controlSchema.contains("settings") && controlSchema.at("settings").is_object();
        if (controlSchema.value("shortcutActions", json::array()).is_array()) {
            for (const auto& action : controlSchema.value("shortcutActions", json::array())) if (action.is_string()) configuredShortcutActions.push_back(action.get<std::string>());
        }
        if (controlSchema.value("shortcutActionLabels", json::object()).is_object()) {
            for (const auto& [action, label] : controlSchema.value("shortcutActionLabels", json::object()).items()) if (label.is_string()) configuredShortcutActionLabels[action] = label.get<std::string>();
        }
        const auto theme = readUiTheme(nativeUi);
        playerControls = theme.value("controls", json::object());
        if (playerControls.empty()) playerControls = {{"enabled", true}, {"anchor", "dialogue-top-left"}, {"buttons", json::array({
            {{"id", "save"}, {"action", "save"}, {"label", "Save"}, {"x", 0}, {"y", -44}, {"width", 84}, {"height", 36}},
            {{"id", "load"}, {"action", "load"}, {"label", "Load"}, {"x", 92}, {"y", -44}, {"width", 84}, {"height", 36}},
        })}};
        applyUiTheme(nativeUi, theme, false);
        width = number("window.width",960); height = number("window.height",680);
        baseWindowWidth = width; baseWindowHeight = height;
        window = SDL_CreateWindow(config.contains("window.title") ? config["window.title"].c_str() : "Novel Script",width,height,0);
        renderer = SDL_CreateRenderer(window,nullptr);
        if (!window || !renderer) throw std::runtime_error(SDL_GetError());
        SDL_SetRenderDrawBlendMode(renderer, SDL_BLENDMODE_BLEND);
        fs::path fontPath = fs::u8path(config.contains("font.path") ? config["font.path"] : "C:/Windows/Fonts/meiryo.ttc");
        if (fontPath.is_relative()) fontPath = data / fontPath;
        baseFontPath = fontPath; activeFontPath = fontPath; baseFontSize = number("font.size",24);
        font = TTF_OpenFont(utf8Path(baseFontPath).c_str(), baseFontSize);
        if (!font) throw std::runtime_error(SDL_GetError());
        applyUiTheme(nativeUi, theme, true);
        if (gameScreens.contains("screens")) for (const auto& [id, screen] : gameScreens.at("screens").items()) {
            const auto backgroundName = screenBackground(screen);
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
        uiSettingValues = json::object();
        const auto declaredUiSettings = gameScreens.value("controlDefaults", json::object());
        if (hasControlSchema) {
            for (const auto& [key, rule] : controlSchema.at("settings").items()) {
                const auto candidate = declaredUiSettings.find(key);
                if (candidate != declaredUiSettings.end() && matchesControlSettingRule(rule, *candidate)) uiSettingValues[key] = *candidate;
            }
        } else {
            const std::map<std::string, json> legacyDefaults = {
                {"audio.master", 1.0}, {"audio.bgm", 1.0}, {"audio.se", 1.0}, {"audio.voice", 0.5},
                {"audio.bgmMuted", false}, {"audio.seMuted", false}, {"audio.voiceMuted", false}, {"ui.dialogOpacity", 1.0},
                {"ui.skipUnseen", false}, {"ui.autoAfterChoice", true}, {"ui.skipAfterChoice", true}, {"ui.autoSpeed", 0.45},
                {"ui.textSpeed", 1.0}, {"ui.fullscreen", false}, {"ui.effects", true}, {"ui.cursorHideDelay", 1.0},
                {"ui.fontFamily", "default"},
            };
            for (const auto& [key, fallback] : legacyDefaults) {
                const auto candidate = declaredUiSettings.find(key);
                uiSettingValues[key] = candidate != declaredUiSettings.end() && isLegacyControlValueValid(key, *candidate, fallback) ? *candidate : fallback;
            }
            for (const auto& [key, candidate] : declaredUiSettings.items()) {
                const bool isShortcut = std::regex_match(key,std::regex(R"(ui\.shortcut\.F(?:[1-9]|1[0-2]))"));
                if (isShortcut && candidate.is_string() && std::find(shortcutActions().begin(),shortcutActions().end(),candidate.get<std::string>())!=shortcutActions().end()) uiSettingValues[key]=candidate;
                if (!std::regex_match(key, std::regex(R"(audio\.voice\.[A-Za-z_][A-Za-z0-9_]*(\.muted)?)"))) continue;
                if (key.ends_with(".muted")) { if (candidate.is_boolean()) uiSettingValues[key] = candidate; continue; }
                if (candidate.is_number() && std::isfinite(candidate.get<double>()) && candidate.get<double>() >= 0 && candidate.get<double>() <= 1) uiSettingValues[key] = candidate;
            }
        }
        try {
            std::ifstream preferences(uiSettingsPath);
            if (preferences) {
                json saved; preferences >> saved;
                if (saved.is_object()) {
                    for (const auto& [key, fallback] : uiSettingValues.items()) {
                        if (saved.contains(key) && isValidUiSettingValue(key, saved.at(key))) uiSettingValues[key] = saved.at(key);
                    }
                }
            }
        } catch (...) { /* Invalid preference files fall back to safe defaults. */ }
        applyUiFontFamily(uiSettingValues.value("ui.fontFamily", std::string("default")));
        lastMouseActivity = SDL_GetTicks();
        if (uiSettingValues.value("ui.fullscreen",false)) SDL_SetWindowFullscreen(window,true);
        applyUiAudioSettings();
    }
    ~Engine() {
        for (const auto& [id, gamepad] : gamepads) SDL_CloseGamepad(gamepad);
        gamepads.clear();
        video.reset();
        for (auto& [key, animated] : animatedTextures) if (animated.animation) IMG_FreeAnimation(animated.animation);
        animatedTextures.clear();
        for (const auto& playback : audio) {
            MIX_SetTrackStoppedCallback(playback.track, nullptr, nullptr);
            MIX_StopTrack(playback.track, 0);
            MIX_DestroyTrack(playback.track);
            MIX_DestroyAudio(playback.audio);
        }
        audio.clear();
        for (auto* target : screenOpacityTargets) if (target) SDL_DestroyTexture(target);
        screenOpacityTargets.clear(); screenOpacityTargetSizes.clear();
        if (lastStoryFrame) SDL_DestroySurface(lastStoryFrame);
        if (mixer) MIX_DestroyMixer(mixer);
        for (auto [key,t] : textures) SDL_DestroyTexture(t);
        if (font) TTF_CloseFont(font);
        if (renderer) SDL_DestroyRenderer(renderer);
        if (window) SDL_DestroyWindow(window);
        MIX_Quit(); TTF_Quit(); SDL_Quit();
    }
    void label(const std::string& s, float x, float y, int size, SDL_Color col, float maxWidth = 0, float maxHeight = 0, int lineSkip = -1) {
        if (s.empty()) return;
        TTF_SetFontSize(font,size);
        const int defaultLineSkip = TTF_GetFontLineSkip(font);
        if (lineSkip >= 0) TTF_SetFontLineSkip(font,lineSkip);
        const float wrapWidth = std::max(1.0f,maxWidth > 0 ? maxWidth : float(width)-x-30);
        SDL_Rect clip{int(std::floor(x)), int(std::floor(y)), int(std::ceil(wrapWidth)), int(std::ceil(maxHeight))};
        if (maxHeight > 0) SDL_SetRenderClipRect(renderer, &clip);
        const int advance = lineSkip >= 0 ? lineSkip : defaultLineSkip;
        size_t start = 0;
        do {
            const size_t end = s.find('\n',start);
            const std::string line = s.substr(start,end == std::string::npos ? std::string::npos : end-start);
            if (!line.empty()) {
                auto* surface = TTF_RenderText_Blended_Wrapped(font,line.c_str(),line.size(),col,Uint32(wrapWidth));
                if (!surface) {
                    if (maxHeight > 0) SDL_SetRenderClipRect(renderer, nullptr);
                    if (lineSkip >= 0) TTF_SetFontLineSkip(font,defaultLineSkip);
                    throw std::runtime_error(SDL_GetError());
                }
                auto* texture = SDL_CreateTextureFromSurface(renderer,surface);
                SDL_FRect rect{x,y,float(surface->w),float(surface->h)};
                SDL_RenderTexture(renderer,texture,nullptr,&rect); SDL_DestroyTexture(texture); SDL_DestroySurface(surface);
            }
            y += float(advance);
            if (end == std::string::npos) break;
            start = end + 1;
        } while (start <= s.size());
        if (maxHeight > 0) SDL_SetRenderClipRect(renderer, nullptr);
        if (lineSkip >= 0) TTF_SetFontLineSkip(font,defaultLineSkip);
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
        float center = slot == std::string("far_left") ? 0.08f : slot == std::string("left") ? 0.26f : slot == std::string("right") ? 0.74f : slot == std::string("far_right") ? 0.92f : 0.50f;
        if (slot == std::string("far_left")) center = std::max(center, w / (2.0f * float(width)));
        else if (slot == std::string("far_right")) center = std::min(center, 1.0f - w / (2.0f * float(width)));
        const float centerX = float(width) * center;
        const float scaleX = float(width) / float(number("screen.width", 1280));
        const float scaleY = float(height) / float(number("screen.height", 720));
        float x = centerX - w / 2.0f + s.offsetX * scaleX;
        SDL_FRect rect{x,height-h + s.offsetY * scaleY,w,h};
        const float focusX=cameraFocusX*scaleX, focusY=cameraFocusY*scaleY;
        rect.x=focusX+(rect.x-focusX)*cameraZoom; rect.y=focusY+(rect.y-focusY)*cameraZoom; rect.w*=cameraZoom; rect.h*=cameraZoom;
        SDL_SetTextureAlphaModFloat(s.texture,s.alpha);
        SDL_RenderTexture(renderer,s.texture,nullptr,&rect); SDL_SetTextureAlphaModFloat(s.texture,1);
    }
    void renderBackground() {
        if (!background) return;
        const float scaleX = float(width) / float(number("screen.width", 1280));
        const float scaleY = float(height) / float(number("screen.height", 720));
        const float focusX=cameraFocusX*scaleX, focusY=cameraFocusY*scaleY;
        auto backgroundRect = [&](SDL_Texture* texture, float offsetX, float offsetY) {
            float sourceWidth = 0, sourceHeight = 0;
            SDL_GetTextureSize(texture, &sourceWidth, &sourceHeight);
            const auto cover = native_player::cameraSafeBackgroundCoverRect(
                sourceWidth, sourceHeight, float(width), float(height),
                offsetX * scaleX, offsetY * scaleY, cameraZoom, focusX, focusY);
            SDL_FRect rect{cover.x, cover.y, cover.width, cover.height};
            rect.x=focusX+(rect.x-focusX)*cameraZoom; rect.y=focusY+(rect.y-focusY)*cameraZoom;
            rect.w*=cameraZoom; rect.h*=cameraZoom;
            return rect;
        };
        const auto incomingRect = backgroundRect(background, backgroundOffsetX, backgroundOffsetY);
        if (backgroundTransitionProgress < 1.0f) {
            if (previousBackground) {
                const auto previousRect = backgroundRect(previousBackground, previousBackgroundOffsetX, previousBackgroundOffsetY);
                SDL_RenderTexture(renderer, previousBackground, nullptr, &previousRect);
            }
            const auto progress=std::clamp(backgroundTransitionProgress,0.0f,1.0f);
            if(backgroundTransitionType=="fade" || backgroundTransitionType=="crossfade") {
                SDL_SetTextureAlphaModFloat(background,progress); SDL_RenderTexture(renderer,background,nullptr,&incomingRect); SDL_SetTextureAlphaModFloat(background,1.0f);
            } else {
                SDL_Rect clip{0,0,width,height};
                if(backgroundTransitionType=="wipe-left") clip.w=int(width*progress);
                else if(backgroundTransitionType=="wipe-right") {clip.w=int(width*progress);clip.x=width-clip.w;}
                else if(backgroundTransitionType=="wipe-up") clip.h=int(height*progress);
                else if(backgroundTransitionType=="wipe-down") {clip.h=int(height*progress);clip.y=height-clip.h;}
                SDL_SetRenderClipRect(renderer,&clip); SDL_RenderTexture(renderer,background,nullptr,&incomingRect); SDL_SetRenderClipRect(renderer,nullptr);
            }
        } else SDL_RenderTexture(renderer, background, nullptr, &incomingRect);
    }
    float uiSettingGain(const std::string& channel) const {
        const auto volumeKey = "audio." + channel;
        const auto muteKey = volumeKey + "Muted";
        if (uiSettingValues.value(muteKey, false)) return 0.0f;
        return uiSettingValues.value(volumeKey, channel == "voice" ? 0.5f : 1.0f);
    }
    float voiceCharacterGain(const std::string& characterId) const {
        if (characterId.empty()) return 1.0f;
        if (uiSettingValues.value("audio.voice." + characterId + ".muted",false)) return 0.0f;
        return uiSettingValues.value("audio.voice." + characterId,1.0f);
    }
    void applyUiAudioSettings() {
        if (!mixer) return;
        const float master = uiSettingValues.value("audio.master", 1.0f);
        if (!MIX_SetMixerGain(mixer, master)) throw std::runtime_error(SDL_GetError());
        for (const auto& playback : audio) {
            if (!MIX_TrackPlaying(playback.track)) continue;
            const auto channel = playback.type == "bgm" ? std::string("bgm") : playback.type == "voice" ? std::string("voice") : std::string("se");
            const float sourceGain = playback.bgm ? currentBgmGain(playback) : playback.sourceGain;
            const float characterGain = playback.type == "voice" ? voiceCharacterGain(playback.voiceCharacter) : 1.0f;
            if (!MIX_SetTrackGain(playback.track, sourceGain * uiSettingGain(channel) * characterGain)) throw std::runtime_error(SDL_GetError());
        }
    }
    void saveUiSettings() {
        auto temporary = uiSettingsPath; temporary += ".tmp";
        { std::ofstream file(temporary, std::ios::binary | std::ios::trunc); if (!file) throw std::runtime_error("Player settings の保存に失敗しました"); file << uiSettingValues.dump(2); file.flush(); if (!file) throw std::runtime_error("Player settings の保存に失敗しました"); }
        replaceSaveFile(temporary,uiSettingsPath);
    }
    bool applyUiFontFamily(const std::string& family) {
        fs::path selected = baseFontPath;
        if (family == "gothic") selected = fs::u8path("C:/Windows/Fonts/YuGothM.ttc");
        else if (family == "mincho") selected = fs::u8path("C:/Windows/Fonts/msmincho.ttc");
        else if (family != "default") return false;
        if (selected != baseFontPath && !fs::exists(selected)) {
            selected = family == "gothic" ? fs::u8path("C:/Windows/Fonts/msgothic.ttc") : selected;
            if (!fs::exists(selected)) return false;
        }
        TTF_Font* replacement = TTF_OpenFont(utf8Path(selected).c_str(),baseFontSize);
        if (!replacement) return false;
        if (font) TTF_CloseFont(font);
        font = replacement;
        activeFontPath = selected;
        return true;
    }
    static bool matchesControlSettingRule(const json& rule, const json& value) {
        if (!rule.is_object() || !rule.contains("type") || !rule.at("type").is_string()) return false;
        const auto type = rule.at("type").get<std::string>();
        if (type == "boolean") return value.is_boolean();
        if (type == "number") {
            if (!value.is_number()) return false;
            const double number = value.get<double>();
            return std::isfinite(number) && number >= rule.value("minimum", 0.0) && number <= rule.value("maximum", 1.0);
        }
        if (type == "enum") {
            if (!value.is_string() || !rule.value("values", json::array()).is_array()) return false;
            const auto values = rule.value("values", json::array());
            return std::find(values.begin(), values.end(), value) != values.end();
        }
        return false;
    }
    static bool isLegacyControlValueValid(const std::string& key, const json& value, const json& fallback) {
        if (fallback.is_boolean()) return value.is_boolean();
        if (fallback.is_number()) return value.is_number() && std::isfinite(value.get<double>()) && value.get<double>() >= 0 && value.get<double>() <= 1;
        if (key == "ui.fontFamily" && value.is_string()) return std::set<std::string>{"default", "gothic", "mincho"}.contains(value.get<std::string>());
        return false;
    }
    bool isValidUiSettingValue(const std::string& key, const json& value) const {
        if (hasControlSchema) {
            const auto& settings = gameScreens.at("controlSchema").at("settings");
            const auto rule = settings.find(key);
            return rule != settings.end() && matchesControlSettingRule(*rule, value);
        }
        if (!uiSettingValues.contains(key)) return false;
        const auto& fallback = uiSettingValues.at(key);
        if (fallback.is_boolean()) return value.is_boolean();
        if (fallback.is_number()) return value.is_number() && std::isfinite(value.get<double>()) && value.get<double>() >= 0 && value.get<double>() <= 1;
        if (!fallback.is_string() || !value.is_string()) return false;
        const auto& text = value.get_ref<const std::string&>();
        if (std::regex_match(key, std::regex(R"(ui\.shortcut\.F(?:[1-9]|1[0-2]))"))) return std::find(shortcutActions().begin(), shortcutActions().end(), text) != shortcutActions().end();
        return isLegacyControlValueValid(key, value, fallback);
    }
    bool updateUiSetting(const std::string& key, const json& value) {
        if (!uiSettingValues.contains(key) || !isValidUiSettingValue(key, value)) return false;
        if (key == "ui.fullscreen" && !SDL_SetWindowFullscreen(window,value.get<bool>())) return false;
        if (key == "ui.fontFamily" && !applyUiFontFamily(value.get<std::string>())) return false;
        if (key == "ui.cursorHideDelay") { lastMouseActivity=SDL_GetTicks(); if (cursorHidden) { SDL_ShowCursor(); cursorHidden=false; } }
        uiSettingValues[key] = value;
        applyUiAudioSettings();
        saveUiSettings();
        return true;
    }
    std::string screenBackground(const json& screen) const {
        return screen.contains("background") ? screen.value("background", std::string{}) : gameScreens.value("defaultBackground", std::string{});
    }
    const json& currentScreen() const { return gameScreens.at("screens").at(activeScreen); }
    fs::path slotPath(int index) const { return saveDirectory / ("slot-" + std::to_string(index + 1) + ".json"); }
    fs::path quickSlotPath() const { return saveDirectory / "quick-slot.json"; }
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
            if (value.is_object()) {
                const bool unsupportedVersion = value.contains("version") && value.at("version").is_number_integer() && value.at("version").get<int64_t>() != 1;
                const bool otherSave = value.contains("saveId") && value.at("saveId").is_string()
                    && !value.at("saveId").get<std::string>().empty()
                    && value.at("saveId").get<std::string>() != gameScreens.value("saveId",std::string{});
                if (unsupportedVersion || otherSave) state = "incompatible";
            }
            if (!value.is_object() || value.value("version", 0) != 1
                || !saveIdCompatible(value,gameScreens.value("saveId",std::string{}))
                || !value.contains("file") || !value.at("file").is_string() || value.at("file").get<std::string>().empty()
                || !value.contains("scene") || !validSavedSceneName(value.at("scene"))
                || !value.contains("line") || !validSavedLine(value.at("line"))
                || !value.contains("variables") || !value.at("variables").is_object() || !validSavedFrames(value)) value = nullptr;
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
    static std::string slotStatusLabel(const std::string& state, bool locked = false) {
        static const std::map<std::string,std::string> labels{{"ready","記録あり"},{"empty","空き"},{"corrupt","破損"},{"incompatible","非対応"}};
        const auto found=labels.find(state);
        return (found==labels.end()?std::string{}:found->second)+(locked?" (Locked)":std::string{});
    }
    static std::string slotText(const json& saved, const char* key, const std::string& fallback = {}) {
        return saved.is_object() && saved.contains(key) && saved.at(key).is_string() ? saved.at(key).get<std::string>() : fallback;
    }
    static int64_t slotTimestamp(const json& saved) {
        return saved.is_object() && saved.contains("savedAt") && saved.at("savedAt").is_number_integer() ? saved.at("savedAt").get<int64_t>() : 0;
    }
    static std::string formatSlotTimestamp(int64_t milliseconds) {
        const auto time = std::time_t(milliseconds / 1000);
        if (const auto* local = std::localtime(&time)) {
            char buffer[32]{};
            if (std::strftime(buffer,sizeof(buffer),"%Y/%m/%d %H:%M",local)) return buffer;
        }
        return {};
    }
    static std::string selectedSlotSummary(int index, const json& saved, bool deleteArmed = false) {
        if (index < 0) return "Select a Save slot";
        std::string summary="Slot "+std::to_string(index+1);
        if(saved.is_object()) summary += "  "+slotText(saved,"scene")+"\n"+slotText(saved,"speaker")+": "+slotText(saved,"text")+"\n"+formatSlotTimestamp(slotTimestamp(saved))+(saved.value("locked",false)?"\nLocked":"");
        else summary += "  Empty slot";
        if(deleteArmed) summary += "\nDelete this slot? Press again to confirm";
        return summary;
    }
    std::optional<int> latestSaveSlotIndex() const {
        int count = 8;
        for (const auto& [id, screen] : gameScreens.at("screens").items()) if (screen.value("role",std::string{}) == "load-slots") {
            count = screen.value("slotLayout",json::object()).value("count",8) * screen.value("slotPages",1); break;
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
            const auto role = currentScreen().value("role", std::string{});
            const auto count = currentScreen().value("slotLayout",json::object()).value("count",12);
            const auto pageKey = role == "save-slots" ? "save" : "load";
            const int offset = (role == "save-slots" || role == "load-slots") ? slotPages[pageKey] * count : 0;
            for (auto& item : items) if (item.contains("slotIndex")) {
                const int index = item.at("slotIndex").get<int>() + offset; item["slotIndex"] = index; const auto& saved = readSlot(index);
                item["slotState"] = slotState(index);
                item["slotSummary"] = saved.is_object() ? json{{"scene",slotText(saved,"scene")},{"speaker",slotText(saved,"speaker")},{"text",slotText(saved,"text")},{"savedAt",slotTimestamp(saved)},{"locked",saved.value("locked",false)}} : json(nullptr);
                item["selected"] = index == selectedSlotIndex;
                item["label"] = saved.is_object()
                    ? "Slot " + std::to_string(index + 1) + "  |  " + slotText(saved,"speaker","Narrator") + ": " + slotText(saved,"text")
                    : "Slot " + std::to_string(index + 1) + "  |  Empty";
                if (item.value("action",std::string{}) == "slot-select" && role == "load-slots" && !saved.is_object()) item["disabled"] = true;
            }
            const bool ready=selectedSlotIndex>=0 && slotState(selectedSlotIndex)=="ready";
            const bool locked=ready && readSlot(selectedSlotIndex).value("locked",false);
            const bool hasFree=ready && firstEmptySlot(selectedSlotIndex)>=0;
            for(auto& item:items){
                const auto action=item.value("action",std::string{});
                if(action=="slot-commit") item["disabled"]=selectedSlotIndex<0 || (role=="save-slots" ? !storyActive || locked : role!="load-slots" || !ready);
                else if(action=="slot-copy") item["disabled"]=!hasFree;
                else if(action=="slot-move") item["disabled"]=!hasFree || locked;
                else if(action=="slot-delete") item["disabled"]=!ready || locked;
                else if(action=="slot-lock") item["disabled"]=!ready;
                if(action=="slot-delete" && deleteArmedSlotIndex==selectedSlotIndex && selectedSlotIndex>=0) item["label"]="Press Again to Delete";
                if(action=="slot-lock" && ready) item["label"]=locked?"Unlock":"Lock";
            }
            return items;
        }
        const auto role = currentScreen().value("role", std::string{});
        if (role != "save-slots" && role != "load-slots") return items;
        const auto layout = currentScreen().value("slotLayout", json{{"x",420},{"y",190},{"width",440},{"height",420},{"rowHeight",42},{"gap",8},{"count",8}});
        const auto style = currentScreen().value("slotStyle", json::object());
        const auto pageKey = role == "save-slots" ? "save" : "load";
        const int offset = slotPages[pageKey] * layout.value("count",8);
        for (int index = 0; index < layout.value("count", 8); ++index) {
            const int slotIndex = offset + index;
            const auto& saved = readSlot(slotIndex);
            std::string label = "Slot " + std::to_string(slotIndex + 1);
            if (saved.is_object()) label += "  |  " + slotText(saved,"speaker","Narrator") + ": " + slotText(saved,"text");
            else label += "  |  Empty";
            const int row = index;
            items.push_back({{"id", "__slot_" + std::to_string(slotIndex)}, {"slotIndex", slotIndex}, {"type", "button"},
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
    int currentSlotOffset() const {
        const auto role = currentScreen().value("role", std::string{});
        if (role != "save-slots" && role != "load-slots") return 0;
        const auto count = currentScreen().value("slotLayout",json::object()).value("count",12);
        const auto key = role == "save-slots" ? "save" : "load";
        const auto page = slotPages.find(key);
        return (page == slotPages.end() ? 0 : page->second) * count;
    }
    int firstEmptySlot(int except = -1) const {
        for (int index=0; index<120; ++index) if (index!=except && slotState(index)=="empty") return index;
        return -1;
    }
    void writeSlotRecord(int index, const json& value) {
        const auto destination=slotPath(index); auto temporary=destination; temporary += ".tmp";
        { std::ofstream file(temporary,std::ios::binary|std::ios::trunc); if(!file) throw std::runtime_error("Save slot のデータを作成できませんでした"); file<<value.dump(2); file.flush(); if(!file) throw std::runtime_error("Save slot のデータを書き込めませんでした"); }
        replaceSaveFile(temporary,destination); slotCache.erase(index);
    }
    void deleteSlotRecord(int index) {
        if (readSlot(index).is_object() && readSlot(index).value("locked",false)) throw std::runtime_error("この Save slot はロックされています");
        std::error_code error; fs::remove(slotPath(index),error); if(error) throw std::runtime_error("Save slot を削除できませんでした: "+error.message());
        error.clear(); fs::remove(saveDirectory/("thumb-slot-"+std::to_string(index+1)+".png"),error);
        slotCache.erase(index);
    }
    void transferSlotRecord(int source, bool move) {
        const json original=readSlot(source); if(!original.is_object()) return;
        if(move && original.value("locked",false)) return;
        const int destination=firstEmptySlot(source); if(destination<0) return;
        const auto destinationPath=slotPath(destination); auto temporary=destinationPath; temporary += ".tmp";
        { std::ofstream file(temporary,std::ios::binary|std::ios::trunc); if(!file) throw std::runtime_error("コピー先の Save slot を作成できませんでした"); file<<original.dump(2); file.flush(); if(!file) throw std::runtime_error("コピー先の Save slot に書き込めませんでした"); }
        replaceSaveFile(temporary,destinationPath);
        const auto sourceThumb=saveDirectory/("thumb-slot-"+std::to_string(source+1)+".png");
        const auto destinationThumb=saveDirectory/("thumb-slot-"+std::to_string(destination+1)+".png");
        std::error_code error;
        if(fs::is_regular_file(sourceThumb,error)){ error.clear(); fs::copy_file(sourceThumb,destinationThumb,fs::copy_options::overwrite_existing,error); if(error) { fs::remove(destinationPath); throw std::runtime_error("save thumbnail\u3092\u30b3\u30d4\u30fc\u3067\u304d\u307e\u305b\u3093: "+error.message()); } }
        slotCache.erase(destination);
        if(move){ fs::remove(slotPath(source),error); if(error) throw std::runtime_error("save\u306f\u30b3\u30d4\u30fc\u3057\u307e\u3057\u305f\u304c original\u3092\u524a\u9664\u3067\u304d\u307e\u305b\u3093: "+error.message()); error.clear(); fs::remove(sourceThumb,error); slotCache.erase(source); selectedSlotIndex=destination; }
        else selectedSlotIndex=destination;
    }
    void resetScreenFocus() { screenHover = -1; screenFocusedItem = -1; screenKeyboardFocus = false; screenFocusedSetting.clear(); screenFocusedNodeKey.clear(); draggedUiSetting.clear(); }
    void openSlotScreen(const std::string& action) {
        const auto id = screenForRole(action == "save" ? "save-slots" : "load-slots");
        if (id.empty()) return;
        slotPages[action] = 0;
        selectedSlotIndex = -1; deleteArmedSlotIndex = -1;
        screenHistory.push_back(activeScreen); activeScreen = id; resetScreenFocus();
    }
    void setSaveNotice(std::string message) {
        saveNotice = std::move(message);
        saveNoticeUntil = SDL_GetTicks() + 3000;
    }
    bool saveSlot(int index) {
        try { runtime.assertSaveBoundary(); } catch (const std::exception& error) { setSaveNotice(error.what()); return false; }
        if (runtime.currentSceneName.empty() || runtime.currentSourceFile.empty() || runtime.currentLine < 1) return false;
        if (readSlot(index).is_object() && readSlot(index).value("locked",false)) return false;
        json readonlyLocals = json::array(); for (const auto& frame : runtime.readonlyLocals) readonlyLocals.push_back(frame);
        json loopScopes = json::array(); for (const auto frame : runtime.loopScopes) loopScopes.push_back(frame);
        const auto savedAt = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        const json state = {{"version", 1}, {"saveId",gameScreens.value("saveId",std::string{})}, {"file", runtime.currentSourceFile}, {"scene", runtime.currentSceneName},
            {"line", runtime.currentLine}, {"variables", runtime.globals}, {"locals", runtime.locals}, {"locked",false},
            {"readonlyLocals", readonlyLocals}, {"loopScopes", loopScopes},
            {"presentation", presentationSnapshot()}, {"speaker", speaker}, {"text", text}, {"savedAt", savedAt}};
        const auto destination = slotPath(index); auto temporary = destination; temporary += ".tmp";
        { std::ofstream file(temporary, std::ios::binary | std::ios::trunc); if (!file) throw std::runtime_error("Save slot を作成できませんでした"); file << state.dump(2); file.flush(); if (!file) throw std::runtime_error("Save slot に書き込めませんでした"); }
        replaceSaveFile(temporary,destination);
        slotCache.erase(index);
        if (lastStoryFrame) {
            const auto preview = saveDirectory / ("thumb-slot-" + std::to_string(index + 1) + ".png");
            auto previewTemporary = preview; previewTemporary += ".tmp";
            if (IMG_SavePNG(lastStoryFrame,utf8Path(previewTemporary).c_str())) {
                try { replaceSaveFile(previewTemporary,preview); }
                catch (const std::exception&) { /* The snapshot remains valid if preview replacement fails. */ }
            }
        } else {
        // A first-line quick save may precede the first rendered story frame.
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
                    if (IMG_SavePNG(scaled,utf8Path(temporary).c_str())) {
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
        return true;
    }
    bool saveQuickSlot() {
        try { runtime.assertSaveBoundary(); } catch (const std::exception& error) { setSaveNotice(error.what()); return false; }
        if (runtime.currentSceneName.empty() || runtime.currentSourceFile.empty() || runtime.currentLine < 1) return false;
        json readonlyLocals = json::array(); for (const auto& frame : runtime.readonlyLocals) readonlyLocals.push_back(frame);
        json loopScopes = json::array(); for (const auto frame : runtime.loopScopes) loopScopes.push_back(frame);
        const auto savedAt = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        const json state = {{"version",1},{"saveId",gameScreens.value("saveId",std::string{})},{"file",runtime.currentSourceFile},{"scene",runtime.currentSceneName},
            {"line",runtime.currentLine},{"variables",runtime.globals},{"locals",runtime.locals},{"readonlyLocals",readonlyLocals},{"loopScopes",loopScopes},
            {"presentation",presentationSnapshot()},{"speaker",speaker},{"text",text},{"savedAt",savedAt}};
        const auto destination = quickSlotPath(); auto temporary = destination; temporary += ".tmp";
        { std::ofstream file(temporary,std::ios::binary|std::ios::trunc); if(!file) throw std::runtime_error("Quick save を作成できませんでした"); file << state.dump(2); file.flush(); if(!file) throw std::runtime_error("Quick save に書き込めませんでした"); }
        replaceSaveFile(temporary,destination);
        return true;
    }
    void loadQuickSlot() {
        json saved = nullptr;
        try { std::ifstream file(quickSlotPath()); if(file) file >> saved; } catch (...) { saved = nullptr; }
        if (!saved.is_object() || saved.value("version",0) != 1 || !saveIdCompatible(saved,gameScreens.value("saveId",std::string{}))
            || !saved.contains("file") || !saved.at("file").is_string() || saved.at("file").get<std::string>().empty()
            || !saved.contains("scene") || !validSavedSceneName(saved.at("scene"))
            || !saved.contains("line") || !validSavedLine(saved.at("line"))
            || !saved.contains("variables") || !saved.at("variables").is_object() || !validSavedFrames(saved)) return;
        activeScreen.clear(); resetScreenFocus(); screenHistory.clear();
        if (runtime.currentSceneName.empty()) { queuedLoad = saved; titleStarted = true; storyActive = true; }
        else runtime.pendingLoad = saved;
    }
    void loadSlot(int index) {
        const auto& saved = readSlot(index);
        if (!saved.is_object() || !saved.contains("file") || !saved.contains("scene") || !saved.contains("line")) return;
        activeScreen.clear(); resetScreenFocus(); screenHistory.clear();
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
    struct ScreenCanvasTransform { float sx, sy, ox, oy; };
    ScreenCanvasTransform screenCanvasTransform() const {
        const float canvasWidth = float(gameScreens.at("canvas").at("width").get<int>());
        const float canvasHeight = float(gameScreens.at("canvas").at("height").get<int>());
        const auto mode = gameScreens.value("scaleMode", std::string("contain"));
        const float sx = float(width) / canvasWidth, sy = float(height) / canvasHeight;
        if (mode == "stretch") return {sx, sy, 0, 0};
        const float scale = mode == "cover" ? std::max(sx, sy) : std::min(sx, sy);
        const float scaledWidth = canvasWidth * scale, scaledHeight = canvasHeight * scale;
        return {scale, scale, (float(width) - scaledWidth) / 2.0f, (float(height) - scaledHeight) / 2.0f};
    }
    static float screenCssNumber(const json& style, const char* key, float fallback) {
        if (!style.contains(key) || !style.at(key).is_string()) return fallback;
        try { return std::stof(style.at(key).get<std::string>()); } catch (...) { return fallback; }
    }
    SDL_Texture* screenOpacityTarget(size_t depth) {
        if (depth >= 64 || width <= 0 || height <= 0) return nullptr;
        if (screenOpacityTargets.size() <= depth) {
            screenOpacityTargets.resize(depth + 1, nullptr);
            screenOpacityTargetSizes.resize(depth + 1, {0,0});
        }
        auto*& target = screenOpacityTargets[depth];
        auto& size = screenOpacityTargetSizes[depth];
        if (target && size != std::pair<int,int>{width,height}) { SDL_DestroyTexture(target); target = nullptr; }
        if (!target) {
            target = SDL_CreateTexture(renderer,SDL_PIXELFORMAT_RGBA8888,SDL_TEXTUREACCESS_TARGET,width,height);
            if (!target) return nullptr;
            size = {width,height};
            SDL_SetTextureBlendMode(target,SDL_BLENDMODE_BLEND);
        }
        return target;
    }
    void drawScreenNode(const json& node, float sx, float sy, float ox, float oy, const json& items, float parentOpacity = 1.0f, int inheritedSlot = -1, bool renderOpacityGroup = false, size_t opacityDepth = 0, const json& inheritedPaintStyle = json::object()) {
        const auto& r = node.at("rect");
        SDL_FRect rect{ox+r.value("x",0.0f)*sx, oy+r.value("y",0.0f)*sy, r.value("width",0.0f)*sx, r.value("height",0.0f)*sy};
        if (rect.w <= 0 || rect.h <= 0) return;
        json style = node.value("style", json::object());
        const bool hasSpecifiedStyle = node.contains("specifiedStyle");
        const auto specifiedStyle = node.value("specifiedStyle", json::object());
        for (const auto* key : {"color", "font-size", "line-height", "text-align"}) {
            if (hasSpecifiedStyle && inheritedPaintStyle.contains(key) && !specifiedStyle.contains(key)) style[key] = inheritedPaintStyle.at(key);
        }
        const auto id = node.value("attrs", json::object()).value("id", std::string{});
        int itemIndex = -1;
        for (size_t i=0; i<items.size(); ++i) if (items[i].value("id", std::string{}) == id) { itemIndex = int(i); break; }
        const auto attrs = node.value("attrs", json::object());
        const bool pointerOver = screenPointerX >= rect.x && screenPointerX <= rect.x + rect.w
            && screenPointerY >= rect.y && screenPointerY <= rect.y + rect.h;
        const bool hovered = pointerOver || (itemIndex >= 0 && itemIndex == screenHover);
        const bool focused = (node.value("tag",std::string{}) == "input" && attrs.value("data-setting",std::string{}) == screenFocusedSetting && !screenFocusedSetting.empty())
            || (itemIndex >= 0 && itemIndex == screenFocusedItem)
            || (!screenFocusedNodeKey.empty() && node.value("focusKey",std::string{}) == screenFocusedNodeKey);
        const bool focusVisible = focused && screenKeyboardFocus;
        const bool active = hovered || focused;
        const int nodeSlotIndex=attrs.contains("data-slot-index")?std::stoi(attrs.at("data-slot-index").get<std::string>())+currentSlotOffset():inheritedSlot;
        if(nodeSlotIndex>=0 && nodeSlotIndex==selectedSlotIndex){style["border-color"]="#7aa8ec";style["border-width"]="3px";style["background-color"]="#ffffff";}
        const auto nodeAction = attrs.value("data-action",std::string{});
        if ((nodeAction == "auto" && autoPlayActive) || (nodeAction == "skip" && skipActive) || (nodeAction == "hold" && holdActive)) {
            style["background-color"] = "#5279bd";
            style["color"] = "#ffffff";
            style["border-color"] = "#ffffff";
        }
        if (nodeAction == "setting-value") {
            const auto key = attrs.value("data-target",std::string{});
            const auto targetValue = attrs.value("data-value",std::string{});
            const bool selected = uiSettingValues.contains(key) && ((uiSettingValues.at(key).is_boolean() && uiSettingValues.at(key).get<bool>() == (targetValue == "true")) || (uiSettingValues.at(key).is_string() && uiSettingValues.at(key).get<std::string>() == targetValue));
            style["background-color"] = selected ? "#ffffff" : "rgba(21,28,43,0.82)";
            style["color"] = selected ? "#577ac1" : "#e7ebf4";
            style["border-color"] = selected ? "#d4deef" : "rgba(155,178,217,0.14)";
        }
        if (node.value("tag",std::string{}) == "button" && attrs.value("data-action",std::string{}) == "slot-page") {
            const auto role = currentScreen().value("role",std::string{});
            const auto key = role == "save-slots" ? "save" : "load";
            const int selectedPage = slotPages.contains(key) ? slotPages.at(key) : 0;
            const int itemPage = std::stoi(attrs.value("data-target",std::string("0")));
            style["background-color"] = itemPage == selectedPage ? "#ffffff" : "rgba(24,30,44,0.75)";
            style["color"] = itemPage == selectedPage ? "#5578bd" : "#dce6f5";
            style["border-color"] = itemPage == selectedPage ? "#ffffff" : "rgba(204,215,236,0.42)";
        }
        const int localSlot = attrs.contains("data-slot-index") ? std::stoi(attrs.at("data-slot-index").get<std::string>()) : inheritedSlot;
        const int slotIndex = attrs.contains("data-slot-index") ? localSlot + currentSlotOffset() : localSlot;
        const json* actionItem = itemIndex >= 0 ? &items[size_t(itemIndex)] : nullptr;
        if (slotIndex >= 0) for (const auto& candidate : items) if (candidate.value("slotIndex", -1) == slotIndex) { actionItem = &candidate; break; }
        if (actionItem && node.contains("slotStateStyles") && node.at("slotStateStyles").is_object()) {
            const auto state = actionItem->value("slotState",std::string("empty"));
            if (node.at("slotStateStyles").contains(state)) for (const auto& [key,value] : node.at("slotStateStyles").at(state).items()) style[key] = value;
        }
        if (hovered && node.contains("hoverStyle")) for (const auto& [key, value] : node.at("hoverStyle").items()) style[key] = value;
        if (focused && node.contains("focusStyle")) for (const auto& [key, value] : node.at("focusStyle").items()) style[key] = value;
        if (focusVisible && node.contains("focusVisibleStyle")) for (const auto& [key, value] : node.at("focusVisibleStyle").items()) style[key] = value;
        // Resolve opacity after state and interaction styles have been merged;
        // those declarations are part of the same renderer-neutral CSS cascade.
        float opacity = parentOpacity * std::clamp(screenCssNumber(style,"opacity",1.0f),0.0f,1.0f);
        // Slot cards are disabled as actions when empty/corrupt, but remain
        // information panels. Their state selector owns visual styling; do not
        // fade the entire card (and its text) as for an unavailable command.
        if (attrs.contains("data-action") && !attrs.contains("data-slot-index") && actionItem && actionItem->value("disabled",false)) opacity *= 0.45f;
        if (!renderOpacityGroup && opacity < 1.0f) {
            if (opacity <= 0.0f) return;
            auto* target = screenOpacityTarget(opacityDepth);
            if (!target) throw std::runtime_error(std::string("Native opacity group texture を作成できません: ") + SDL_GetError());
            auto* previous = SDL_GetRenderTarget(renderer);
            if (!SDL_SetRenderTarget(renderer,target)) throw std::runtime_error(std::string("Native opacity group target を切り替えられません: ") + SDL_GetError());
            SDL_SetRenderDrawBlendMode(renderer,SDL_BLENDMODE_NONE);
            SDL_SetRenderDrawColor(renderer,0,0,0,0);
            SDL_RenderClear(renderer);
            drawScreenNode(node,sx,sy,ox,oy,items,1.0f,inheritedSlot,true,opacityDepth+1,inheritedPaintStyle);
            SDL_SetRenderTarget(renderer,previous);
            SDL_SetTextureAlphaModFloat(target,opacity);
            SDL_FRect layerRect{0,0,float(width),float(height)};
            SDL_RenderTexture(renderer,target,nullptr,&layerRect);
            SDL_SetTextureAlphaModFloat(target,1.0f);
            return;
        }
        if (renderOpacityGroup) opacity = 1.0f;
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
            const auto imageField = attrs.value("data-slot-field", std::string{});
            SDL_Texture* texture = nullptr;
            if (imageField == "thumbnail" && actionItem && slotIndex >= 0 && actionItem->value("slotSummary",json(nullptr)).is_object()) {
                const auto thumbnailPath = saveDirectory / ("thumb-slot-" + std::to_string(slotIndex + 1) + ".png");
                std::error_code error;
                if (fs::is_regular_file(thumbnailPath,error) && !error) {
                    try { texture = image(thumbnailPath); } catch (const std::exception&) { /* Ignore a missing or damaged preview; keep the save itself loadable. */ }
                }
            } else {
                auto imageName = attrs.value("src", std::string{}); if (imageName.starts_with("asset/")) imageName.erase(0, 6);
                texture = skinImage(imageName);
            }
            if (texture) {
                SDL_SetTextureAlphaModFloat(texture,opacity);
                SDL_FRect imageRect = rect;
                const float padLeft=screenCssNumber(style,"padding-left",screenCssNumber(style,"padding",0))*sx;
                const float padRight=screenCssNumber(style,"padding-right",screenCssNumber(style,"padding",0))*sx;
                const float padTop=screenCssNumber(style,"padding-top",screenCssNumber(style,"padding",0))*sy;
                const float padBottom=screenCssNumber(style,"padding-bottom",screenCssNumber(style,"padding",0))*sy;
                imageRect.x += padLeft; imageRect.y += padTop;
                imageRect.w = std::max(0.0f, rect.w-padLeft-padRight);
                imageRect.h = std::max(0.0f, rect.h-padTop-padBottom);
                const auto fit = style.value("object-fit",std::string{});
                if (fit == "contain") fitTexture(texture,imageRect);
                else if (fit == "cover") {
                    float sourceWidth=0,sourceHeight=0; SDL_GetTextureSize(texture,&sourceWidth,&sourceHeight);
                    const float scale=std::max(imageRect.w/sourceWidth,imageRect.h/sourceHeight);
                    SDL_FRect source{(sourceWidth-imageRect.w/scale)/2,(sourceHeight-imageRect.h/scale)/2,imageRect.w/scale,imageRect.h/scale};
                    SDL_RenderTexture(renderer,texture,&source,&imageRect);
                } else SDL_RenderTexture(renderer, texture, nullptr, &imageRect);
                SDL_SetTextureAlphaModFloat(texture,1);
            }
        }
        std::string borderValue = style.value("border-color", std::string{});
        if (borderValue.empty() && style.contains("border")) { const auto border = style.at("border").get<std::string>(); const auto split = border.find_last_of(' '); borderValue = split == std::string::npos ? border : border.substr(split + 1); }
        if (!borderValue.empty()) {
            auto border = screenCssColor(borderValue,{0,0,0,0});
            border.a = Uint8(float(border.a)*opacity);
            const float thickness = std::clamp(screenCssNumber(style,"border-width",1)*std::min(sx,sy),0.0f,std::max(rect.w,rect.h));
            SDL_SetRenderDrawColor(renderer,border.r,border.g,border.b,border.a);
            if (thickness > 0) {
                const float horizontal = std::min(thickness,rect.h), vertical = std::min(thickness,rect.w);
                SDL_FRect top{rect.x,rect.y,rect.w,horizontal}, bottom{rect.x,rect.y+rect.h-horizontal,rect.w,horizontal};
                SDL_FRect left{rect.x,rect.y+horizontal,vertical,std::max(0.0f,rect.h-2*horizontal)};
                SDL_FRect right{rect.x+rect.w-vertical,rect.y+horizontal,vertical,std::max(0.0f,rect.h-2*horizontal)};
                SDL_RenderFillRect(renderer,&top); SDL_RenderFillRect(renderer,&bottom); SDL_RenderFillRect(renderer,&left); SDL_RenderFillRect(renderer,&right);
            }
        }
        if (node.value("tag", std::string{}) == "input") {
            const auto key = attrs.value("data-setting", std::string{});
            const auto type = attrs.value("type", std::string{});
            const auto accent = screenCssColor(style.value("accent-color", std::string{}), {145,181,232,255});
            if (active) {
                SDL_FRect focusRect{rect.x-2,rect.y-2,rect.w+4,rect.h+4};
                SDL_SetRenderDrawColor(renderer,accent.r,accent.g,accent.b,Uint8(230*opacity));
                SDL_RenderRect(renderer,&focusRect);
            }
            if (type == "checkbox") {
                const auto skin = node.value("controlSkin", json::object());
                if (skin.value("type", std::string{}) == "checkbox") {
                    const bool checked = uiSettingValues.value(key, false);
                    const std::string imageKey = checked
                        ? (active ? skin.value("onHover", skin.value("on", std::string{})) : skin.value("on", std::string{}))
                        : (active ? skin.value("offHover", skin.value("off", std::string{})) : skin.value("off", std::string{}));
                    auto* texture = skinImage(imageKey);
                    SDL_SetTextureAlphaModFloat(texture, opacity);
                    SDL_RenderTexture(renderer, texture, nullptr, &rect);
                    SDL_SetTextureAlphaModFloat(texture, 1);
                } else {
                    SDL_FRect box{rect.x + rect.w * 0.25f, rect.y + rect.h * 0.18f, rect.w * 0.5f, rect.h * 0.64f};
                    SDL_SetRenderDrawColor(renderer, 18, 25, 37, Uint8(235 * opacity)); SDL_RenderFillRect(renderer, &box);
                    SDL_SetRenderDrawColor(renderer, accent.r, accent.g, accent.b, Uint8(accent.a * opacity)); SDL_RenderRect(renderer, &box);
                    if (uiSettingValues.value(key, false)) {
                        SDL_FRect mark{box.x + box.w * 0.22f, box.y + box.h * 0.22f, box.w * 0.56f, box.h * 0.56f};
                        SDL_SetRenderDrawColor(renderer, accent.r, accent.g, accent.b, Uint8(accent.a * opacity)); SDL_RenderFillRect(renderer, &mark);
                    }
                }
            } else if (type == "range") {
                const double minimum = std::stod(attrs.value("min", std::string("0"))), maximum = std::stod(attrs.value("max", std::string("1")));
                const double value = std::clamp(uiSettingValues.value(key, minimum), minimum, maximum);
                const float ratio = float((value - minimum) / (maximum - minimum));
                const auto skin = node.value("controlSkin", json::object());
                if (skin.value("type", std::string{}) == "range") {
                    const float thumbWidth = skin.value("thumbWidth", 28.0f) * sx;
                    const float thumbHeight = skin.value("thumbHeight", 28.0f) * sy;
                    const bool vertical = skin.value("orientation",std::string("horizontal")) == "vertical";
                    const float inset = skin.value("inset", skin.value("thumbWidth", 28.0f) / 2.0f) * (vertical ? sy : sx);
                    const float trackThickness = skin.value("trackHeight",8.0f) * (vertical ? sx : sy);
                    SDL_FRect rail = vertical
                        ? SDL_FRect{rect.x+(rect.w-trackThickness)/2.0f,rect.y+inset,trackThickness,std::max(0.0f,rect.h-inset*2.0f)}
                        : SDL_FRect{rect.x+inset,rect.y+(rect.h-trackThickness)/2.0f,std::max(0.0f,rect.w-inset*2.0f),trackThickness};
                    auto* railTexture = skinImage(skin.at("track").get<std::string>());
                    auto* fillTexture = skinImage(skin.at("fill").get<std::string>());
                    const auto thumbKey = active ? skin.value("thumbHover", skin.at("thumb").get<std::string>()) : skin.at("thumb").get<std::string>();
                    auto* thumbTexture = skinImage(thumbKey);
                    if (vertical) {
                        SDL_FRect rotatedTrack{rail.x+rail.w/2.0f-rail.h/2.0f,rail.y+rail.h/2.0f-rail.w/2.0f,rail.h,rail.w};
                        SDL_SetTextureAlphaModFloat(railTexture,opacity); SDL_RenderTextureRotated(renderer,railTexture,nullptr,&rotatedTrack,90.0,nullptr,SDL_FLIP_NONE); SDL_SetTextureAlphaModFloat(railTexture,1);
                    } else { SDL_SetTextureAlphaModFloat(railTexture, opacity); SDL_RenderTexture(renderer, railTexture, nullptr, &rail); SDL_SetTextureAlphaModFloat(railTexture, 1); }
                    float fillTextureWidth = 0, fillTextureHeight = 0; SDL_GetTextureSize(fillTexture, &fillTextureWidth, &fillTextureHeight);
                    if (ratio > 0 && fillTextureWidth > 0 && fillTextureHeight > 0) {
                        if (vertical) {
                            const float fillHeight=rail.h*ratio;
                            SDL_FRect source{fillTextureWidth*(1.0f-ratio),0,fillTextureWidth*ratio,fillTextureHeight};
                            SDL_FRect fillRect{rail.x+rail.w/2.0f-fillHeight/2.0f,rail.y+rail.h-fillHeight/2.0f-rail.w/2.0f,fillHeight,rail.w};
                            SDL_SetTextureAlphaModFloat(fillTexture,opacity); SDL_RenderTextureRotated(renderer,fillTexture,&source,&fillRect,90.0,nullptr,SDL_FLIP_NONE); SDL_SetTextureAlphaModFloat(fillTexture,1);
                        } else {
                            SDL_FRect source{0, 0, fillTextureWidth * ratio, fillTextureHeight};
                            SDL_FRect fillRect{rail.x, rail.y, rail.w * ratio, rail.h};
                            SDL_SetTextureAlphaModFloat(fillTexture, opacity); SDL_RenderTexture(renderer, fillTexture, &source, &fillRect); SDL_SetTextureAlphaModFloat(fillTexture, 1);
                        }
                    }
                    SDL_FRect thumb = vertical
                        ? SDL_FRect{rect.x+(rect.w-thumbWidth)/2.0f,rail.y+rail.h*(1.0f-ratio)-thumbHeight/2.0f,thumbWidth,thumbHeight}
                        : SDL_FRect{rail.x+rail.w*ratio-thumbWidth/2.0f,rect.y+(rect.h-thumbHeight)/2.0f,thumbWidth,thumbHeight};
                    SDL_SetTextureAlphaModFloat(thumbTexture, opacity); SDL_RenderTexture(renderer, thumbTexture, nullptr, &thumb); SDL_SetTextureAlphaModFloat(thumbTexture, 1);
                } else {
                    SDL_FRect rail{rect.x + rect.w * 0.04f, rect.y + rect.h * 0.38f, rect.w * 0.92f, std::max(2.0f, rect.h * 0.24f)};
                    SDL_SetRenderDrawColor(renderer, 44, 56, 72, Uint8(245 * opacity)); SDL_RenderFillRect(renderer, &rail);
                    SDL_FRect fill{rail.x, rail.y, rail.w * ratio, rail.h};
                    SDL_SetRenderDrawColor(renderer, accent.r, accent.g, accent.b, Uint8(accent.a * opacity)); SDL_RenderFillRect(renderer, &fill);
                    SDL_FRect thumb{rail.x + rail.w * ratio - rect.h * 0.28f, rect.y + rect.h * 0.1f, rect.h * 0.56f, rect.h * 0.8f};
                    SDL_RenderFillRect(renderer, &thumb);
                }
            }
        }
        std::string textValue = node.value("text",std::string{});
        if (nodeAction=="shortcut-cycle") {
            const auto key="ui.shortcut."+attrs.value("data-target",std::string{});
            const auto action=uiSettingValues.value(key,std::string("none"));
            textValue=shortcutActionLabel(action)+"  笆ｼ";
        }
        const auto field = attrs.value("data-slot-field",std::string{});
        if (actionItem && slotIndex >= 0 && !field.empty()) {
            const auto saved = actionItem->value("slotSummary", json(nullptr));
            if (field == "number") { textValue = std::to_string(slotIndex + 1); if (slotIndex < 9) textValue.insert(0,"0"); }
            else if (field == "status") textValue = slotStatusLabel(actionItem->value("slotState",std::string("empty")),saved.is_object() && saved.value("locked",false));
            else if (field == "scene") textValue = saved.is_object() ? saved.value("scene",std::string{}) : "";
            else if (field == "speaker") textValue = saved.is_object() ? saved.value("speaker",std::string{}) : "";
            else if (field == "text") textValue = saved.is_object() ? saved.value("text",std::string{}) : "";
            else if (field == "saved-at") {
                textValue.clear();
                if (saved.is_object() && saved.contains("savedAt") && saved.at("savedAt").is_number_integer()) {
                    textValue = formatSlotTimestamp(saved.at("savedAt").get<int64_t>());
                }
            }
        } else if (actionItem && attrs.contains("data-slot-index") && node.value("children",json::array()).empty()) textValue = actionItem->value("label",textValue);
        if (!textValue.empty()) {
            auto textColor = screenCssColor(style.value("color",std::string{}),{245,247,248,255});
            textColor.a = Uint8(float(textColor.a)*opacity);
            const float fontSize = screenCssNumber(style,"font-size",22)*sy;
            int textWidth=0,textHeight=0; TTF_SetFontSize(font,std::max(1,int(fontSize))); TTF_GetStringSize(font,textValue.c_str(),textValue.size(),&textWidth,&textHeight);
            int lineSkip = -1;
            if (style.contains("line-height") && style.at("line-height").is_string()) {
                const auto lineHeight = style.at("line-height").get<std::string>();
                const float value = screenCssNumber(style,"line-height",0);
                const float resolved = lineHeight.ends_with("px") ? value * sy
                    : lineHeight.ends_with("%") ? fontSize * value / 100.0f
                    : fontSize * value;
                lineSkip = std::max(0,int(std::round(resolved)));
            }
            const float padLeft=screenCssNumber(style,"padding-left",screenCssNumber(style,"padding",0))*sx;
            const float padTop=screenCssNumber(style,"padding-top",screenCssNumber(style,"padding",0))*sy;
            const float padRight=screenCssNumber(style,"padding-right",screenCssNumber(style,"padding",0))*sx;
            // CSS block text starts at the top of its content box. Keep the
            // Native text origin there too; the Browser does not vertically
            // center ordinary div/span text in a fixed-height rectangle.
            float tx=rect.x+padLeft, ty=rect.y+padTop;
            if (style.value("text-align",std::string{}) == "center") tx=rect.x+padLeft+std::max(0.0f,(rect.w-padLeft-padRight-float(textWidth))/2.0f);
            else if (style.value("text-align",std::string{}) == "right") tx=rect.x+std::max(0.0f,rect.w-float(textWidth)-padRight);
            label(textValue,tx,ty,std::max(1,int(fontSize)),textColor,std::max(1.0f,rect.w-padLeft-padRight),rect.h-padTop,lineSkip);
        }
        if (attrs.value("data-role", std::string{}) == "dialogue-history") {
            const int rowHeight = std::max(42, int(54 * sy));
            const int visible = std::max(1, int(rect.h) / rowHeight);
            const int maximumScroll = std::max(0, int(dialogueHistory.size()) - visible);
            dialogueHistoryScroll = std::clamp(dialogueHistoryScroll, 0, maximumScroll);
            if (dialogueHistory.empty()) {
                label("会話履歴はありません。", rect.x + 20 * sx, rect.y + 20 * sy, std::max(14, int(16 * sy)), {209,217,231,255}, rect.w - 40 * sx, rowHeight);
            } else {
                const int end = int(dialogueHistory.size()) - dialogueHistoryScroll;
                const int begin = std::max(0, end - visible);
                for (int index = begin; index < end; ++index) {
                    const float rowY = rect.y + float(index - begin) * rowHeight;
                    const auto& entry = dialogueHistory[size_t(index)];
                    if (!entry.first.empty()) label(entry.first, rect.x + 10 * sx, rowY + 3 * sy, std::max(12, int(14 * sy)), {170,197,240,255}, rect.w - 24 * sx, 18 * sy);
                    label(entry.second, rect.x + 10 * sx, rowY + (entry.first.empty() ? 4 : 20) * sy, std::max(14, int(17 * sy)), {242,245,251,255}, rect.w - 24 * sx, rowHeight - 22 * sy);
                    SDL_FRect separator{rect.x + 8 * sx, rowY + rowHeight - 1, rect.w - 16 * sx, 1};
                    SDL_SetRenderDrawColor(renderer, 212,225,247,50); SDL_RenderFillRect(renderer, &separator);
                }
            }
        }
        if (attrs.value("data-role", std::string{}) == "selected-slot-summary") {
            const auto selected = selectedSlotIndex >= 0 ? readSlot(selectedSlotIndex) : json(nullptr);
            const auto summary = selectedSlotSummary(selectedSlotIndex,selected,deleteArmedSlotIndex==selectedSlotIndex);
            label(summary,rect.x+8*sx,rect.y+8*sy,std::max(12,int(12*sy)),{82,96,120,255},rect.w-16*sx,rect.h-16*sy);
        }
        std::vector<const json*> orderedChildren;
        const auto children = node.find("children");
        if (children != node.end() && children->is_array()) for (const auto& child : *children) orderedChildren.push_back(&child);
        std::stable_sort(orderedChildren.begin(),orderedChildren.end(),[](const json* left,const json* right) {
            return screenCssNumber(left->value("style",json::object()),"z-index",0) < screenCssNumber(right->value("style",json::object()),"z-index",0);
        });
        json childInheritedPaintStyle = inheritedPaintStyle;
        for (const auto* key : {"color", "font-size", "line-height", "text-align"}) if (style.contains(key)) childInheritedPaintStyle[key] = style.at(key);
        for (const auto* child : orderedChildren) drawScreenNode(*child,sx,sy,ox,oy,items,opacity,slotIndex,false,opacityDepth,childInheritedPaintStyle);
    }
    const json* findScreenInput(const json& nodes, float mouseX, float mouseY) const {
        const json empty = json::array();
        const auto transform = screenCanvasTransform();
        const float sx = transform.sx, sy = transform.sy;
        for (auto it = nodes.rbegin(); it != nodes.rend(); ++it) {
            const auto& node = *it;
            if (node.value("style", json::object()).value("display", std::string{}) == "none") continue;
            const auto& children = node.contains("children") ? node.at("children") : empty;
            if (const auto* child = findScreenInput(children, mouseX, mouseY)) return child;
            if (node.value("tag", std::string{}) != "input") continue;
            const auto& rect = node.at("rect");
            const float x = transform.ox + rect.value("x", 0.0f) * sx, y = transform.oy + rect.value("y", 0.0f) * sy;
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
    void updateScreenInput(const json& node, float mouseX, float mouseY) {
        const auto attrs = node.value("attrs", json::object());
        const auto key = attrs.value("data-setting", std::string{});
        if (key.empty()) return;
        if (attrs.value("type", std::string{}) == "checkbox") {
            updateUiSetting(key, !uiSettingValues.value(key, false));
            return;
        }
        const auto& rect = node.at("rect");
        const auto transform = screenCanvasTransform();
        const double minimum = std::stod(attrs.value("min", std::string("0"))), maximum = std::stod(attrs.value("max", std::string("1")));
        const auto skin = node.value("controlSkin", json::object());
        const bool vertical = skin.value("orientation",std::string("horizontal")) == "vertical";
        const float inset = skin.value("type",std::string{}) == "range"
            ? skin.value("inset",skin.value("thumbWidth",28.0f)/2.0f) * (vertical ? transform.sy : transform.sx) : 0.0f;
        const float extent = (vertical ? rect.value("height",0.0f)*transform.sy : rect.value("width",0.0f)*transform.sx) - inset*2.0f;
        const float origin = vertical ? transform.oy + rect.value("y",0.0f)*transform.sy + inset : transform.ox + rect.value("x",0.0f)*transform.sx + inset;
        const float position = vertical ? origin + extent - mouseY : mouseX - origin;
        const float ratio = std::clamp(position/std::max(1.0f,extent),0.0f,1.0f);
        const double step = std::stod(attrs.value("step", std::string("0.01")));
        const double raw = minimum + double(ratio) * (maximum - minimum);
        const double stepped = std::clamp(minimum + std::round((raw - minimum) / step) * step, minimum, maximum);
        updateUiSetting(key, stepped);
    }
    SDL_FRect screenItemRect(const json& item) const {
        const auto transform = screenCanvasTransform();
        return { transform.ox + item.at("x").get<float>() * transform.sx, transform.oy + item.at("y").get<float>() * transform.sy, item.at("width").get<float>() * transform.sx, item.at("height").get<float>() * transform.sy };
    }
    void drawScreenBackground(SDL_Texture* texture) {
        if (!texture) return;
        float textureWidth = 0, textureHeight = 0;
        if (!SDL_GetTextureSize(texture,&textureWidth,&textureHeight) || textureWidth <= 0 || textureHeight <= 0) {
            SDL_RenderTexture(renderer,texture,nullptr,nullptr);
            return;
        }
        const float sourceAspect = textureWidth / textureHeight, targetAspect = float(width) / float(height);
        SDL_FRect source{0,0,textureWidth,textureHeight};
        if (sourceAspect > targetAspect) {
            source.w = textureHeight * targetAspect;
            source.x = (textureWidth - source.w) / 2.0f;
        } else {
            source.h = textureWidth / targetAspect;
            source.y = (textureHeight - source.h) / 2.0f;
        }
        SDL_RenderTexture(renderer,texture,&source,nullptr);
    }
    struct ScreenNavigationTarget { int itemIndex = -1; std::string setting; SDL_FRect rect{}; bool disabled = false; int tabIndex = 0; std::string nodeId; };
    std::vector<ScreenNavigationTarget> screenNavigationTargets() const {
        const auto items = visibleScreenItems();
        std::vector<ScreenNavigationTarget> targets;
        if (!currentScreen().contains("uiTree")) {
            for (size_t index = 0; index < items.size(); ++index) if (items[index].value("type",std::string{}) == "button") targets.push_back({int(index),{},screenItemRect(items[index]),items[index].value("disabled",false)});
            return targets;
        }
        const auto tabIndexFor = [](const json& attrs, const std::string& tag) {
            if (attrs.contains("tabindex")) return std::stoi(attrs.at("tabindex").get<std::string>());
            return tag == "button" || tag == "input" ? 0 : -1;
        };
        std::vector<bool> used(items.size(),false);
        const auto transform = screenCanvasTransform();
        std::function<void(const json&)> visit = [&](const json& nodes) {
            for (const auto& node : nodes) {
                if (node.value("style",json::object()).value("display",std::string{}) == "none") continue;
                const auto attrs = node.value("attrs",json::object());
                const auto tag = node.value("tag",std::string{});
                if (tag == "input") {
                    const auto setting = attrs.value("data-setting",std::string{});
                    const auto& rect = node.at("rect");
                    const int tabIndex = tabIndexFor(attrs,tag);
                    if (!setting.empty() && tabIndex >= 0) targets.push_back({-1,setting,{transform.ox+rect.value("x",0.0f)*transform.sx,transform.oy+rect.value("y",0.0f)*transform.sy,rect.value("width",0.0f)*transform.sx,rect.value("height",0.0f)*transform.sy},false,tabIndex});
                }
                const auto action = attrs.value("data-action",std::string{});
                if (tag == "button" && action.empty()) {
                    const int tabIndex = tabIndexFor(attrs,tag);
                    if (tabIndex >= 0) {
                        const auto& rect = node.at("rect");
                        targets.push_back({-1,{}, {transform.ox+rect.value("x",0.0f)*transform.sx,transform.oy+rect.value("y",0.0f)*transform.sy,rect.value("width",0.0f)*transform.sx,rect.value("height",0.0f)*transform.sy},false,tabIndex,node.value("focusKey",std::string{})});
                    }
                }
                if (!action.empty()) {
                    const auto target = attrs.value("data-target",std::string{});
                    const int localSlot = attrs.contains("data-slot-index") ? std::stoi(attrs.at("data-slot-index").get<std::string>()) : -1;
                    const int slotIndex = localSlot < 0 ? localSlot : localSlot + currentSlotOffset();
                    for (size_t index = 0; index < items.size(); ++index) {
                        if (used[index] || items[index].value("action",std::string{}) != action || items[index].value("target",std::string{}) != target) continue;
                        if (slotIndex >= 0 && items[index].value("slotIndex",-1) != slotIndex) continue;
                        if (slotIndex < 0 && items[index].contains("slotIndex")) continue;
                        used[index] = true;
                        const int tabIndex = tabIndexFor(attrs,tag);
                        if (tabIndex >= 0) targets.push_back({int(index),{},screenItemRect(items[index]),items[index].value("disabled",false),tabIndex,node.value("focusKey",std::string{})});
                        break;
                    }
                }
                auto children = node.value("children",json::array());
                std::stable_sort(children.begin(),children.end(),[](const json& a,const json& b) {
                    return a.value("sourceOrder",0) < b.value("sourceOrder",0);
                });
                visit(children);
            }
        };
        visit(currentScreen().at("uiTree"));
        std::stable_sort(targets.begin(),targets.end(),[](const auto& a,const auto& b) {
            if (a.tabIndex > 0 && b.tabIndex > 0) return a.tabIndex < b.tabIndex;
            if (a.tabIndex > 0) return true;
            if (b.tabIndex > 0) return false;
            return false;
        });
        return targets;
    }
    void focusScreenTarget(const ScreenNavigationTarget& target) {
        screenFocusedItem = target.itemIndex; screenKeyboardFocus = true; screenFocusedNodeKey = target.nodeId;
        screenFocusedSetting = target.setting;
    }
    void moveScreenFocus(int dx, int dy, bool sequential = false) {
        const auto targets = screenNavigationTargets();
        std::vector<size_t> enabled;
        for (size_t index = 0; index < targets.size(); ++index) if (!targets[index].disabled) enabled.push_back(index);
        if (enabled.empty()) { screenFocusedItem = -1; screenKeyboardFocus = true; screenFocusedSetting.clear(); return; }
        auto current = std::find_if(targets.begin(),targets.end(),[&](const auto& target) {
            return !target.disabled && (screenFocusedSetting.empty() ? (target.itemIndex == screenFocusedItem && target.nodeId == screenFocusedNodeKey) : target.setting == screenFocusedSetting);
        });
        if (current == targets.end()) { focusScreenTarget(targets[enabled.front()]); return; }
        const size_t currentIndex = size_t(current-targets.begin());
        size_t best = currentIndex;
        if (sequential) {
            const auto position = std::find(enabled.begin(),enabled.end(),currentIndex);
            const int p = int(position-enabled.begin());
            best = enabled[size_t((p+(dx<0?int(enabled.size())-1:1))%int(enabled.size()))];
        } else {
            const auto& from = targets[currentIndex].rect;
            const float cx=from.x+from.w/2.0f, cy=from.y+from.h/2.0f;
            float bestScore=std::numeric_limits<float>::infinity();
            for (const size_t index : enabled) {
                if (index==currentIndex) continue;
                const auto& rect=targets[index].rect;
                const float x=rect.x+rect.w/2.0f,y=rect.y+rect.h/2.0f;
                const float primary=dx?(x-cx)*float(dx):(y-cy)*float(dy);
                if (primary<=0.5f) continue;
                const float cross=dx?std::abs(y-cy):std::abs(x-cx);
                const float score=primary+cross*2.5f+cross*cross/std::max(1.0f,primary);
                if(score<bestScore){bestScore=score;best=index;}
            }
            if(best==currentIndex){
                for(const size_t index:enabled){if(index==currentIndex)continue;const auto& rect=targets[index].rect;const float x=rect.x+rect.w/2.0f,y=rect.y+rect.h/2.0f;const float primary=dx?(x-cx)*float(dx):(y-cy)*float(dy);const float cross=dx?std::abs(y-cy):std::abs(x-cx);const float score=(primary<0?100000.0f:0.0f)+std::abs(primary)+cross*2.5f;if(score<bestScore){bestScore=score;best=index;}}
            }
        }
        focusScreenTarget(targets[best]);
    }
    void adjustFocusedScreenControl(int direction) {
        if(screenFocusedSetting.empty()) return;
        const auto tree=currentScreen().value("uiTree",json::array());
        const auto* node=findScreenInputBySetting(tree,screenFocusedSetting);
        if(!node) return;
        const auto attrs=node->value("attrs",json::object());
        if(attrs.value("type",std::string{})=="checkbox") { updateUiSetting(screenFocusedSetting,!uiSettingValues.value(screenFocusedSetting,false)); return; }
        const double minimum=std::stod(attrs.value("min",std::string("0"))),maximum=std::stod(attrs.value("max",std::string("1"))),step=std::stod(attrs.value("step",std::string("0.01")));
        const double value=uiSettingValues.value(screenFocusedSetting,minimum);
        const double candidate=value+double(direction)*step;
        if (candidate==value) return;
        updateUiSetting(screenFocusedSetting,std::clamp(minimum+std::round((candidate-minimum)/step)*step,minimum,maximum));
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
    void drawDialogueLayer(bool drawControls = true) {
        const float dialogWidth = float(number("dialog.width", 900));
        const float dialogHeight = float(number("dialog.height", 184));
        const float dx = config.contains("dialog.x") ? float(number("dialog.x", 0)) : (float(width) - dialogWidth) / 2.0f;
        const float dy = config.contains("dialog.y") ? float(number("dialog.y", 0)) : float(height) - dialogHeight - float(number("dialog.bottom", 26));
        SDL_FRect box{dx, dy, dialogWidth, dialogHeight};
        const auto textColor = color("dialog.text_color", {235,241,248,255});
        const float dialogOpacity = (dialogueOpacityOverride >= 0 ? dialogueOpacityOverride : float(number("dialog.opacity", 1))) * uiSettingValues.value("ui.dialogOpacity", 1.0f);
        if (dialog) { SDL_SetTextureAlphaModFloat(dialog, dialogOpacity); SDL_RenderTexture(renderer, dialog, nullptr, &box); SDL_SetTextureAlphaModFloat(dialog, 1); }
        else { auto fill=color("dialog.background_color", {13,20,33,232}), border=color("dialog.border_color", {112,159,201,180}), accent=color("dialog.accent_color", {100,190,255,255}); fill.a=Uint8(fill.a*dialogOpacity); border.a=Uint8(border.a*dialogOpacity); accent.a=Uint8(accent.a*dialogOpacity); outlinedPanel(box,fill,border,accent); }
        speakerLabel(speaker, box.x + float(number("dialog.speaker_x", 90)), box.y + float(number("dialog.speaker_y", -52)), number("dialog.speaker_size", number("font.size", 24)), color("dialog.speaker_color", textColor));
        dialogueLabel(text, box.x + float(number("dialog.text_x", 190)), box.y + float(number("dialog.text_y", 63)), number("dialog.text_size", number("font.size", 24)), textColor, float(number("dialog.text_width", 844)), float(number("dialog.text_height", 0)));
        if (options.empty() && !text.empty()) label("▶", float(width) - 66, float(height) - 68, 34, {230,240,250,210}, 48);
        if (drawControls) drawPlayerControls();
        if (!options.empty()) {
            const auto choiceView = choiceViewport();
            SDL_Rect choiceClip{int(choiceView.x),int(choiceView.y),int(choiceView.w),int(choiceView.h)};
            SDL_SetRenderClipRect(renderer,&choiceClip);
            for (size_t i=0;i<options.size();++i) {
                SDL_FRect rect=choiceRect(i); const bool active=int(i)==hovered;
                if (active ? choiceActiveSkin : choiceSkin) SDL_RenderTexture(renderer,active ? choiceActiveSkin : choiceSkin,nullptr,&rect);
                else outlinedPanel(rect,active ? SDL_Color{31,65,98,245} : SDL_Color{14,24,39,232},active ? SDL_Color{125,210,255,255} : SDL_Color{92,128,163,190},active ? SDL_Color{112,208,255,255} : SDL_Color{67,114,159,220});
                label(options[i],rect.x+float(number("choice.text_x",24)),rect.y+float(number("choice.text_y",12)),number("choice.text_size",19),color("choice.text_color",{240,246,252,255}),float(number("choice.text_width",int(rect.w)-42)),float(number("choice.text_height",0)));
            }
            SDL_SetRenderClipRect(renderer,nullptr);
        }
    }
    void activateScreenItem(const json& item) {
        if (item.value("disabled", false)) return;
        if (item.contains("slotIndex")) {
            const int index = item.at("slotIndex").get<int>();
            if (item.value("action", std::string{}) == "slot-select") { selectedSlotIndex=index; deleteArmedSlotIndex=-1; }
            else if (item.value("action", std::string{}) == "save") saveSlot(index); else loadSlot(index);
            return;
        }
        const auto action = item.value("action", std::string{});
        if (action == "shortcut-cycle") {
            const auto key="ui.shortcut."+item.value("target",std::string{});
            if (!uiSettingValues.contains(key) || !uiSettingValues.at(key).is_string()) return;
            const auto& allowed=shortcutActions();
            const auto current=std::find(allowed.begin(),allowed.end(),uiSettingValues.at(key).get<std::string>());
            const size_t nextIndex=current==allowed.end()?0:(size_t(current-allowed.begin())+1)%allowed.size();
            updateUiSetting(key,allowed[nextIndex]); resetScreenFocus();
        } else if (action == "setting-value") {
            const auto key=item.value("target",std::string{});
            const auto value=item.value("value",json(false));
            if (uiSettingValues.contains(key)) updateUiSetting(key,value);
        } else if (action == "slot-commit") {
            if(selectedSlotIndex<0) return;
            if(currentScreen().value("role",std::string{})=="save-slots") saveSlot(selectedSlotIndex);
            else if(currentScreen().value("role",std::string{})=="load-slots") loadSlot(selectedSlotIndex);
        } else if(action=="slot-copy" || action=="slot-move") { if(selectedSlotIndex>=0) transferSlotRecord(selectedSlotIndex,action=="slot-move"); deleteArmedSlotIndex=-1; }
        else if(action=="slot-delete") {
            if(selectedSlotIndex<0) return;
            if(deleteArmedSlotIndex!=selectedSlotIndex) deleteArmedSlotIndex=selectedSlotIndex;
            else { deleteSlotRecord(selectedSlotIndex); selectedSlotIndex=-1; deleteArmedSlotIndex=-1; }
        } else if(action=="slot-lock") {
            if(selectedSlotIndex<0 || !readSlot(selectedSlotIndex).is_object()) return;
            json updated=readSlot(selectedSlotIndex); updated["locked"]=!updated.value("locked",false); writeSlotRecord(selectedSlotIndex,updated); deleteArmedSlotIndex=-1;
        } else if (action == "start") { activeScreen.clear(); resetScreenFocus(); titleStarted = true; storyActive = true; screenHistory.clear(); }
        else if (action == "continue") { if (const auto index = latestSaveSlotIndex()) loadSlot(*index); }
        else if (action == "next") { if (holdActive) return; activeScreen.clear(); resetScreenFocus(); screenHistory.clear(); next = true; }
        else if (action == "auto") { holdActive = false; autoPlayActive = !autoPlayActive; if (autoPlayActive) skipActive = false; activeScreen.clear(); resetScreenFocus(); screenHistory.clear(); next = true; }
        else if (action == "skip") { holdActive = false; skipActive = !skipActive; if (skipActive) autoPlayActive = false; activeScreen.clear(); resetScreenFocus(); screenHistory.clear(); next = true; }
        else if (action == "hold") { holdActive = !holdActive; autoPlayActive = false; skipActive = false; activeScreen.clear(); resetScreenFocus(); screenHistory.clear(); }
        else if (action == "quick-save") saveQuickSlot();
        else if (action == "quick-load") loadQuickSlot();
        else if (action == "resume") { activeScreen.clear(); resetScreenFocus(); screenHistory.clear(); }
        else if (action == "save" || action == "load") openSlotScreen(action);
        else if (action == "slot-page") {
            const int page = std::stoi(item.value("target", std::string("0")));
            if (page < 0 || page > 9) throw std::runtime_error("Save page の指定が不正です");
            slotPages[currentScreen().value("role",std::string{}) == "save-slots" ? "save" : "load"] = page;
            resetScreenFocus();
        } else if (action == "reset-settings") {
            const auto defaults = gameScreens.value("controlDefaults",json::object());
            for (const auto& [key, value] : defaults.items()) updateUiSetting(key,value);
        } else if (action == "reset-window-size") {
            if (!SDL_SetWindowFullscreen(window,false)) throw std::runtime_error(SDL_GetError());
            SDL_SetWindowSize(window,baseWindowWidth,baseWindowHeight);
            width=baseWindowWidth; height=baseWindowHeight;
        } else if (action == "open-screen") {
            const auto target = item.value("target", std::string{});
            if (!gameScreens.at("screens").contains(target)) throw std::runtime_error("Game screen が見つかりません: " + target);
            if (activeScreen != target) screenHistory.push_back(activeScreen);
            activeScreen = target; resetScreenFocus();
        } else if (action == "back") {
            if (!screenHistory.empty()) { activeScreen = screenHistory.back(); screenHistory.pop_back(); resetScreenFocus(); }
            else if (storyActive) { activeScreen.clear(); resetScreenFocus(); }
        } else if (action == "quit") throw Quit{};
    }
    void runTitleScreen() {
        if (gameScreens.empty()) { titleStarted = true; return; }
        activeScreen = gameScreens.at("initial").get<std::string>(); resetScreenFocus();
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
            if (fadeOutMs > 0 && !MIX_SetTrackGain(playback.track, startGain * uiSettingGain("bgm"))) throw std::runtime_error(SDL_GetError());
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
            json value = {{"id", id}, {"pose", sprite.pose}, {"slot", sprite.position},
                {"opacity", sprite.alpha}, {"offsetX", sprite.offsetX}, {"offsetY", sprite.offsetY},
                {"visualOrder", sprite.visualOrder}};
            if (sprite.layer) value["layer"] = *sprite.layer;
            characterState.push_back(std::move(value));
        }
        json imageState = json::array();
        for (const auto& [id, sprite] : images) {
            json value = {{"asset", id}, {"slot", sprite.position}, {"opacity", sprite.alpha},
                {"offsetX", sprite.offsetX}, {"offsetY", sprite.offsetY}, {"visualOrder", sprite.visualOrder}};
            if (sprite.layer) value["layer"] = *sprite.layer;
            imageState.push_back(std::move(value));
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
        if (background) { backgroundState = {{"asset", backgroundAsset}, {"offsetX", backgroundOffsetX}, {"offsetY", backgroundOffsetY}}; if (backgroundLayer) backgroundState["layer"] = *backgroundLayer; }
        json videoState = video ? json{{"asset", videoAsset}, {"layer", videoLayer ? json(*videoLayer) : json(nullptr)}} : json(nullptr);
        json effectState = overlay > 0 ? json{{"type", "fade"}, {"color", overlayColor.r > 127 ? "white" : "black"}, {"opacity", overlay}} : json(nullptr);
        json volumes=json::object(), volumeOverrides=json::object();
        for(const auto* kind:{"bgm","se","voice"}) {
            const auto found=config.find(std::string("audio.")+kind+"_volume");
            volumes[kind]=found==config.end() ? (std::string(kind)=="voice"?0.5f:1.0f) : std::stof(found->second);
        }
        for(const auto& [kind,gain]:audioVolumeOverrides) volumeOverrides[kind]=gain;
        json visualOnly=nullptr;
        if(!visualOnlyKind.empty() && visualOnlyKind!="video") visualOnly={{"kind",visualOnlyKind},{"id",visualOnlyId}};
        json layerState = json::object(); for (const auto& [category, value] : renderLayers) layerState[category] = value;
        return {{"logicalTimeMs", logicalTimeMs}, {"background", backgroundState}, {"video", videoState},{"visualOnly",visualOnly}, {"layers", layerState},
            {"characters", characterState}, {"images", imageState}, {"bgm", bgmState},
            {"audio",{{"volumes",volumes},{"volumeOverrides",volumeOverrides}}},{"ui",{{"dialogOpacity",config.contains("dialog.opacity")?std::stof(config.at("dialog.opacity")):1.0f},{"dialogVisible",dialogueVisible}}}, {"camera",{{"zoom",cameraZoom},{"focusX",cameraFocusX},{"focusY",cameraFocusY}}},
            {"activeMedia", activeMedia}, {"effect", effectState}};
    }
    void restorePresentation(const json& state) {
        characters.clear(); images.clear(); nextVisualOrder = 0;
        audioVolumeOverrides.clear();
        const auto audioState=state.value("audio",json::object());
        const auto savedLayers=state.value("layers",json::object());
        for(const auto& [category,value]:savedLayers.items()) {
            if(!renderLayers.contains(category)) throw std::runtime_error("save data\u306erender layer category\u304c\u4e0d\u6b63\u3067\u3059: "+category);
            renderLayers[category]=checkedRenderLayer(value);
        }
        const auto savedVolumes=audioState.value("volumes",json::object());
        for(const auto* kind:{"bgm","se","voice"}) {
        if(savedVolumes.contains(kind)) { const auto gain=savedVolumes.at(kind).get<float>(); if(!std::isfinite(gain)||gain<0||gain>1) throw std::runtime_error("保存データの音量設定が不正です"); config[std::string("audio.")+kind+"_volume"]=std::to_string(gain); }
            const auto gain=audioState.value("volumeOverrides",json::object()).value(kind,-1.0f);
            if(gain>=0) audioVolumeOverrides[kind]=gain;
        }
        const auto dialogOpacity=state.value("ui",json::object()).value("dialogOpacity",float(number("dialog.opacity",1)));
        if(!std::isfinite(dialogOpacity)||dialogOpacity<0||dialogOpacity>1) throw std::runtime_error("保存データのdialog opacityが不正です");
        config["dialog.opacity"]=std::to_string(dialogOpacity);
        dialogueVisible=state.value("ui",json::object()).value("dialogVisible",true);
        const auto camera=state.value("camera",json::object()); cameraZoom=camera.value("zoom",1.0f); cameraFocusX=camera.value("focusX",640.0f); cameraFocusY=camera.value("focusY",360.0f);
        if(!std::isfinite(cameraZoom)||cameraZoom<0.1f||cameraZoom>8.0f||!std::isfinite(cameraFocusX)||!std::isfinite(cameraFocusY)) throw std::runtime_error("保存データのcamera stateが不正です");
        background = nullptr; previousBackground = nullptr; backgroundAsset.clear();
        backgroundOffsetX = previousBackgroundOffsetX = backgroundOffsetY = previousBackgroundOffsetY = 0;
        backgroundLayer.reset(); videoLayer.reset();
        visualOnlyKind.clear(); visualOnlyId.clear();
        if(state.contains("visualOnly") && state.at("visualOnly").is_object()) {
            visualOnlyKind=state.at("visualOnly").value("kind",std::string{});
            visualOnlyId=state.at("visualOnly").value("id",std::string{});
            if(visualOnlyKind=="video" || visualOnlyKind!="" && visualOnlyKind!="background" && visualOnlyKind!="character" && visualOnlyKind!="image") throw std::runtime_error("保存データのvisual-only modeが不正です");
        }
        if (state.contains("background") && state["background"].is_object()) {
            const auto& bg = state["background"];
            backgroundAsset = bg.value("asset", std::string{});
            backgroundOffsetX = bg.value("offsetX", 0.0f); backgroundOffsetY = bg.value("offsetY", 0.0f);
            if(bg.contains("layer") && !bg.at("layer").is_null()) backgroundLayer=checkedRenderLayer(bg.at("layer"));
            if (!backgroundAsset.empty()) background = image(asset("bg", backgroundAsset));
        }
        for (const auto& value : state.value("characters", json::array())) {
            const auto id = value.at("id").get<std::string>(), pose = value.value("pose", std::string{});
            Sprite sprite; sprite.texture = image(asset("char", id, pose)); sprite.asset = id; sprite.pose = pose;
            sprite.position = value.value("slot", std::string("center")); sprite.alpha = value.value("opacity", 1.0f);
            sprite.offsetX = value.value("offsetX", 0.0f); sprite.offsetY = value.value("offsetY", 0.0f);
            if(value.contains("layer") && !value.at("layer").is_null()) sprite.layer=checkedRenderLayer(value.at("layer"));
            sprite.visualOrder = value.value("visualOrder", uint64_t(++nextVisualOrder));
            nextVisualOrder = std::max(nextVisualOrder, sprite.visualOrder); characters[id] = std::move(sprite);
        }
        for (const auto& value : state.value("images", json::array())) {
            const auto id = value.at("asset").get<std::string>();
            Sprite sprite; sprite.texture = image(asset("image", id)); sprite.asset = id;
            sprite.position = value.value("slot", std::string("center")); sprite.alpha = value.value("opacity", 1.0f);
            sprite.offsetX = value.value("offsetX", 0.0f); sprite.offsetY = value.value("offsetY", 0.0f);
            if(value.contains("layer") && !value.at("layer").is_null()) sprite.layer=checkedRenderLayer(value.at("layer"));
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
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            if (e.type == SDL_EVENT_QUIT) throw Quit{};
            if (e.type == SDL_EVENT_MOUSE_MOTION) { screenPointerX = e.motion.x; screenPointerY = e.motion.y; }
            else if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN) { screenPointerX = e.button.x; screenPointerY = e.button.y; }
            if (e.type == SDL_EVENT_MOUSE_MOTION || e.type == SDL_EVENT_MOUSE_BUTTON_DOWN || e.type == SDL_EVENT_MOUSE_WHEEL) {
                lastMouseActivity=SDL_GetTicks();
                if(cursorHidden) { SDL_ShowCursor(); cursorHidden=false; }
            }
            if (e.type == SDL_EVENT_GAMEPAD_ADDED) {
                if (SDL_Gamepad* gamepad = SDL_OpenGamepad(e.gdevice.which)) gamepads[e.gdevice.which] = gamepad;
                continue;
            }
            if (e.type == SDL_EVENT_GAMEPAD_REMOVED) {
                const auto found = gamepads.find(e.gdevice.which);
                if (found != gamepads.end()) { SDL_CloseGamepad(found->second); gamepads.erase(found); }
                continue;
            }
            // A blocking video is an exclusive presentation: SDL still pumps
            // events and renders frames, but story/menu hit targets stay inert.
            if (videoBlocksStory || visualOnlyKind == "video") continue;
            if (e.type == SDL_EVENT_KEY_DOWN && !e.key.repeat && e.key.scancode >= SDL_SCANCODE_F1 && e.key.scancode <= SDL_SCANCODE_F12 && (!activeScreen.empty() || storyActive)) {
                const int shortcut = int(e.key.scancode) - int(SDL_SCANCODE_F1) + 1;
                const auto key="ui.shortcut.F"+std::to_string(shortcut);
                const auto binding=uiSettingValues.value(key,std::string("none"));
                if (binding == "system" && gameScreens.at("screens").contains("system")) {
                    if (!activeScreen.empty()) screenHistory.push_back(activeScreen);
                    activeScreen = "system"; resetScreenFocus();
                } else if (binding == "save") openSlotScreen("save");
                else if (binding == "load") openSlotScreen("load");
                else if (binding == "replay-voice" && !lastVoiceAsset.empty()) sound("voice",lastVoiceAsset,0,false,-1.0f,lastVoiceCharacter);
                else if (binding == "auto" && storyActive) { holdActive=false; autoPlayActive=!autoPlayActive; if(autoPlayActive)skipActive=false; activeScreen.clear();resetScreenFocus();screenHistory.clear();next=true; }
                else if (binding == "clear-text") text.clear();
                else if (binding == "fullscreen") updateUiSetting("ui.fullscreen",!uiSettingValues.value("ui.fullscreen",false));
                else if (binding == "skip" && storyActive) { holdActive=false; skipActive=!skipActive; if(skipActive)autoPlayActive=false; activeScreen.clear();resetScreenFocus();screenHistory.clear();next=true; }
                else if (binding == "quick-save" && storyActive) saveQuickSlot();
                else if (binding == "history" && gameScreens.at("screens").contains("log")) {
                    if (!activeScreen.empty()) screenHistory.push_back(activeScreen);
                    activeScreen = "log"; resetScreenFocus();
                } else if (binding == "quick-load" && storyActive) loadQuickSlot();
                continue;
            }
            if (!activeScreen.empty() && activeScreen == "log" && e.type == SDL_EVENT_MOUSE_WHEEL) {
                dialogueHistoryScroll = std::max(0, dialogueHistoryScroll + int(e.wheel.y));
                continue;
            }
            if (!activeScreen.empty() && currentScreen().contains("uiTree")) {
                bool consumed = false;
                const auto& tree = currentScreen().at("uiTree");
                if (e.type == SDL_EVENT_MOUSE_BUTTON_UP) draggedUiSetting.clear();
                if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
                    if (const auto* input = findScreenInput(tree, float(e.button.x), float(e.button.y))) {
                        const auto attrs = input->value("attrs", json::object());
                        draggedUiSetting = attrs.value("data-setting", std::string{});
                        screenFocusedSetting = draggedUiSetting; screenFocusedItem = -1; screenKeyboardFocus = false;
                        updateScreenInput(*input, float(e.button.x),float(e.button.y));
                        if (attrs.value("type", std::string{}) == "checkbox") draggedUiSetting.clear();
                        consumed = true;
                    }
                } else if (e.type == SDL_EVENT_MOUSE_MOTION && !draggedUiSetting.empty()) {
                    if (const auto* input = findScreenInputBySetting(tree, draggedUiSetting)) updateScreenInput(*input,float(e.motion.x),float(e.motion.y));
                    consumed = true;
                }
                if (consumed) continue;
            }
            if (e.type == SDL_EVENT_KEY_DOWN && e.key.scancode == SDL_SCANCODE_ESCAPE) {
                if (!activeScreen.empty() && activeScreen == "pause") { activeScreen.clear(); resetScreenFocus(); }
                else if (activeScreen.empty() && storyActive && gameScreens.contains("screens") && gameScreens["screens"].contains("pause")) { autoPlayActive = false; skipActive = false; activeScreen = "pause"; resetScreenFocus(); }
                else if (!activeScreen.empty() && !screenHistory.empty()) { activeScreen = screenHistory.back(); screenHistory.pop_back(); resetScreenFocus(); }
            } else if (!activeScreen.empty() && (e.type == SDL_EVENT_KEY_DOWN || e.type == SDL_EVENT_GAMEPAD_BUTTON_DOWN)) {
                const bool gamepad = e.type == SDL_EVENT_GAMEPAD_BUTTON_DOWN;
                const auto key = gamepad ? SDL_SCANCODE_UNKNOWN : e.key.scancode;
                const auto items = visibleScreenItems();
                if ((!gamepad && key == SDL_SCANCODE_TAB)) moveScreenFocus((e.key.mod & SDL_KMOD_SHIFT) ? -1 : 1,0,true);
                else if ((!gamepad && key == SDL_SCANCODE_UP) || (gamepad && e.gbutton.button == SDL_GAMEPAD_BUTTON_DPAD_UP)) moveScreenFocus(0,-1);
                else if ((!gamepad && key == SDL_SCANCODE_DOWN) || (gamepad && e.gbutton.button == SDL_GAMEPAD_BUTTON_DPAD_DOWN)) moveScreenFocus(0,1);
                else if ((!gamepad && key == SDL_SCANCODE_LEFT) || (gamepad && e.gbutton.button == SDL_GAMEPAD_BUTTON_DPAD_LEFT)) {
                    if (!screenFocusedSetting.empty()) adjustFocusedScreenControl(-1); else moveScreenFocus(-1,0);
                } else if ((!gamepad && key == SDL_SCANCODE_RIGHT) || (gamepad && e.gbutton.button == SDL_GAMEPAD_BUTTON_DPAD_RIGHT)) {
                    if (!screenFocusedSetting.empty()) adjustFocusedScreenControl(1); else moveScreenFocus(1,0);
                }
                else if ((!gamepad && (key == SDL_SCANCODE_RETURN || key == SDL_SCANCODE_SPACE)) || (gamepad && e.gbutton.button == SDL_GAMEPAD_BUTTON_SOUTH)) {
                    const auto targets = screenNavigationTargets();
                    auto selected = std::find_if(targets.begin(),targets.end(),[&](const auto& target){return !target.disabled && (screenFocusedSetting.empty()?(target.itemIndex==screenFocusedItem && target.nodeId==screenFocusedNodeKey):target.setting==screenFocusedSetting);});
                    if (selected == targets.end()) { moveScreenFocus(1,0,true); selected=std::find_if(targets.begin(),targets.end(),[&](const auto& target){return !target.disabled && (screenFocusedSetting.empty()?(target.itemIndex==screenFocusedItem && target.nodeId==screenFocusedNodeKey):target.setting==screenFocusedSetting);}); }
                    if (selected != targets.end()) {
                        if (!selected->setting.empty()) {
                            if (const auto* input=findScreenInputBySetting(currentScreen().at("uiTree"),selected->setting); input && input->value("attrs",json::object()).value("type",std::string{})=="checkbox") updateUiSetting(selected->setting,!uiSettingValues.value(selected->setting,false));
                        } else if (selected->itemIndex>=0 && selected->itemIndex<int(items.size())) activateScreenItem(items[size_t(selected->itemIndex)]);
                    }
                } else if (gamepad && e.gbutton.button == SDL_GAMEPAD_BUTTON_EAST && !screenHistory.empty()) {
                    activeScreen = screenHistory.back(); screenHistory.pop_back(); resetScreenFocus();
                }
            } else if (!activeScreen.empty() && e.type == SDL_EVENT_MOUSE_MOTION) {
                const auto items = visibleScreenItems(); screenHover = -1;
                for (size_t i = 0; i < items.size(); ++i) { const auto r = screenItemRect(items[i]); if (!items[i].value("disabled",false) && e.motion.x >= r.x && e.motion.x <= r.x + r.w && e.motion.y >= r.y && e.motion.y <= r.y + r.h) screenHover = int(i); }
            } else if (!activeScreen.empty() && e.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
                const auto items = visibleScreenItems();
                screenKeyboardFocus = false;
                for (size_t cursor = items.size(); cursor > 0; --cursor) { const size_t i = cursor - 1; const auto r = screenItemRect(items[i]); if (!items[i].value("disabled",false) && e.button.x >= r.x && e.button.x <= r.x + r.w && e.button.y >= r.y && e.button.y <= r.y + r.h) { screenHover = int(i); screenFocusedItem = int(i); screenFocusedNodeKey.clear(); screenFocusedSetting.clear(); activateScreenItem(items[i]); break; } }
            } else if (e.type == SDL_EVENT_KEY_DOWN) {
                if (options.empty()) { if (!holdActive) next = true; }
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
                    if (options.empty()) { if (!holdActive) next = true; }
                    else { const auto view = choiceViewport(); if (e.button.x >= view.x && e.button.x <= view.x + view.w && e.button.y >= view.y && e.button.y <= view.y + view.h) for (size_t i = 0; i < options.size(); ++i) { const auto box = choiceRect(i); if (e.button.x >= box.x && e.button.x <= box.x + box.w && e.button.y >= box.y && e.button.y <= box.y + box.h) selection = int(i); } }
                }
            }
        }
        const int cursorOption = std::clamp(int(std::lround(uiSettingValues.value("ui.cursorHideDelay",0.0)*3.0)),0,3);
        const Uint64 cursorDelay = cursorOption==1?5000:cursorOption==2?10000:cursorOption==3?20000:0;
        const bool shouldHideCursor = cursorDelay && storyActive && activeScreen.empty() && SDL_GetTicks()-lastMouseActivity>=cursorDelay;
        if (shouldHideCursor && !cursorHidden) { SDL_HideCursor(); cursorHidden=true; }
        else if (!shouldHideCursor && cursorHidden) { SDL_ShowCursor(); cursorHidden=false; }
        cleanupStoppedAudio();
        updateAnimatedTextures();
        if (video) { video->update(); if (video->finished) { video.reset(); videoAsset.clear(); if(visualOnlyKind=="video"){visualOnlyKind.clear();visualOnlyId.clear();} } }
        SDL_SetRenderDrawColor(renderer,12,15,22,255); SDL_RenderClear(renderer);
        if (visualOnlyKind == "video" && video) {
            float sourceWidth=0,sourceHeight=0; SDL_GetTextureSize(video->texture,&sourceWidth,&sourceHeight);
            const auto fit=native_player::videoContainRect(sourceWidth,sourceHeight,float(width),float(height));
            const float scaleX=float(width)/float(number("screen.width",1280)), scaleY=float(height)/float(number("screen.height",720));
            SDL_FRect rect{fit.x,fit.y,fit.width,fit.height};
            const float focusX=cameraFocusX*scaleX, focusY=cameraFocusY*scaleY;
            rect.x=focusX+(rect.x-focusX)*cameraZoom; rect.y=focusY+(rect.y-focusY)*cameraZoom; rect.w*=cameraZoom; rect.h*=cameraZoom;
            SDL_SetTextureAlphaModFloat(video->texture,videoOpacity); SDL_RenderTexture(renderer,video->texture,nullptr,&rect); SDL_SetTextureAlphaModFloat(video->texture,1.0f);
            lastRenderedCategories={"video"};
            SDL_RenderPresent(renderer); SDL_Delay(8); return;
        }
        if (!activeScreen.empty()) {
            const auto& screen = currentScreen();
            const auto screenMusic = screen.value("music", std::string{});
            if (!screenMusic.empty() && screenMusic != screenMusicAsset) { sound("bgm", screenMusic); screenMusicAsset = screenMusic; }
            struct ScreenLayerDraw { double layer; uint64_t order; std::function<void()> draw; };
            std::vector<ScreenLayerDraw> screenDraws;
            uint64_t screenSequence = 0;
            const auto enqueueScreen = [&](const std::string& category, std::optional<double> overrideValue, std::function<void()> draw) {
                screenDraws.push_back({renderLayer(category, overrideValue), screenSequence++, std::move(draw)});
            };
            if (background) enqueueScreen("background", backgroundLayer, [this] { SDL_RenderTexture(renderer, background, nullptr, nullptr); });
            for (const auto* item : native_player::spritesByVisualOrder(characters)) enqueueScreen("character", item->layer, [this,item] { sprite(*item); });
            for (const auto* item : native_player::spritesByVisualOrder(images)) enqueueScreen("image", item->layer, [this,item] { sprite(*item); });
            if (storyActive && !runtime.currentSceneName.empty() && visualOnlyKind.empty()) {
                if (number("ui.bottom_fog",1)) enqueueScreen("fog", std::nullopt, [this] { bottomFog(); });
                enqueueScreen("dialogue", std::nullopt, [this] { drawDialogueLayer(false); });
            }
            enqueueScreen("menu", std::nullopt, [this,&screen] {
                const auto bgName = screenBackground(screen);
                if (!bgName.empty()) drawScreenBackground(skinImage(bgName));
                else if (!screen.contains("uiTree")) { SDL_SetRenderDrawColor(renderer, 8, 12, 18, 175); SDL_RenderFillRect(renderer, nullptr); }
                const auto transform = screenCanvasTransform();
                const float sx = transform.sx, sy = transform.sy;
                const auto items = visibleScreenItems();
                if (screen.contains("uiTree")) {
                    for (const auto& node : screen.at("uiTree")) drawScreenNode(node,sx,sy,transform.ox,transform.oy,items);
                } else {
                    const auto title = screen.value("title", std::string{});
                    if (!title.empty()) label(title, transform.ox + 64 * sx, transform.oy + 42 * sy, int(34 * sy), {245,247,248,255}, float(width) - 128 * sx);
                    const auto description = screen.value("description", std::string{});
                    if (!description.empty()) label(description, transform.ox + 64 * sx, transform.oy + 112 * sy, int(21 * sy), {240,238,232,255}, std::min(560.0f, float(gameScreens.at("canvas").at("width").get<int>() - 128)) * sx, float(gameScreens.at("canvas").at("height").get<int>() - 150) * sy);
                    for (size_t i = 0; i < items.size(); ++i) {
                        const auto& item = items[i]; const auto rect = screenItemRect(item); const bool active = int(i) == screenHover;
                        const auto imageName = active ? item.value("hoverImage", item.value("image", std::string{})) : item.value("image", std::string{});
                        if (!imageName.empty()) SDL_RenderTexture(renderer, skinImage(imageName), nullptr, &rect);
                        else outlinedPanel(rect, active ? SDL_Color{44,61,73,240} : SDL_Color{17,24,31,215}, active ? SDL_Color{205,221,230,255} : SDL_Color{135,151,160,210}, active ? SDL_Color{197,219,230,255} : SDL_Color{100,119,130,220});
                        if (item.value("display", std::string{}) != "image") label(active ? item.value("hoverLabel", item.value("label", std::string{})) : item.value("label", std::string{}), rect.x + 12 * sx, rect.y + (rect.h - 28 * sy) / 2, int(item.value("fontSize", 22) * sy), {245,247,248,255}, rect.w - 24 * sx, rect.h);
                    }
                }
            });
            std::stable_sort(screenDraws.begin(), screenDraws.end(), [](const ScreenLayerDraw& left, const ScreenLayerDraw& right) {
                if (left.layer != right.layer) return left.layer < right.layer;
                return left.order < right.order;
            });
            for (auto& item : screenDraws) item.draw();
            if (!captureNextScreenFrame.empty()) {
                SDL_Surface* captured = SDL_RenderReadPixels(renderer, nullptr);
                if (!captured) throw std::runtime_error("Native画面のpixelを読み取れません: " + std::string(SDL_GetError()));
                const int saved = IMG_SavePNG(captured, utf8Path(captureNextScreenFrame).c_str());
                SDL_DestroySurface(captured);
                const auto target = captureNextScreenFrame;
                captureNextScreenFrame.clear();
                if (!saved) throw std::runtime_error("Native画面のcaptureを保存できません: " + utf8Path(target) + ": " + std::string(SDL_GetError()));
            }
            SDL_RenderPresent(renderer); SDL_Delay(8);
            if (automated) { activeScreen.clear(); titleStarted = true; }
            return;
        }
        struct LayerDraw { double layer; uint64_t order; std::function<void()> draw; };
        std::vector<LayerDraw> layerDraws;
        lastRenderedCategories.clear();
        uint64_t layerSequence = 0;
        const auto enqueue = [&](const std::string& category, std::optional<double> overrideValue, std::function<void()> draw) {
            layerDraws.push_back({renderLayer(category, overrideValue), layerSequence++, std::move(draw)});
            lastRenderedCategories.push_back(category);
        };
        if(visualOnlyKind.empty() || visualOnlyKind=="background") enqueue("background", backgroundLayer, [this] { renderBackground(); });
        if (video && (visualOnlyKind.empty() || visualOnlyKind=="video")) enqueue("video", videoLayer, [this] {
            float sourceWidth=0,sourceHeight=0; SDL_GetTextureSize(video->texture,&sourceWidth,&sourceHeight);
            const auto fit=native_player::videoContainRect(sourceWidth,sourceHeight,float(width),float(height));
            const float scaleX=float(width)/float(number("screen.width",1280)), scaleY=float(height)/float(number("screen.height",720));
            SDL_FRect rect{fit.x,fit.y,fit.width,fit.height};
            const float focusX=cameraFocusX*scaleX, focusY=cameraFocusY*scaleY;
            rect.x=focusX+(rect.x-focusX)*cameraZoom; rect.y=focusY+(rect.y-focusY)*cameraZoom; rect.w*=cameraZoom; rect.h*=cameraZoom;
            SDL_SetTextureAlphaModFloat(video->texture,videoOpacity); SDL_RenderTexture(renderer,video->texture,nullptr,&rect); SDL_SetTextureAlphaModFloat(video->texture,1.0f);
        });
        if(visualOnlyKind.empty() || visualOnlyKind=="character") for (const auto* item : native_player::spritesByVisualOrder(characters)) {
            if(visualOnlyKind!="character" || item->asset==visualOnlyId) enqueue("character", item->layer, [this,item] { sprite(*item); });
        }
        if(visualOnlyKind.empty() || visualOnlyKind=="image") for (const auto* item : native_player::spritesByVisualOrder(images)) {
            if(visualOnlyKind!="image" || item->asset==visualOnlyId) enqueue("image", item->layer, [this,item] { sprite(*item); });
        }
        if (visualOnlyKind.empty() && number("ui.bottom_fog", 1)) enqueue("fog", std::nullopt, [this] { bottomFog(); });
        if (visualOnlyKind!="video" && dialogueVisible) enqueue("dialogue", std::nullopt, [this] { drawDialogueLayer(false); });
        if (visualOnlyKind!="video") enqueue("controls", std::nullopt, [this] { drawPlayerControls(); });
        if (overlay>0 && visualOnlyKind!="video") enqueue("menu", std::nullopt, [this] { SDL_SetRenderDrawColor(renderer,overlayColor.r,overlayColor.g,overlayColor.b,Uint8(255*overlay)); SDL_RenderFillRect(renderer,nullptr); });
        std::stable_sort(layerDraws.begin(), layerDraws.end(), [](const LayerDraw& left, const LayerDraw& right) {
            if (left.layer != right.layer) return left.layer < right.layer;
            return left.order < right.order;
        });
        for (auto& item : layerDraws) item.draw();
        if (runtime.currentSceneName.size() && activeScreen.empty()) {
            SDL_Surface* pixels=SDL_RenderReadPixels(renderer,nullptr);
            if(pixels){
                SDL_Surface* scaled=SDL_ScaleSurface(pixels,320,180,SDL_SCALEMODE_LINEAR);
                SDL_DestroySurface(pixels);
                if(scaled){ if(lastStoryFrame) SDL_DestroySurface(lastStoryFrame); lastStoryFrame=scaled; }
            }
        }
        if (!saveNotice.empty() && SDL_GetTicks() < saveNoticeUntil) {
            SDL_FRect notice{float(width) * 0.15f, float(height) - 64.0f, float(width) * 0.7f, 42.0f};
            SDL_SetRenderDrawBlendMode(renderer, SDL_BLENDMODE_BLEND);
            SDL_SetRenderDrawColor(renderer, 48, 20, 24, 238);
            SDL_RenderFillRect(renderer, &notice);
            label(saveNotice, notice.x + 12.0f, notice.y + 8.0f, 18, {255, 235, 235, 255}, notice.w - 24.0f, notice.h - 12.0f);
            if (!captureSaveNoticeFrame.empty()) {
                SDL_Surface* captured = SDL_RenderReadPixels(renderer, nullptr);
                if (!captured) throw std::runtime_error("Could not capture the Native save notice: " + std::string(SDL_GetError()));
                const auto destination = captureSaveNoticeFrame;
                captureSaveNoticeFrame.clear();
                const int saved = IMG_SavePNG(captured, utf8Path(destination).c_str());
                SDL_DestroySurface(captured);
                if (!saved) throw std::runtime_error("Could not save the Native save notice capture: " + utf8Path(destination) + ": " + SDL_GetError());
            }
        }
        SDL_RenderPresent(renderer); SDL_Delay(8);
    }
    void delay(int64_t ms, std::function<void(float)> animate = {}) {
        if (ms<0 || ms>2147483647) throw std::runtime_error("時間の指定が不正です");
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
    void parallel(const json& batch) {
        const auto savedCharacters = characters;
        const auto savedBackground = background;
        const auto savedPreviousBackground = previousBackground;
        const auto savedBackgroundAsset = backgroundAsset;
        const auto savedBackgroundLayer = backgroundLayer;
        const auto savedBackgroundOffsetX = backgroundOffsetX, savedBackgroundOffsetY = backgroundOffsetY;
        const auto savedPreviousBackgroundOffsetX = previousBackgroundOffsetX, savedPreviousBackgroundOffsetY = previousBackgroundOffsetY;
        const auto savedBackgroundTransitionProgress = backgroundTransitionProgress;
        const auto savedBackgroundTransitionType = backgroundTransitionType;
        const auto savedCameraZoom = cameraZoom, savedCameraFocusX = cameraFocusX, savedCameraFocusY = cameraFocusY;
        const auto savedVisualOnlyKind = visualOnlyKind, savedVisualOnlyId = visualOnlyId;
        const auto savedOverlay = overlay;
        const auto savedOverlayColor = overlayColor;
        const auto savedNextVisualOrder = nextVisualOrder;
        const auto savedLogicalTimeMs = logicalTimeMs;
        struct Rollback {
            std::function<void()> restore;
            bool committed = false;
            ~Rollback() { if (!committed) restore(); }
        } rollback{[&] {
            characters = savedCharacters;
            background = savedBackground; previousBackground = savedPreviousBackground;
            backgroundAsset = savedBackgroundAsset; backgroundLayer = savedBackgroundLayer;
            backgroundOffsetX = savedBackgroundOffsetX; backgroundOffsetY = savedBackgroundOffsetY;
            previousBackgroundOffsetX = savedPreviousBackgroundOffsetX; previousBackgroundOffsetY = savedPreviousBackgroundOffsetY;
            backgroundTransitionProgress = savedBackgroundTransitionProgress; backgroundTransitionType = savedBackgroundTransitionType;
            cameraZoom = savedCameraZoom; cameraFocusX = savedCameraFocusX; cameraFocusY = savedCameraFocusY;
            visualOnlyKind = savedVisualOnlyKind; visualOnlyId = savedVisualOnlyId;
            overlay = savedOverlay; overlayColor = savedOverlayColor;
            nextVisualOrder = savedNextVisualOrder; logicalTimeMs = savedLogicalTimeMs;
        }};
        std::vector<ParallelTrack> tracks;
        std::vector<std::function<void()>> finish;
        int64_t maximumDuration = 0;
        const bool effectsEnabled = uiSettingValues.value("ui.effects", true);
        auto asText = [](const json& args, size_t index) { return args.at(index).get<std::string>(); };
        auto timed = [&](int64_t duration, std::function<void(float)> update) {
            if (duration < 0 || duration > 2147483647) throw std::runtime_error("parallel animation の時間指定が不正です");
            maximumDuration = std::max(maximumDuration, duration);
            tracks.push_back({duration, std::move(update), false});
        };
        for (const auto& item : batch) {
            const auto name = item.at("name").get<std::string>();
            const auto args = item.at("args");
            if (!args.is_array() || args.empty()) throw std::runtime_error("parallel のvisual commandが不正です");
            if (name == "bg") {
                const auto id = resolveAssetId("bg", asText(args, 0));
                auto* incoming = image(asset("bg", id));
                size_t index = 1; std::string transition = "instant"; int64_t duration = 0;
                if (index < args.size() && args.at(index).is_string() && asText(args, index) != "--only" && asText(args, index) != "--layer") {
                    transition = asText(args, index++);
                if (index >= args.size() || !args.at(index).is_number_integer()) throw std::runtime_error("background transition の時間は整数のmsで指定してください");
                    duration = args.at(index++).get<int64_t>();
                }
                if (transition == "instant" || !duration) throw std::runtime_error("parallel のbackground変更には時間指定のあるtransitionが必要です");
                if (!effectsEnabled) duration=0;
                if (transition != "fade" && transition != "crossfade" && transition != "wipe-left" && transition != "wipe-right" && transition != "wipe-up" && transition != "wipe-down") throw std::runtime_error("parallel のbackground transitionが不正です");
                previousBackground = background; previousBackgroundOffsetX = backgroundOffsetX; previousBackgroundOffsetY = backgroundOffsetY;
                background = incoming; backgroundAsset = id; backgroundLayer = commandLayer(args); backgroundOffsetX = backgroundOffsetY = 0;
                visualOnlyKind.clear(); visualOnlyId.clear();
                backgroundTransitionType = transition; backgroundTransitionProgress = 0.0f;
                timed(duration, [this](float progress) { backgroundTransitionProgress = progress; });
                finish.push_back([this] { previousBackground = nullptr; backgroundTransitionProgress = 1.0f; backgroundTransitionType.clear(); });
            } else if (name == "camera") {
                float fromZoom = cameraZoom, fromX = cameraFocusX, fromY = cameraFocusY;
                float toZoom = 1.0f, toX = 640.0f, toY = 360.0f; int64_t duration = 0;
                if (asText(args, 0) == "reset") { if (args.size() == 3 && asText(args, 1) == "over") duration = args.at(2).get<int64_t>(); }
                else { toZoom = args.at(1).get<float>(); toX = args.at(3).get<float>(); toY = args.at(4).get<float>(); duration = args.at(6).get<int64_t>(); }
                if (duration < 0 || duration > 2147483647 || !std::isfinite(toZoom) || toZoom < 0.1f || toZoom > 8.0f) throw std::runtime_error("parallel camera の duration または zoom が範囲外です");
                if (!effectsEnabled) duration=0;
                timed(duration, [this, fromZoom, fromX, fromY, toZoom, toX, toY](float t) { cameraZoom=fromZoom+(toZoom-fromZoom)*t; cameraFocusX=fromX+(toX-fromX)*t; cameraFocusY=fromY+(toY-fromY)*t; });
            } else if (name == "move") {
                const bool character = asText(args, 0) == "character";
                if (!character && asText(args, 0) != "bg") throw std::runtime_error("parallel ではcharacterとbackgroundの移動のみ使用できます");
                const auto id = character ? asText(args, 1) : std::string{};
                auto found = character ? characters.find(id) : characters.end();
                if (character && found == characters.end()) throw std::runtime_error("parallel の移動対象characterが表示されていません: " + id);
                if (!character && !background) throw std::runtime_error("parallel の移動対象backgroundが設定されていません");
                if (asText(args, character ? 2 : 1) != "by") throw std::runtime_error("parallel の移動ではoffsetの前に by を指定してください");
                float dx=0, dy=0; bool hasX=false,hasY=false; size_t index=character?3:2;
                for (; index < args.size(); ++index) {
                    if (!args.at(index).is_string()) break;
                    const auto option = asText(args,index);
                    if (option == "over") break;
                    if (option.size()<2 || (option[0]!='x'&&option[0]!='y') || (option[1]!='+'&&option[1]!='-')) throw std::runtime_error("parallel のmove offset指定が不正です");
                    const bool x = option[0]=='x'; if ((x&&hasX)||(!x&&hasY)) throw std::runtime_error("parallel のmoveで同じ軸が重複しています");
                    double amount=0;
                    if (option.size()==2) { if (++index>=args.size()||!args.at(index).is_number()) throw std::runtime_error("parallel のmove offset指定が不正です"); amount=args.at(index).get<double>(); }
                    else { int64_t value=0; const auto parsed=std::from_chars(option.data()+2,option.data()+option.size(),value); if(parsed.ec!=std::errc{}||parsed.ptr!=option.data()+option.size())throw std::runtime_error("parallel のmove offset指定が不正です"); amount=double(value); }
                    if (!std::isfinite(amount)||std::abs(amount)>1000000) throw std::runtime_error("parallel のmove offsetは絶対値1000000以内で指定してください");
                    (x?dx:dy)=(option[1]=='-'?-1:1)*float(amount); if(x)hasX=true;else hasY=true;
                }
                if (!hasX&&!hasY || index+1>=args.size() || asText(args,index)!="over") throw std::runtime_error("parallel のmoveにはoffsetと over <ms> の指定が必要です");
                const int64_t duration=args.at(index+1).get<int64_t>();
                const float fromX=character?found->second.offsetX:backgroundOffsetX, fromY=character?found->second.offsetY:backgroundOffsetY;
                const float toX=fromX+dx,toY=fromY+dy;
                if(std::abs(toX)>1000000||std::abs(toY)>1000000)throw std::runtime_error("parallel の移動量は1000000px以内で指定してください");
                if(character) { timed(duration,[this,id,fromX,fromY,toX,toY](float t){auto it=characters.find(id);if(it!=characters.end()){it->second.offsetX=fromX+(toX-fromX)*t;it->second.offsetY=fromY+(toY-fromY)*t;}}); }
                else timed(duration,[this,fromX,fromY,toX,toY](float t){backgroundOffsetX=fromX+(toX-fromX)*t;backgroundOffsetY=fromY+(toY-fromY)*t;});
            } else if (name == "show") {
                const auto reference=asText(args,0); const auto dot=reference.find('.');
                if(dot==std::string::npos) throw std::runtime_error("parallel のshowにはcharacter.pose形式でcharacterのposeを指定してください");
                const auto id=reference.substr(0,dot), pose=reference.substr(dot+1); const auto position=asText(args,1);
                float offsetX=0,offsetY=poseYOffset(id,pose); size_t index=2;
                for(;index<args.size();++index) {
                    if(!args.at(index).is_string())break; const auto option=asText(args,index); if(option=="fade")break;
                    if(option.size()<2||(option[0]!='x'&&option[0]!='y')||(option[1]!='+'&&option[1]!='-'))break;
                    const bool x=option[0]=='x'; double amount=0;
                    if(option.size()==2){if(++index>=args.size()||!args.at(index).is_number())throw std::runtime_error("show のoffset指定が不正です");amount=args.at(index).get<double>();}
                    else {int64_t value=0;const auto parsed=std::from_chars(option.data()+2,option.data()+option.size(),value);if(parsed.ec!=std::errc{}||parsed.ptr!=option.data()+option.size())throw std::runtime_error("show のoffset指定が不正です");amount=double(value);}
                    (x?offsetX:offsetY)+=(option[1]=='-'?-1:1)*float(amount);
                }
                if(index+1>=args.size()||asText(args,index)!="fade")throw std::runtime_error("parallel のcharacter表示には fade <ms> の指定が必要です");
                auto* texture=image(asset("char",id,pose)); const auto slot=position;
                for(auto it=characters.begin();it!=characters.end();) { if(it->first!=id&&it->second.position==slot)it=characters.erase(it);else ++it; }
                const auto existing=characters.find(id); const auto order=existing==characters.end()?++nextVisualOrder:existing->second.visualOrder;
                Sprite sprite; sprite.texture=texture;sprite.position=slot;sprite.asset=id;sprite.pose=pose;sprite.offsetX=offsetX;sprite.offsetY=offsetY;sprite.alpha=0;sprite.visualOrder=order;sprite.layer=commandLayer(args);characters[id]=std::move(sprite);
                visualOnlyKind.clear(); visualOnlyId.clear();
                int64_t duration=args.at(index+1).get<int64_t>(); if(!effectsEnabled)duration=0; timed(duration,[this,id](float t){auto it=characters.find(id);if(it!=characters.end())it->second.alpha=t;});
            } else if (name == "hide") {
                const auto id=asText(args,0); auto found=characters.find(id);
                if(found==characters.end()||args.size()<3||asText(args,1)!="fade")throw std::runtime_error("parallel のhideには表示中のcharacterと fade <ms> の指定が必要です");
                const float from=found->second.alpha; int64_t duration=args.at(2).get<int64_t>(); if(!effectsEnabled)duration=0;
                timed(duration,[this,id,from](float t){auto it=characters.find(id);if(it!=characters.end())it->second.alpha=from*(1-t);});
                visualOnlyKind.clear(); visualOnlyId.clear();
                finish.push_back([this,id]{characters.erase(id);});
            } else if (name == "effect") {
                if(asText(args,0)!="fade"||args.size()<2)throw std::runtime_error("parallel では fade effect のみ使用できます");
                overlayColor=asText(args,1)=="white"?SDL_Color{255,255,255,255}:SDL_Color{0,0,0,255}; overlay=1;
                int64_t duration=args.size()>2?args.at(2).get<int64_t>():500; if(!effectsEnabled)duration=0;
                timed(duration,[this](float t){overlay=1-t;});
            } else throw std::runtime_error("parallel では時間指定のvisual commandのみ使用できます: "+name);
        }
        const auto start=SDL_GetTicks();
        do {
            const auto elapsed=SDL_GetTicks()-start;
            for(auto& track:tracks) {
                const float progress = track.duration ? std::min(1.0f,float(elapsed)/float(track.duration)) : 1.0f;
                track.update(progress);
            }
            // Sample only after every track has been updated for this SDL tick.
            // The former narrow progress window could be skipped by a frame and
            // also captured a partial state before later tracks were applied.
            for(auto& track:tracks) {
                const float progress = track.duration ? std::min(1.0f,float(elapsed)/float(track.duration)) : 1.0f;
                if(captureAnimationMidpoints && !track.midpointCaptured && track.duration
                   && track.previousProgress < 0.5f && progress >= 0.5f && progress < 1.0f) {
                    animationMidpoints.push_back({{"durationMs",track.duration},{"progress",progress},{"sampleElapsedMs",elapsed},
                        {"backgroundProgress",backgroundTransitionProgress},{"state",presentationSnapshot()},
                        {"bgmProgress",currentBgmProgress()},{"bgmLayers",activeBgmGains()}});
                    track.midpointCaptured = true;
                }
                track.previousProgress = progress;
            }
            pump();
        } while(SDL_GetTicks()-start<uint64_t(maximumDuration));
        for(const auto& track:tracks) track.update(1.0f);
        for(const auto& action:finish) action();
        logicalTimeMs+=uint64_t(maximumDuration);
        rollback.committed = true;
    }
    void revealDialogueText() {
        const double speed = std::clamp(uiSettingValues.value("ui.textSpeed",1.0),0.0,1.0);
        const int interval = int(std::lround((1.0-speed)*48.0));
        if (interval <= 0 || text.empty()) return;
        const std::string complete = text;
        text.clear(); next = false;
        size_t end = 0;
        while (end < complete.size()) {
            const auto lead = static_cast<unsigned char>(complete[end]);
            const size_t width = lead < 0x80 ? 1 : (lead & 0xe0) == 0xc0 ? 2 : (lead & 0xf0) == 0xe0 ? 3 : 4;
            end = std::min(complete.size(), end + width);
            text.assign(complete, 0, end);
            const auto started = SDL_GetTicks();
            while (SDL_GetTicks() - started < Uint64(interval)) {
                while (!activeScreen.empty()) pump();
                if (next) { text = complete; next = false; return; }
                pump();
            }
            if (next) { text = complete; next = false; return; }
        }
        text = complete;
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
    MIX_Track* sound(const std::string& type,const std::string& id,int64_t crossfadeMs=0,bool pinned=false,float requestedGain=-1.0f,const std::string& voiceCharacter={}) {
        // Keep existing BGM layers until the replacement track has started,
        // for both instant switches and crossfades. A failed candidate must
        // never leave the scene state claiming that a stopped track is active.
        auto* a=MIX_LoadAudio(mixer,utf8Path(asset(type,id)).c_str(),true); if(!a) throw std::runtime_error(SDL_GetError());
        auto* track=MIX_CreateTrack(mixer);
        if(!track) { MIX_DestroyAudio(a); throw std::runtime_error(SDL_GetError()); }
        if(!MIX_SetTrackAudio(track,a)) { const auto error=SDL_GetError(); MIX_DestroyTrack(track); MIX_DestroyAudio(a); throw std::runtime_error(error); }
        const float gain = requestedGain < 0 ? configuredAudioVolume(type,id) : requestedGain;
        if (!std::isfinite(gain) || gain < 0 || gain > 1) { MIX_DestroyTrack(track); MIX_DestroyAudio(a); throw std::runtime_error("音量は0.0から1.0の範囲で指定してください"); }
        const std::string channel = type == "bgm" ? "bgm" : type == "voice" ? "voice" : "se";
        const float playbackGain = gain * (type == "voice" ? voiceCharacterGain(voiceCharacter) : 1.0f);
        if (!MIX_SetTrackGain(track, playbackGain * uiSettingGain(channel))) { const auto error=SDL_GetError(); MIX_DestroyTrack(track); MIX_DestroyAudio(a); throw std::runtime_error(error); }
        const std::string tag = "ui_" + channel;
        if (!MIX_TagTrack(track, tag.c_str())) { const auto error=SDL_GetError(); MIX_DestroyTrack(track); MIX_DestroyAudio(a); throw std::runtime_error(error); }
        auto props=SDL_CreateProperties();
        if(!props) { const auto error=SDL_GetError(); MIX_DestroyTrack(track); MIX_DestroyAudio(a); throw std::runtime_error(error); }
        if(type=="bgm") {SDL_SetNumberProperty(props,MIX_PROP_PLAY_LOOPS_NUMBER,-1);if(crossfadeMs>0)SDL_SetNumberProperty(props,MIX_PROP_PLAY_FADE_IN_MILLISECONDS_NUMBER,crossfadeMs);}
        const auto fadeFrames = type=="bgm" && crossfadeMs>0 ? MIX_TrackMSToFrames(track,crossfadeMs) : 0;
        audio.push_back({track,a,type=="bgm",pinned,type,id,fadeFrames,
            type=="bgm" && crossfadeMs>0 ? 0.0f : playbackGain, playbackGain, voiceCharacter, gain});
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
        if(type=="voice") { lastVoiceAsset=id; lastVoiceCharacter=voiceCharacter; }
        return track;
    }
    void command(const std::string& name,const json& args) {
        auto s=[&](size_t i){return args.at(i).get<std::string>();};
        auto pixelOffset=[&](const std::string& option,size_t& index) -> float {
            if(option.size()<2 || (option[0]!='x' && option[0]!='y') || (option[1]!='+' && option[1]!='-')) throw std::runtime_error("pixel offsetの指定が不正です");
            double amount=0;
            if(option.size()==2) {
                if(++index>=args.size() || !args.at(index).is_number()) throw std::runtime_error("pixel offsetの値が不正です");
                amount=args.at(index).get<double>();
            } else {
                int64_t integer=0;
                const auto parsed=std::from_chars(option.data()+2,option.data()+option.size(),integer);
                if(parsed.ec!=std::errc{} || parsed.ptr!=option.data()+option.size()) throw std::runtime_error("pixel offsetの指定が不正です");
                amount=double(integer);
            }
            if(!std::isfinite(amount) || std::abs(amount)>1000000) throw std::runtime_error("pixel offsetは絶対値1000000以内で指定してください");
            return float(option[1]=='-'?-amount:amount);
        };
        if(name=="layer") {
            if(args.size()!=2 || !args.at(0).is_string()) throw std::runtime_error("layerにはcategoryと値を指定してください");
            const auto category=s(0); const auto value=checkedRenderLayer(args.at(1));
            if(!renderLayers.contains(category)) throw std::runtime_error("layer \u306f\u65e2\u77e5\u306e\u5206\u985e\u306b\u5bfe\u3057\u30660\u301c8\u672a\u6e80\u306e\u7bc4\u56f2\u30670.001\u523b\u307f\u306b\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044");
            renderLayers[category]=value;
        }
        else if(name=="volume") {
            const auto kind=s(0); const float gain=args.at(1).get<float>();
            if((kind!="bgm" && kind!="se" && kind!="voice") || !std::isfinite(gain) || gain<0 || gain>1) throw std::runtime_error("音量またはchannelの指定が不正です");
            audioVolumeOverrides[kind]=gain;
        }
        else if(name=="dialog") {
            if(s(0)=="visible") { if(args.size()!=2 || !args.at(1).is_boolean()) throw std::runtime_error("dialog visibleにはboolean値を指定してください"); dialogueVisible=args.at(1).get<bool>(); }
            else if(s(0)=="opacity") { if(args.size()!=2) throw std::runtime_error("dialog opacityには小数値を指定してください"); const float opacity=args.at(1).get<float>(); if(!std::isfinite(opacity)||opacity<0||opacity>1) throw std::runtime_error("dialog opacityは0から1の範囲で指定してください"); config["dialog.opacity"]=std::to_string(opacity); }
            else throw std::runtime_error("dialogの設定項目が不正です");
        }
        else if(name=="say") {
            const float previousOpacity=dialogueOpacityOverride;
            if(args.size()==4) {
                const float opacity=args.at(3).get<float>();
                if(s(2)!="opacity" || !std::isfinite(opacity) || opacity<0 || opacity>1) throw std::runtime_error("行ごとのdialog opacity指定が不正です");
                dialogueOpacityOverride=opacity;
            }
            speaker=(s(0)=="none" || s(0)=="narrator") ? "" : s(0);
            if(!speaker.empty()) {
                try { auto actor=runtime.get(speaker); if(actor.is_object() && actor.contains("name") && actor.at("name").is_string())speaker=actor.at("name").get<std::string>(); }
                catch(const std::runtime_error&) {}
            }
            const auto lineKey = runtime.currentSourceFile + ":" + std::to_string(runtime.currentLine);
            const bool firstVisit = seenSayLines.insert(lineKey).second;
            try {
                text=runtime.interpolate(args.at(1));
                dialogueHistory.emplace_back(speaker, text);
                if (dialogueHistory.size() > 500) dialogueHistory.erase(dialogueHistory.begin());
                dialogueHistoryScroll = 0;
                if (skipActive) {
                    const bool onlyRead = uiSettingValues.value("ui.skipUnseen",true);
                    if (!onlyRead || !firstVisit) { next=true; dialogueOpacityOverride=previousOpacity; return; }
                    skipActive=false;
                }
                revealDialogueText();
                if (autoPlayActive && !automated) {
                    const double speed = uiSettingValues.value("ui.autoSpeed",0.45);
                    const auto waitMs = static_cast<int64_t>(std::lround(8500.0 - std::clamp(speed,0.0,1.0)*7600.0));
                    delay(waitMs);
                    if (autoPlayActive) next=true;
                } else { next=false; if(automated)pump();else while(!next && !runtime.pendingLoad.is_object())pump(); }
            }
            catch(...) { dialogueOpacityOverride=previousOpacity; throw; }
            dialogueOpacityOverride=previousOpacity;
        }
        else if(name=="wait") delay(args.at(0).get<int64_t>());
        else if(name=="bg") {
            const auto assetName=resolveAssetId("bg",s(0)); auto* incoming=image(asset("bg",assetName));
            const bool only=std::find_if(args.begin(),args.end(),[](const json& value){return value.is_string()&&value.get<std::string>()=="--only";})!=args.end();
            const auto nextLayer=commandLayer(args);
            size_t i=1; std::string transition="instant"; int64_t duration=0;
            if(i<args.size() && args.at(i).is_string() && s(i)!="--only" && s(i)!="--layer") { transition=s(i++); if(i>=args.size() || !args.at(i).is_number_integer()) throw std::runtime_error("background transitionの時間は整数のmsで指定してください"); duration=args.at(i++).get<int64_t>(); }
            while(i<args.size()) { if(s(i)=="--only") { ++i; continue; } if(s(i)=="--layer") { i+=2; continue; } throw std::runtime_error("background optionの指定が不正です"); }
            if(duration<0 || duration>2147483647 || (transition!="instant"&&transition!="fade"&&transition!="crossfade"&&transition!="wipe-left"&&transition!="wipe-right"&&transition!="wipe-up"&&transition!="wipe-down")) throw std::runtime_error("background transitionの指定が不正です");
            previousBackground=background; previousBackgroundOffsetX=backgroundOffsetX; previousBackgroundOffsetY=backgroundOffsetY;
            background=incoming; backgroundAsset=assetName; backgroundLayer=nextLayer; backgroundOffsetX=backgroundOffsetY=0;
            visualOnlyKind=only?"background":""; visualOnlyId=backgroundAsset;
            const bool animateTransition=duration>0 && uiSettingValues.value("ui.effects",true);
            backgroundTransitionType=transition; backgroundTransitionProgress=animateTransition?0.0f:1.0f;
            if(animateTransition) delay(duration,[&](float t){backgroundTransitionProgress=t;});
            previousBackground=nullptr; backgroundTransitionProgress=1.0f; backgroundTransitionType.clear();
        }
        else if(name=="camera") {
            const float fromZoom=cameraZoom, fromX=cameraFocusX, fromY=cameraFocusY;
            float toZoom=1.0f,toX=640.0f,toY=360.0f; int64_t duration=0;
            if(s(0)=="reset") { if(args.size()==3&&s(1)=="over") duration=args.at(2).get<int64_t>(); else if(args.size()!=1) throw std::runtime_error("camera resetのsyntaxが不正です"); }
            else { if(args.size()!=5&&args.size()!=7) throw std::runtime_error("cameraのsyntaxが不正です"); toZoom=args.at(1).get<float>();toX=args.at(3).get<float>();toY=args.at(4).get<float>(); if(args.size()==7){if(s(5)!="over") throw std::runtime_error("camera durationの指定が不正です");duration=args.at(6).get<int64_t>();} }
            if(!std::isfinite(toZoom)||toZoom<0.1f||toZoom>8.0f||duration<0||duration>2147483647) throw std::runtime_error("cameraの設定値が不正です");
            auto apply=[&](float t){cameraZoom=fromZoom+(toZoom-fromZoom)*t;cameraFocusX=fromX+(toX-fromX)*t;cameraFocusY=fromY+(toY-fromY)*t;};
            if(duration&&uiSettingValues.value("ui.effects",true)) delay(duration,apply); else apply(1.0f);
        }
        else if(name=="bgm") sound("bgm",s(0));
        else if(name=="play") {
            if(s(0)=="video") {
                const auto videoId=resolveAssetId("video",s(1));
                video=std::make_unique<Video>(renderer,utf8Path(asset("video",videoId))); videoAsset=videoId;
                videoOpacity=1.0f;
                videoLayer=commandLayer(args);
                for(size_t i=2;i<args.size();) { const auto option=s(i++); if(option=="opacity") { if(i>=args.size()) throw std::runtime_error("video opacityが指定されていません"); videoOpacity=args.at(i++).get<float>(); if(!std::isfinite(videoOpacity)||videoOpacity<0||videoOpacity>1) throw std::runtime_error("video opacityが不正です"); } else if(option=="--layer") { if(i>=args.size()) throw std::runtime_error("video layerが指定されていません"); ++i; } else if(option!="async"&&option!="blocking"&&option!="--only") throw std::runtime_error("video optionの指定が不正です"); }
                visualOnlyKind=std::find_if(args.begin()+std::min<size_t>(2,args.size()),args.end(),[](const json& value){return value.is_string() && value.get<std::string>()=="--only";})!=args.end()?"video":"";
                visualOnlyId=videoId;
                const bool blocking = std::none_of(args.begin()+std::min<size_t>(2,args.size()),args.end(),[](const json& value){return value.is_string() && value.get<std::string>()=="async";});
                videoBlocksStory = blocking;
                if(blocking) { while(video)pump(); videoBlocksStory = false; }
            }
            else if(s(0)=="bgm") {
                int64_t crossfadeMs=0;
                float gain=-1.0f;
                for(size_t i=2;i<args.size();) {
                    const auto option=s(i++);
                    if(option=="crossfade") { if(i>=args.size()) throw std::runtime_error("BGM crossfadeのdurationが指定されていません"); crossfadeMs=args.at(i++).get<int64_t>(); if(crossfadeMs<0 || crossfadeMs>2147483647) throw std::runtime_error("BGM crossfadeのdurationが不正です"); }
                    else if(option=="volume") { if(i>=args.size()) throw std::runtime_error("BGM volumeが指定されていません"); gain=args.at(i++).get<float>(); }
                    else throw std::runtime_error("BGM optionの指定が不正です");
                }
                sound("bgm",s(1),crossfadeMs,false,gain);
            } else {
                const auto kind=s(0); bool blockingVoice=false; float gain=-1.0f; std::string voiceCharacter;
                for(size_t i=2;i<args.size();) { const auto option=s(i++); if(option=="volume") { if(i>=args.size()) throw std::runtime_error("volumeが指定されていません"); gain=args.at(i++).get<float>(); } else if(option=="character") { if(i>=args.size()) throw std::runtime_error("voiceのcharacterが指定されていません"); voiceCharacter=s(i++); } else if(option=="blocking" || option=="async") blockingVoice=option=="blocking"; else throw std::runtime_error("voice optionの指定が不正です"); }
                auto* track=sound(kind,s(1),0,blockingVoice,gain,voiceCharacter);
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
            if(!isCharacter && kind!="bg") throw std::runtime_error("moveの対象にはcharacterまたは bg を指定してください");
            const auto id=isCharacter?s(1):std::string("bg");
            const size_t offsetStart=isCharacter?3:2;
            if(s(isCharacter?2:1)!="by") throw std::runtime_error("moveではpixel offsetの前に by を指定してください");
            Sprite* actor=nullptr;
            if(isCharacter) {
                const auto found=characters.find(id);
                if(found==characters.end()) throw std::runtime_error("moveの対象characterが表示されていません: "+id);
                actor=&found->second;
            } else if(!background) throw std::runtime_error("moveの対象backgroundが設定されていません");
            float dx=0,dy=0; bool hasX=false,hasY=false;
            size_t index=offsetStart;
            for(;index<args.size();++index) {
                if(!args.at(index).is_string()) break;
                const auto option=args.at(index).get<std::string>();
                if(option=="over") break;
                if(option.size()<2 || (option[0]!='x' && option[0]!='y') || (option[1]!='+' && option[1]!='-')) throw std::runtime_error("moveのpixel offset指定が不正です");
                const bool isX=option[0]=='x';
                if((isX && hasX)||(!isX && hasY)) throw std::runtime_error("moveで同じpixel offset軸が重複しています");
                const float value=pixelOffset(option,index);
                if(isX) {dx=value;hasX=true;} else {dy=value;hasY=true;}
            }
            if(!hasX&&!hasY) throw std::runtime_error("moveにはpixel offsetを1つ以上指定してください");
            int64_t duration=0;
            if(index<args.size()) {
                if(index+2!=args.size() || s(index)!="over") throw std::runtime_error("move durationの指定が不正です。over <ms> の形式で指定してください");
                duration=args.at(index+1).get<int64_t>();
            }
            if(duration<0 || duration>2147483647) throw std::runtime_error("move command の duration は0〜2147483647 msの範囲で指定してください。");
            const float fromX=isCharacter?actor->offsetX:backgroundOffsetX;
            const float fromY=isCharacter?actor->offsetY:backgroundOffsetY;
            const float toX=fromX+float(dx),toY=fromY+float(dy);
            if(std::abs(toX)>1000000 || std::abs(toY)>1000000) throw std::runtime_error("moveの移動量は1000000px以内で指定してください");
            auto apply=[&](float t) {
                if(isCharacter) { actor->offsetX=fromX+(toX-fromX)*t; actor->offsetY=fromY+(toY-fromY)*t; }
                else { backgroundOffsetX=fromX+(toX-fromX)*t; backgroundOffsetY=fromY+(toY-fromY)*t; }
            };
            if(duration) delay(duration,apply); else apply(1);
        } else if(name=="show") {
            const bool only=std::find_if(args.begin(),args.end(),[](const json& value){return value.is_string() && value.get<std::string>()=="--only";})!=args.end();
            if(s(0)=="image") {
                visualOnlyKind=only?"image":""; visualOnlyId=s(1);
                Sprite sprite; sprite.texture=image(asset("image",s(1))); sprite.position=s(2); sprite.asset=s(1); sprite.visualOrder=++nextVisualOrder; sprite.layer=commandLayer(args);
                images[s(1)]=std::move(sprite);
            }
            else {
                const auto dot=s(0).find('.');
                if(dot==std::string::npos) throw std::runtime_error("showには character.pose または画像IDを指定してください");
                const auto id=s(0).substr(0,dot), pose=s(0).substr(dot+1);
                visualOnlyKind=only?"character":""; visualOnlyId=id;
                const auto position=s(1);
                float offsetX=0,offsetY=0; bool hasX=false,hasY=false;
                size_t transitionIndex=2;
                for(;transitionIndex<args.size();++transitionIndex) {
                    if(!args.at(transitionIndex).is_string()) break;
                    const auto option=args.at(transitionIndex).get<std::string>();
                    if(option.size()<2 || (option[0]!='x' && option[0]!='y') || (option[1]!='+' && option[1]!='-')) break;
                    if(option[0]=='x' ? hasX : hasY) throw std::runtime_error("showで同じpixel offset軸が重複しています");
                    const float value=pixelOffset(option,transitionIndex);
                    if(option[0]=='x') hasX=true; else hasY=true;
                    if(option[0]=='x') offsetX=value; else offsetY=value;
                }
                offsetY += poseYOffset(id, pose);
                auto* texture=image(asset("char",id,pose));
                for(auto it=characters.begin();it!=characters.end();) {
                    if(it->first!=id && it->second.position==position) it=characters.erase(it); else ++it;
                }
                const auto existing=characters.find(id);
                const auto order=existing==characters.end()?++nextVisualOrder:existing->second.visualOrder;
                Sprite sprite; sprite.texture=texture; sprite.position=position; sprite.asset=id; sprite.pose=pose;
                sprite.offsetX=offsetX; sprite.offsetY=offsetY; sprite.visualOrder=order;
                sprite.layer=commandLayer(args);
                characters[id]=std::move(sprite);
                if(transitionIndex<args.size() && s(transitionIndex)=="fade") {
                    if(uiSettingValues.value("ui.effects",true)) delay(args.at(transitionIndex+1).get<int64_t>(),[&](float t){characters.at(id).alpha=t;});
                    else characters.at(id).alpha=1;
                }
            }
        } else if(name=="hide") {
            visualOnlyKind.clear(); visualOnlyId.clear();
            const auto id=s(0);
            if(characters.contains(id) && args.size()>1 && s(1)=="fade" && uiSettingValues.value("ui.effects",true))delay(args.at(2).get<int64_t>(),[&](float t){characters.at(id).alpha=1-t;});characters.erase(id);
        }
        else if(name=="clear") {if(s(0)=="image"){images.erase(s(1));visualOnlyKind.clear();visualOnlyId.clear();}else if(s(0)=="bg"){background=nullptr;previousBackground=nullptr;backgroundAsset.clear();backgroundLayer.reset();backgroundOffsetX=previousBackgroundOffsetX=0;backgroundOffsetY=previousBackgroundOffsetY=0;visualOnlyKind.clear();visualOnlyId.clear();}else if(s(0)=="bgm")stopBgm();}
        else if(name=="effect") {overlayColor=s(1)=="white"?SDL_Color{255,255,255,255}:SDL_Color{0,0,0,255};if(uiSettingValues.value("ui.effects",true))delay(args.size()>2?args.at(2).get<int64_t>():500,[&](float t){overlay=1-t;});else overlay=0;}
        else throw std::runtime_error("未対応のcommandです: "+name);
        pump();
    }
};
namespace native_player {
static json debugPrimitiveValue(const std::string& type, const json& value) {
    if (type == "int" && (value.is_number_integer() || value.is_string())) return novel::integer(novel::text(value));
    if (type == "float" && (value.is_number() || value.is_string())) return novel::floating(novel::text(value));
    if (type == "str" && value.is_string()) return value;
    if (type == "bool" && value.is_boolean()) return value;
    throw std::runtime_error("debug valueの型が不正です: " + type);
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
        throw std::runtime_error("debug用boolean値が不正です");
    }
    auto value = json::parse(entry.at("value").get<std::string>());
    if (type.starts_with("list<") && type.ends_with(">")) {
        const auto itemType = type.substr(5, type.size() - 6);
        if (!value.is_array()) throw std::runtime_error("debug用list値にはarrayを指定してください");
        for (auto& item : value) item = debugPrimitiveValue(itemType, item);
        return value;
    }
    if (type.starts_with("dict<") && type.ends_with(">")) {
        const auto itemType = type.substr(5, type.size() - 6);
        if (!value.is_object()) throw std::runtime_error("debug用dict値にはobjectを指定してください");
        for (auto it = value.begin(); it != value.end(); ++it) it.value() = debugPrimitiveValue(itemType, it.value());
        return value;
    }
    if (type == "struct") {
        if (!value.is_object() || !entry.contains("fields") || !entry.at("fields").is_object() || value.size() != entry.at("fields").size()) throw std::runtime_error("debug用structの形式が不正です");
        for (auto field = entry.at("fields").begin(); field != entry.at("fields").end(); ++field) {
            if (!value.contains(field.key())) throw std::runtime_error("debug用structにfieldがありません: " + field.key());
            auto& current = value[field.key()];
            const auto fieldType = field.value().get<std::string>();
            try { current = debugPrimitiveValue(fieldType, current); }
            catch (const std::exception&) { throw std::runtime_error("debug用structのfieldが不正です: " + field.key()); }
        }
        return value;
    }
    throw std::runtime_error("未対応のdebug variable型です: " + type);
}

static void validateCompiledProgramShape(const json& program, const std::string& label) {
    if (!program.is_object()) throw std::runtime_error(label + " はJSON objectである必要があります");
    if (!program.contains("version") || !program.at("version").is_number_integer() || program.at("version") != 2)
        throw std::runtime_error(label + " のversion 2が必要です");
    for (const auto* field : {"assets", "characters", "globals", "functions", "scenes", "variables"}) {
        if (!program.contains(field) || !program.at(field).is_array())
            throw std::runtime_error(label + "." + field + " はJSON arrayである必要があります");
    }
}

static void validatePackageShape(const json& package) {
    if (!package.is_object()) throw std::runtime_error("Package envelopeはJSON objectである必要があります");
    if (!package.contains("format") || !package.at("format").is_string()
        || package.at("format") != "novel-script-package"
        || !package.contains("version") || !package.at("version").is_number_integer() || package.at("version") != 1)
        throw std::runtime_error("未対応のpackage形式またはversionです");
    if (!package.contains("program")) throw std::runtime_error("Packageにentry programがありません");
    validateCompiledProgramShape(package.at("program"), "Package program");
    if (package.contains("debug") && !package.at("debug").is_boolean())
        throw std::runtime_error("Package debug flagはbooleanである必要があります");
    if (package.contains("native_ui") && !package.at("native_ui").is_object())
        throw std::runtime_error("Package native_uiはJSON objectである必要があります");
    if (!package.contains("source") || !package.at("source").is_string() || package.at("source").get<std::string>().empty())
        throw std::runtime_error("Package sourceは空でない文字列である必要があります");
    if (!package.contains("files") || !package.at("files").is_object())
        throw std::runtime_error("Package filesはJSON objectである必要があります");
    const auto& files = package.at("files");
    const auto source = package.at("source").get<std::string>();
    if (!files.contains(source)) throw std::runtime_error("Package filesにentry sourceがありません: " + source);
    for (auto it = files.begin(); it != files.end(); ++it)
        validateCompiledProgramShape(it.value(), "Package files[" + it.key() + "]");
    if (!package.contains("native_ui") || !package.at("native_ui").is_object())
        throw std::runtime_error("Package native_uiはJSON objectである必要があります");
}

int run(const fs::path& packagePath, const std::vector<std::string>& arguments) {
    try {
        std::ifstream file(packagePath);
        if (!file) throw std::runtime_error("Packageを開けません: " + utf8Path(packagePath));
        json package;
        file >> package;
        validatePackageShape(package);
        std::string mode;
        json debug = nullptr;
        fs::path debugStatePath;
        for (size_t index = 0; index < arguments.size(); ++index) {
            const auto& argument = arguments[index];
            if (argument == "--headless" || argument == "--smoke" || argument == "--save-boundary-smoke" || argument == "--screen-smoke" || argument == "--screen-control-smoke" || argument == "--screen-shortcut-restart-smoke" || argument == "--screen-slot-smoke" || argument == "--screen-save-smoke" || argument == "--screen-quick-smoke" || argument == "--screen-quick-load-smoke" || argument == "--screen-render-smoke" || argument == "--screen-focus-visual-smoke" || argument == "--start-runtime-smoke" || argument == "--continue-runtime-smoke") { mode = argument; continue; }
            if (argument == "--load-slot") {
                if (index + 1 >= arguments.size()) throw std::runtime_error("Usage: --load-slot <1-120>");
                size_t consumed = 0; const int slot = std::stoi(arguments[++index], &consumed);
                if (consumed != arguments[index].size() || slot < 1 || slot > 120) throw std::runtime_error("Save slot は1〜120を指定してください");
                const auto directory = saveDirectoryFor(packagePath,package);
                migrateLegacySaves(packagePath,directory);
                std::ifstream savedFile(directory / ("slot-" + std::to_string(slot) + ".json"));
                if (!savedFile) throw std::runtime_error("指定した Save slot を開けませんでした");
                debug = json::parse(savedFile);
            if (!debug.is_object() || debug.value("version", 0) != 1 || !debug.contains("file") || !debug.at("file").is_string() || debug.at("file").get<std::string>().empty() || !debug.contains("scene") || !validSavedSceneName(debug.at("scene")) || !debug.contains("line") || !validSavedLine(debug.at("line")) || !debug.contains("variables") || !debug.at("variables").is_object() || !validSavedFrames(debug)) throw std::runtime_error("Save slot のデータ形式が正しくありません");
                if (!saveIdCompatible(debug,package.value("native_ui",json::object()).value("save_id",std::string{}))) throw std::runtime_error("この Save slot は別の作品のデータです");
                continue;
            }
            if (argument == "--debug-start") {
            if (index + 4 >= arguments.size()) throw std::runtime_error("Usage: --debug-start <file> <scene> <line-or-0> <variables-json>");
            if (!package.value("debug", false)) throw std::runtime_error("debug開始には --debug を付けてBuildしたPackageが必要です");
                auto sourceFile = arguments[++index];
                std::replace(sourceFile.begin(), sourceFile.end(), '\\', '/');
                const auto sceneName = arguments[++index];
                size_t consumed = 0;
                const auto line = std::stoll(arguments[++index], &consumed);
            if (consumed != arguments[index].size() || line < 0) throw std::runtime_error("debug lineには0以上の整数を指定してください");
                const auto supplied = json::parse(arguments[++index]);
            if (!supplied.is_object()) throw std::runtime_error("debug variableにはJSON objectを指定してください");
                json variables = json::object();
                for (auto it = supplied.begin(); it != supplied.end(); ++it) variables[it.key()] = debugValue(it.value());
                debug = {{"file", sourceFile}, {"scene", sceneName}, {"line", line ? json(line) : json(nullptr)}, {"variables", variables}};
                continue;
            }
            if (argument == "--debug-state") {
            if (index + 1 >= arguments.size()) throw std::runtime_error("Usage: --debug-state <filename>");
                const auto stateName = fs::u8path(arguments[++index]);
            if (stateName.has_parent_path() || stateName.filename() != stateName || stateName == "." || stateName == "..") throw std::runtime_error("debug stateにはfile nameのみ指定してください");
                debugStatePath = fs::absolute(packagePath).parent_path() / stateName;
                continue;
            }
            throw std::runtime_error("未対応のPlayer argumentです: " + argument);
        }
        novel::Runtime runtime;
        int markerAtFirstStartScreen = -1;
        const auto lowerAscii = [](std::string value) {
            std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
            return value;
        };
        runtime.load=[&](std::string name){
        auto lowerName = lowerAscii(name);
        if(lowerName.ends_with(".txt")) throw std::runtime_error("旧形式の.txt scene fileには対応していません");
            if(!lowerName.ends_with(".tds")) { name+=".tds"; lowerName+=".tds"; }
        if(!package.contains("files")||!package["files"].contains(name))throw std::runtime_error("Package内にsceneがありません: "+name);
            std::set<std::string> visited;
            std::function<void(const json&, json&)> mergeIncludes = [&](const json& source, json& target){
                for(const auto& include : source.value("includes", json::array())) {
                    auto includeName = include.get<std::string>();
                    auto lowerIncludeName = lowerAscii(includeName);
        if(lowerIncludeName.ends_with(".txt")) throw std::runtime_error("旧形式の.txt scene fileには対応していません");
                    if(!lowerIncludeName.ends_with(".tds"))includeName += ".tds";
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
        if (!package.contains("files") || !package.at("files").contains(sourceFile)) throw std::runtime_error("debug対象のsource fileがPackageにありません: " + sourceFile);
            program = runtime.load(sourceFile);
        }
        runtime.program = program;
        bool headless=mode=="--headless";
        if(headless){
            json transcript=json::array();
            runtime.start=[](){};
            runtime.command=[&](const std::string& n,const json& a){
                auto recorded=a;
                if(n=="say" && recorded.size()>1) recorded[1]=runtime.interpolate(recorded.at(1));
                transcript.push_back({{"name",n},{"args",recorded}});
            };
            runtime.choice=[](const std::string&,const std::vector<std::string>&){return size_t(0);};
            runtime.run(program, debug);std::cout<<json{{"globals",runtime.globals},{"commands",transcript}}.dump()<<"\n";
        }else{
            Engine engine(runtime,fs::absolute(packagePath), package);
            if (mode == "--smoke") {
                runtime.functionCallDepth = 1;
                const bool slotBlocked = !engine.saveSlot(0);
                const bool quickBlocked = !engine.saveQuickSlot();
                runtime.functionCallDepth = 0;
                if (!slotBlocked || !quickBlocked || engine.saveNotice != "\u95a2\u6570\u306e\u5b9f\u884c\u4e2d\u306f\u4fdd\u5b58\u3067\u304d\u307e\u305b\u3093")
                    throw std::runtime_error("Native save boundary did not reject saves during a function call");
                engine.saveNotice.clear();
            }
            if (mode == "--screen-shortcut-restart-smoke") {
                std::cout << json{{"F1",engine.uiSettingValues.value("ui.shortcut.F1",std::string{})},{"F12",engine.uiSettingValues.value("ui.shortcut.F12",std::string{})}}.dump() << "\n";
                return 0;
            }
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
            bool parallelFailureRollbackChecked=false;
            bool saveBoundaryChecked=false, loopSaveBoundaryChecked=false;
            json presentationTrace=json::array();
            int64_t lastBgmCrossfadeDurationMs=0;
            MIX_Track* lastBgmCrossfadeTrack=nullptr;
            engine.automated = mode=="--smoke" || mode=="--screen-smoke" || mode=="--save-boundary-smoke";
            if (mode == "--screen-focus-visual-smoke") {
                const char* captureRoot = std::getenv("NOVEL_SCREEN_CAPTURE_DIR");
                if (!captureRoot || !*captureRoot) throw std::runtime_error("NOVEL_SCREEN_CAPTURE_DIR is required for --screen-focus-visual-smoke");
                const fs::path directory = fs::u8path(captureRoot); fs::create_directories(directory);
                engine.activeScreen = engine.gameScreens.value("initial",std::string{});
                engine.resetScreenFocus(); engine.pump();
                engine.captureNextScreenFrame=directory/"stacking-order.png"; engine.pump();
                if (!engine.captureNextScreenFrame.empty()) throw std::runtime_error("Native screen paint-order capture did not run");
                const auto items = engine.visibleScreenItems();
                if (std::any_of(items.begin(),items.end(),[](const json& item) { return item.value("id",std::string{}) == "hidden-action"; }))
                    throw std::runtime_error("Native action catalog included an action hidden with display:none");
                const auto navigationTargets = engine.screenNavigationTargets();
                const auto disabledContinue = std::find_if(navigationTargets.begin(),navigationTargets.end(),[&](const auto& target) {
                    return target.itemIndex >= 0 && size_t(target.itemIndex) < items.size()
                        && items[size_t(target.itemIndex)].value("action",std::string{}) == "continue";
                });
                if (disabledContinue == navigationTargets.end() || !disabledContinue->disabled)
                    throw std::runtime_error("Native focus model did not retain the unavailable non-button Continue action as disabled");
                const auto clickItem = std::find_if(items.begin(),items.end(),[](const json& item){ return item.value("id",std::string{}) == "focus-click"; });
                if (clickItem == items.end()) throw std::runtime_error("Focus visual smoke requires a focus-click screen action");
                const auto rect = engine.screenItemRect(*clickItem);
                SDL_Event pointer{}; pointer.type=SDL_EVENT_MOUSE_MOTION; pointer.motion.x=rect.x+rect.w/2.0f; pointer.motion.y=rect.y+rect.h/2.0f;
                if (!SDL_PushEvent(&pointer)) throw std::runtime_error(SDL_GetError());
                SDL_Event click{}; click.type=SDL_EVENT_MOUSE_BUTTON_DOWN; click.button.button=SDL_BUTTON_LEFT; click.button.x=pointer.motion.x; click.button.y=pointer.motion.y;
                if (!SDL_PushEvent(&click)) throw std::runtime_error(SDL_GetError());
                engine.captureNextScreenFrame=directory/"mouse-focus.png"; engine.pump();
                if (!engine.captureNextScreenFrame.empty() || engine.screenFocusedItem != int(clickItem-items.begin()) || engine.screenKeyboardFocus) throw std::runtime_error("Native mouse click did not retain ordinary action focus without keyboard-visible focus");
                engine.resetScreenFocus();
                SDL_Event tab{}; tab.type=SDL_EVENT_KEY_DOWN; tab.key.scancode=SDL_SCANCODE_TAB;
                if (!SDL_PushEvent(&tab)) throw std::runtime_error(SDL_GetError());
                engine.captureNextScreenFrame=directory/"keyboard-focus.png"; engine.pump();
                if (!engine.captureNextScreenFrame.empty() || engine.screenFocusedItem < 0 || !engine.screenKeyboardFocus) throw std::runtime_error("Native Tab did not establish keyboard-visible focus");
                const auto startItem = std::find_if(items.begin(),items.end(),[](const json& item){ return item.value("id",std::string{}) == "focus-start"; });
                const auto negativeItem = std::find_if(items.begin(),items.end(),[](const json& item){ return item.value("id",std::string{}) == "focus-negative"; });
                const auto clickItemAgain = std::find_if(items.begin(),items.end(),[](const json& item){ return item.value("id",std::string{}) == "focus-click"; });
                if (startItem == items.end() || negativeItem == items.end() || clickItemAgain == items.end() || engine.screenFocusedItem != int(startItem-items.begin())) throw std::runtime_error("Native first Tab did not honor positive tabindex order");
                SDL_Event nextTab{}; nextTab.type=SDL_EVENT_KEY_DOWN; nextTab.key.scancode=SDL_SCANCODE_TAB;
                if (!SDL_PushEvent(&nextTab)) throw std::runtime_error(SDL_GetError());
                engine.captureNextScreenFrame=directory/"static-button-focus.png"; engine.pump();
                if (!engine.captureNextScreenFrame.empty() || engine.screenFocusedItem != -1 || engine.screenFocusedNodeKey != "title:0.4" || !engine.screenKeyboardFocus) throw std::runtime_error("Native Tab did not focus the semantic button without an id or data-action");
                SDL_Event duplicateTab{}; duplicateTab.type=SDL_EVENT_KEY_DOWN; duplicateTab.key.scancode=SDL_SCANCODE_TAB;
                if (!SDL_PushEvent(&duplicateTab)) throw std::runtime_error(SDL_GetError());
                engine.captureNextScreenFrame=directory/"duplicate-first-focus.png"; engine.pump();
                if (!engine.captureNextScreenFrame.empty() || engine.screenFocusedNodeKey != "title:0.4") throw std::runtime_error("Native focus key did not distinguish the first of two nodes with duplicate ids");
                SDL_Event duplicateTabAgain{}; duplicateTabAgain.type=SDL_EVENT_KEY_DOWN; duplicateTabAgain.key.scancode=SDL_SCANCODE_TAB;
                if (!SDL_PushEvent(&duplicateTabAgain)) throw std::runtime_error(SDL_GetError());
                engine.captureNextScreenFrame=directory/"duplicate-second-focus.png"; engine.pump();
                if (!engine.captureNextScreenFrame.empty() || engine.screenFocusedNodeKey != "title:0.5") throw std::runtime_error("Native focus key did not distinguish the second of two nodes with duplicate ids");
                SDL_Event nextTabAgain{}; nextTabAgain.type=SDL_EVENT_KEY_DOWN; nextTabAgain.key.scancode=SDL_SCANCODE_TAB;
                if (!SDL_PushEvent(&nextTabAgain)) throw std::runtime_error(SDL_GetError());
                engine.pump();
                if (engine.screenFocusedItem != int(clickItemAgain-items.begin()) || engine.screenFocusedItem == int(negativeItem-items.begin())) throw std::runtime_error("Native Tab did not skip tabindex=-1 or continue through default tabindex order");
                std::cout << json{{"captured",json::array({"mouse-focus","keyboard-focus","static-button-focus"})},{"count",3},{"width",engine.width},{"height",engine.height}}.dump() << "\n";
                return 0;
            }
            if (mode == "--screen-render-smoke") {
                const char* captureRoot = std::getenv("NOVEL_SCREEN_CAPTURE_DIR");
                if (!captureRoot || !*captureRoot) throw std::runtime_error("NOVEL_SCREEN_CAPTURE_DIR is required for --screen-render-smoke");
                const fs::path directory = fs::u8path(captureRoot);
                fs::create_directories(directory);
                // Render pause/save/load over a real story frame, not an empty
                // black stage, so these captures exercise the gameplay overlay path.
                runtime.currentSourceFile = "main.tds"; runtime.currentSceneName = "main"; runtime.currentLine = 1;
                engine.storyActive = true;
                engine.background = engine.skinImage("ui/backgrounds/spring-ensemble-key-visual.jpg");
                engine.backgroundAsset.clear();
                engine.speaker = "???"; engine.text = "??????????????????????";
                engine.dialogueHistory.emplace_back(engine.speaker,engine.text);
                try { engine.pump(); engine.saveSlot(0); } catch (const std::exception& error) { throw std::runtime_error(std::string("preparing Native screen capture: ") + error.what()); }
                json captures = json::array();
                for (const auto& [id, screen] : engine.gameScreens.at("screens").items()) {
                    if (!screen.is_object() || !screen.contains("uiTree")) continue;
                    const auto target = directory / fs::u8path(id + ".png");
                    engine.activeScreen = id; engine.screenHover = -1; engine.captureNextScreenFrame = target;
                    try { engine.pump(); } catch (const std::exception& error) { throw std::runtime_error("rendering screen " + id + ": " + error.what()); }
                    if (!engine.captureNextScreenFrame.empty()) throw std::runtime_error("Native screen capture hook did not run for " + id);
                    captures.push_back(id);
                    if (id == "title") {
                        const auto items = engine.visibleScreenItems();
                        const auto targetItem = std::find_if(items.begin(),items.end(),[](const json& item){ return item.value("id",std::string{}) == "title-start"; });
                        if (targetItem == items.end()) throw std::runtime_error("Native title hover smoke cannot find GAME START");
                        const auto rect = engine.screenItemRect(*targetItem);
                        SDL_Event pointer{}; pointer.type=SDL_EVENT_MOUSE_MOTION; pointer.motion.x=rect.x+rect.w/2.0f; pointer.motion.y=rect.y+rect.h/2.0f;
                        if (!SDL_PushEvent(&pointer)) throw std::runtime_error(SDL_GetError());
                        const auto hoverTarget = directory / "title-hover.png";
                        engine.captureNextScreenFrame = hoverTarget;
                        engine.pump();
                        if (engine.screenHover < 0 || items[size_t(engine.screenHover)].value("id",std::string{}) != "title-start") throw std::runtime_error("Native mouse motion did not hover GAME START");
                        if (!engine.captureNextScreenFrame.empty()) throw std::runtime_error("Native hovered title capture hook did not run");
                        captures.push_back("title-hover"); engine.screenHover=-1; engine.pump();
                        if (screen.at("uiTree").dump().find("hover-probe") != std::string::npos) {
                            const auto transform = engine.screenCanvasTransform();
                            SDL_Event probePointer{}; probePointer.type=SDL_EVENT_MOUSE_MOTION;
                            // The test fixture places the center of the hover-probe at logical (700, 160).
                            probePointer.motion.x=transform.ox+700.0f*transform.sx;
                            probePointer.motion.y=transform.oy+160.0f*transform.sy;
                            if (!SDL_PushEvent(&probePointer)) throw std::runtime_error(SDL_GetError());
                            engine.captureNextScreenFrame = directory / "title-probe-hover.png";
                            try { engine.pump(); } catch (const std::exception& error) { throw std::runtime_error(std::string("capturing non-action hover: ") + error.what()); }
                            if (!engine.captureNextScreenFrame.empty()) throw std::runtime_error("Native non-action hover capture hook did not run");
                            captures.push_back("title-probe-hover");
                            engine.screenPointerX = -1; engine.screenPointerY = -1; engine.pump();
                        }
                    }
                }
                std::cout << json{{"captured",captures},{"count",captures.size()},{"width",engine.width},{"height",engine.height}}.dump() << "\n";
                return captures.empty() ? 1 : 0;
            }
            if (mode == "--screen-save-smoke") {
                runtime.currentSourceFile = "main.tds"; runtime.currentSceneName = "main"; runtime.currentLine = 1;
                engine.speaker = "Narrator"; engine.text = "checkpoint";
                engine.pump();
                engine.saveSlot(0);
                engine.text = "revised"; engine.pump(); engine.saveSlot(0);
                const auto thumbnail = engine.saveDirectory / "thumb-slot-1.png";
                std::ifstream savedFile(engine.slotPath(0)); json reloaded; savedFile >> reloaded;
                std::cout << json{{"save",fs::is_regular_file(engine.slotPath(0))},{"thumbnail",fs::is_regular_file(thumbnail)},{"fullFrame",engine.lastStoryFrame!=nullptr},{"text",reloaded.value("text","")}}.dump() << "\n";
                return fs::is_regular_file(thumbnail) ? 0 : 1;
            }
            if (mode == "--screen-quick-smoke") {
                runtime.currentSourceFile = "main.tds"; runtime.currentSceneName = "main"; runtime.currentLine = 7;
                engine.speaker = "Narrator"; engine.text = "quick checkpoint";
                engine.saveQuickSlot();
                runtime.currentLine = 99; engine.text = "mutated";
                engine.loadQuickSlot();
                const bool restored = runtime.pendingLoad.is_object() && runtime.pendingLoad.value("line",0) == 7 && runtime.pendingLoad.value("text",std::string{}) == "quick checkpoint";
                std::cout << json{{"saved",fs::is_regular_file(engine.quickSlotPath())},{"restored",restored}}.dump() << "\n";
                return restored ? 0 : 1;
            }
            if (mode == "--screen-quick-load-smoke") {
                engine.loadQuickSlot();
                const auto queued = engine.takeQueuedLoad();
                const bool restored = queued.is_object() && queued.value("line",0) == 7 && queued.value("text",std::string{}) == "quick checkpoint";
                std::cout << json{{"loaded",restored}}.dump() << "\n";
                return restored ? 0 : 1;
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
                const auto hasStateStyle = [&](const auto& self, const json& nodes, int slotIndex, const std::string& state) -> bool {
                    for (const auto& node : nodes) {
                        if (node.value("attrs",json::object()).value("data-slot-index",std::string("-1")) == std::to_string(slotIndex)
                            && node.value("slotStateStyles",json::object()).contains(state)) return true;
                        if (self(self,node.value("children",json::array()),slotIndex,state)) return true;
                    }
                    return false;
                };
                    const auto count = engine.currentScreen().value("slotLayout", json::object()).value("count", 0);
                    json slotItems = json::array();
                    for (const auto& item : items) if (item.contains("slotSummary")) slotItems.push_back(item);
                    if (count < 1 || slotItems.size() < size_t(count)) throw std::runtime_error("Slot cards did not reach Native UI items");
                    const auto transform = engine.screenCanvasTransform();
                    const float sx = transform.sx, sy = transform.sy;
                    for (const auto& node : tree) engine.drawScreenNode(node,sx,sy,transform.ox,transform.oy,items);
                    SDL_RenderPresent(engine.renderer);
                    result[role] = {{"count",count},{"firstStatus",slotItems[0].at("slotSummary").is_object() ? "saved" : "empty"},{"secondStatus",slotItems[1].at("slotSummary").is_object() ? "saved" : "empty"},{"thirdStatus",slotItems[2].at("slotSummary").is_object() ? "saved" : "empty"},{"firstStatusText",Engine::slotStatusLabel(slotItems[0].value("slotState",std::string("empty")),slotItems[0].value("slotSummary",json(nullptr)).is_object() && slotItems[0].at("slotSummary").value("locked",false))},{"secondStatusText",Engine::slotStatusLabel(slotItems[1].value("slotState",std::string("empty")))},{"thirdStatusText",Engine::slotStatusLabel(slotItems[2].value("slotState",std::string("empty")))},{"secondState",slotItems[1].value("slotState",std::string("empty"))},{"thirdState",slotItems[2].value("slotState",std::string("empty"))},{"secondStateStyle",hasStateStyle(hasStateStyle,tree,1,slotItems[1].value("slotState",std::string("empty")))},{"thirdStateStyle",hasStateStyle(hasStateStyle,tree,2,slotItems[2].value("slotState",std::string("empty")))}};
                    result[role]["unsupportedVersionState"] = engine.slotState(19);
                    result[role]["missingVersionState"] = engine.slotState(20);
                    const auto pageButton = std::find_if(items.begin(),items.end(),[](const json& item){ return item.value("action",std::string{}) == "slot-page" && item.value("target",std::string{}) == "1"; });
                    if (pageButton == items.end()) throw std::runtime_error("Native save page button is missing");
                    engine.activateScreenItem(*pageButton);
                    const auto secondPage = engine.visibleScreenItems();
                    const auto pageSlot = std::find_if(secondPage.begin(),secondPage.end(),[](const json& item){ return item.value("slotIndex",-1) == 12; });
                    if (pageSlot == secondPage.end()) throw std::runtime_error("Native save page did not select slot 13");
                    result["secondPage"][role == std::string("save-slots") ? "save" : "load"] = pageSlot->value("slotIndex",-1);
                    engine.slotPages[role == std::string("save-slots") ? "save" : "load"] = 0;
                }
                engine.activeScreen=engine.screenForRole("save-slots");
                auto findAction=[&](const std::string& action)->json { const auto current=engine.visibleScreenItems(); const auto found=std::find_if(current.begin(),current.end(),[&](const json& item){return item.value("action",std::string{})==action && (!item.contains("slotIndex") || item.value("slotIndex",-1)==0);}); if(found==current.end()) throw std::runtime_error("Missing Native slot action: "+action); return *found; };
                const auto select=findAction("slot-select"); engine.activateScreenItem(select);
                result["selectedSummary"] = Engine::selectedSlotSummary(0,engine.readSlot(0));
                result["selectedSummaryTimestamp"] = Engine::formatSlotTimestamp(Engine::slotTimestamp(engine.readSlot(0)));
                engine.activateScreenItem(findAction("slot-lock")); const bool locked=engine.readSlot(0).value("locked",false);
                engine.activateScreenItem(findAction("slot-lock")); const bool unlocked=!engine.readSlot(0).value("locked",false);
                engine.activateScreenItem(findAction("slot-copy")); const bool copied=engine.readSlot(3).is_object() && fs::is_regular_file(engine.saveDirectory/"thumb-slot-4.png");
                const auto moveAction=engine.visibleScreenItems(); const auto move=std::find_if(moveAction.begin(),moveAction.end(),[](const json& item){return item.value("action",std::string{})=="slot-move";});
                if(move==moveAction.end()) throw std::runtime_error("Missing Native slot move action"); engine.activateScreenItem(*move);
                const bool moved=!fs::exists(engine.slotPath(3)) && engine.readSlot(4).is_object();
                engine.activateScreenItem(findAction("slot-delete")); const bool deleteArmed=fs::exists(engine.slotPath(4));
                engine.activateScreenItem(findAction("slot-delete")); const bool deleted=!fs::exists(engine.slotPath(4));
                result["operations"]={{"locked",locked},{"unlocked",unlocked},{"copied",copied},{"moved",moved},{"deleteArmed",deleteArmed},{"deleted",deleted}};
                if(!locked || !unlocked || !copied || !moved || !deleteArmed || !deleted) throw std::runtime_error("Native save slot manager operation failed");
                result["thumbnailDisplayed"] = engine.textures.contains(utf8Path(engine.saveDirectory / "thumb-slot-1.png"));
                std::cout << result.dump() << "\n";
                return 0;
            }
            if (mode == "--screen-control-smoke") {
                engine.automated = true;
                engine.activeScreen = engine.gameScreens.at("initial").get<std::string>(); engine.resetScreenFocus();
                const auto& initialScreen = engine.currentScreen();
                const auto initialTransform = engine.screenCanvasTransform();
                const auto initialItems = engine.visibleScreenItems();
                const auto initialScreenId = engine.activeScreen;
                for (const auto& node : initialScreen.value("uiTree", json::array())) engine.drawScreenNode(node,initialTransform.sx,initialTransform.sy,initialTransform.ox,initialTransform.oy,initialItems);
                SDL_RenderPresent(engine.renderer);
                if (std::none_of(engine.textures.begin(),engine.textures.end(),[](const auto& texture){return texture.first.find("sakura-menu-plate.png")!=std::string::npos;})) throw std::runtime_error("Native title screen did not load the generated menu button artwork");
                const auto inputEvent = [&](Uint32 type, float x, float y) {
                    SDL_Event event{}; event.type = type;
                    if (type == SDL_EVENT_MOUSE_BUTTON_DOWN || type == SDL_EVENT_MOUSE_BUTTON_UP) { event.button.button = SDL_BUTTON_LEFT; event.button.x = x; event.button.y = y; }
                    else { event.motion.x = x; event.motion.y = y; }
                    if (!SDL_PushEvent(&event)) throw std::runtime_error(SDL_GetError());
                };
                const auto initialTree = initialScreen.value("uiTree", json::array());
                json soundControlTree;
                const json* controlTree = &initialTree;
                const json* slider = engine.findScreenInputBySetting(*controlTree, "audio.bgm");
                const json* toggle = engine.findScreenInputBySetting(*controlTree, "audio.bgmMuted");
                engine.screenFocusedItem = 0;
                engine.moveScreenFocus(0,1);
                auto focusItems = engine.visibleScreenItems();
                if (engine.screenFocusedItem < 0 || focusItems.at(size_t(engine.screenFocusedItem)).value("action",std::string{}) != "start") throw std::runtime_error("Directional navigation did not skip the unavailable Continue action");
                engine.moveScreenFocus(0,1);
                focusItems = engine.visibleScreenItems();
                if (focusItems.at(size_t(engine.screenFocusedItem)).value("action",std::string{}) != "load") throw std::runtime_error("Directional navigation did not choose the next geometric action");
                engine.moveScreenFocus(0,-1);
                focusItems = engine.visibleScreenItems();
                if (focusItems.at(size_t(engine.screenFocusedItem)).value("action",std::string{}) != "start") throw std::runtime_error("Directional navigation did not return to the previous geometric action");
                if (!slider || !toggle) {
                    if (!engine.gameScreens.contains("screens") || !engine.gameScreens.at("screens").contains("sound")) throw std::runtime_error("Control smoke requires a BGM slider and mute toggle in the initial or sound screen");
                    engine.activeScreen = "sound"; engine.resetScreenFocus();
                    soundControlTree = engine.currentScreen().value("uiTree",json::array());
                    controlTree = &soundControlTree;
                    slider = engine.findScreenInputBySetting(*controlTree,"audio.bgm");
                    toggle = engine.findScreenInputBySetting(*controlTree,"audio.bgmMuted");
                }
                if (!slider || !toggle) throw std::runtime_error("Control smoke could not find the BGM slider and mute toggle");
                const auto controlTargets = engine.screenNavigationTargets();
                const auto bgmTarget = std::find_if(controlTargets.begin(),controlTargets.end(),[](const auto& item){return item.setting=="audio.bgm";});
                const auto muteTarget = std::find_if(controlTargets.begin(),controlTargets.end(),[](const auto& item){return item.setting=="audio.bgmMuted";});
                const auto preciseTarget = std::find_if(controlTargets.begin(),controlTargets.end(),[](const auto& item){return item.setting=="audio.se";});
                if (bgmTarget==controlTargets.end() || muteTarget==controlTargets.end()) throw std::runtime_error("Keyboard focus model omitted a slider or toggle");
                const auto* preciseInput = engine.findScreenInputBySetting(initialTree,"audio.se");
                const bool testsDoubleStep = preciseInput && preciseInput->value("attrs",json::object()).value("step",std::string{})=="0.00000001";
                if (preciseTarget!=controlTargets.end() && testsDoubleStep) {
                    engine.updateUiSetting("audio.se",0.5);
                    engine.focusScreenTarget(*preciseTarget); engine.adjustFocusedScreenControl(1);
                    if (std::abs(engine.uiSettingValues.value("audio.se",0.0)-0.50000001)>1e-12) throw std::runtime_error("Native keyboard slider adjustment lost its declared double-precision step");
                }
                engine.focusScreenTarget(*bgmTarget); engine.adjustFocusedScreenControl(-1);
                if (std::abs(engine.uiSettingValues.value("audio.bgm",1.0)-0.99)>0.001) throw std::runtime_error("Keyboard slider adjustment did not respect its declared step");
                engine.adjustFocusedScreenControl(1);
                engine.focusScreenTarget(*muteTarget); engine.adjustFocusedScreenControl(1);
                if (!engine.uiSettingValues.value("audio.bgmMuted",false)) throw std::runtime_error("Keyboard toggle activation did not change its value");
                engine.adjustFocusedScreenControl(-1);
                const auto pushKey = [&](SDL_Scancode scancode) {
                    SDL_Event key{}; key.type=SDL_EVENT_KEY_DOWN; key.key.scancode=scancode;
                    if (!SDL_PushEvent(&key)) throw std::runtime_error(SDL_GetError());
                    engine.pump();
                };
                const bool automatedBeforeKeyboardSmoke=engine.automated; engine.automated=false;
                engine.updateUiSetting("audio.bgm",0.5);
                engine.focusScreenTarget(*bgmTarget); pushKey(SDL_SCANCODE_RIGHT);
                if (std::abs(engine.uiSettingValues.value("audio.bgm",0.0)-0.51)>0.001) throw std::runtime_error("SDL Right did not increment the focused range input by one step");
                pushKey(SDL_SCANCODE_LEFT);
                if (std::abs(engine.uiSettingValues.value("audio.bgm",0.0)-0.5)>0.001) throw std::runtime_error("SDL Left did not restore the focused range input by one step: "+std::to_string(engine.uiSettingValues.value("audio.bgm",0.0))+" focused="+engine.screenFocusedSetting+" screen="+engine.activeScreen);
                const bool muteBeforeSpace=engine.uiSettingValues.value("audio.bgmMuted",false);
                engine.focusScreenTarget(*muteTarget); pushKey(SDL_SCANCODE_SPACE);
                if (engine.uiSettingValues.value("audio.bgmMuted",false)==muteBeforeSpace) throw std::runtime_error("SDL Space did not toggle the focused checkbox");
                pushKey(SDL_SCANCODE_SPACE);
                if (engine.uiSettingValues.value("audio.bgmMuted",false)!=muteBeforeSpace) throw std::runtime_error("Second SDL Space did not restore the focused checkbox value");
                engine.automated=automatedBeforeKeyboardSmoke;
                const auto transform = engine.screenCanvasTransform();
                const float sx = transform.sx, sy = transform.sy;
                const auto sliderRect = slider->at("rect");
                const auto sliderSkin = slider->value("controlSkin",json::object());
                const float sliderInset = sliderSkin.value("inset",sliderSkin.value("thumbWidth",28.0f)/2.0f);
                const float sliderX = transform.ox + (sliderRect.value("x", 0.0f) + sliderInset + (sliderRect.value("width", 0.0f) - sliderInset*2.0f) * 0.75f) * sx;
                const float sliderY = transform.oy + (sliderRect.value("y", 0.0f) + sliderRect.value("height", 0.0f) / 2.0f) * sy;
                inputEvent(SDL_EVENT_MOUSE_BUTTON_DOWN, sliderX, sliderY); inputEvent(SDL_EVENT_MOUSE_BUTTON_UP, sliderX, sliderY);
                const auto toggleRect = toggle->at("rect");
                const float toggleX = transform.ox + (toggleRect.value("x", 0.0f) + toggleRect.value("width", 0.0f) / 2.0f) * sx;
                const float toggleY = transform.oy + (toggleRect.value("y", 0.0f) + toggleRect.value("height", 0.0f) / 2.0f) * sy;
                inputEvent(SDL_EVENT_MOUSE_BUTTON_DOWN, toggleX, toggleY); inputEvent(SDL_EVENT_MOUSE_BUTTON_UP, toggleX, toggleY);
                engine.pump(); engine.pump();
                engine.activeScreen = initialScreenId; engine.resetScreenFocus();
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
                engine.activeScreen = "sound"; engine.resetScreenFocus();
                const auto soundTree = engine.currentScreen().value("uiTree",json::array());
                const auto* ayakaGainInput = engine.findScreenInputBySetting(soundTree,"audio.voice.ayaka");
                const auto* ayakaMuteInput = engine.findScreenInputBySetting(soundTree,"audio.voice.ayaka.muted");
                if (!ayakaGainInput || !ayakaMuteInput) throw std::runtime_error("Native sound screen is missing the character-specific voice controls");
                const auto soundTransform = engine.screenCanvasTransform(); const auto& ayakaGainRect = ayakaGainInput->at("rect");
                const float ayakaGainX = soundTransform.ox + (ayakaGainRect.value("x",0.0f) + ayakaGainRect.value("width",0.0f)*0.4f)*soundTransform.sx;
                const float ayakaGainY = soundTransform.oy + (ayakaGainRect.value("y",0.0f) + ayakaGainRect.value("height",0.0f)/2.0f)*soundTransform.sy;
                inputEvent(SDL_EVENT_MOUSE_BUTTON_DOWN,ayakaGainX,ayakaGainY); inputEvent(SDL_EVENT_MOUSE_BUTTON_UP,ayakaGainX,ayakaGainY); engine.pump(); engine.pump();
                if (std::abs(engine.uiSettingValues.value("audio.voice.ayaka",0.0f)-0.4f)>0.03f) throw std::runtime_error("Native character voice slider did not respond to mouse input");
                const auto& ayakaMuteRect = ayakaMuteInput->at("rect");
                const float ayakaMuteX = soundTransform.ox + (ayakaMuteRect.value("x",0.0f) + ayakaMuteRect.value("width",0.0f)/2.0f)*soundTransform.sx;
                const float ayakaMuteY = soundTransform.oy + (ayakaMuteRect.value("y",0.0f) + ayakaMuteRect.value("height",0.0f)/2.0f)*soundTransform.sy;
                if (engine.findScreenInput(soundTree,ayakaMuteX,ayakaMuteY)!=ayakaMuteInput) throw std::runtime_error("Native character mute hit target misses its authored rectangle: "+std::to_string(ayakaMuteX)+","+std::to_string(ayakaMuteY));
                engine.updateScreenInput(*ayakaMuteInput,ayakaMuteX,ayakaMuteY);
                const bool muteAfterPress = engine.uiSettingValues.value("audio.voice.ayaka.muted",false);
                if (!muteAfterPress || !engine.uiSettingValues.value("audio.voice.ayaka.muted",false)) throw std::runtime_error("Native character mute checkbox did not update its setting: "+std::to_string(muteAfterPress)+"/"+std::to_string(engine.uiSettingValues.value("audio.voice.ayaka.muted",false)));
                const bool hasVoiceMixerProbe = std::any_of(engine.runtime.program.at("assets").begin(),engine.runtime.program.at("assets").end(),[](const auto& asset){return asset.value("type",std::string{})=="voice" && asset.value("name",std::string{})=="mixer_probe";});
                if (hasVoiceMixerProbe) {
                engine.updateUiSetting("audio.voice",0.5f); engine.updateUiSetting("audio.voice.ayaka",0.25f); engine.updateUiSetting("audio.voice.ayaka.muted",false);
                engine.command("play",json::array({"voice","mixer_probe","character","ayaka","volume",0.8,"async"}));
                auto voicePlayback = std::find_if(engine.audio.rbegin(),engine.audio.rend(),[](const auto& playback){return playback.type=="voice" && playback.voiceCharacter=="ayaka";});
                if (voicePlayback==engine.audio.rend() || std::abs(MIX_GetTrackGain(voicePlayback->track)-0.1f)>0.03f) throw std::runtime_error("Native character voice gain did not multiply source, channel and speaker levels: "+std::to_string(voicePlayback==engine.audio.rend()?-1.0f:MIX_GetTrackGain(voicePlayback->track))+" pref="+std::to_string(engine.uiSettingValues.value("audio.voice.ayaka",0.0f))+" source="+(voicePlayback==engine.audio.rend()?std::string("missing"):std::to_string(voicePlayback->sourceGain))+" track="+(voicePlayback==engine.audio.rend()?std::string("missing"):voicePlayback->voiceCharacter));
                engine.updateUiSetting("audio.voice.ayaka",0.6f);
                if (std::abs(MIX_GetTrackGain(voicePlayback->track)-0.24f)>0.03f) throw std::runtime_error("Changing a character voice slider did not update its currently playing track with the shared voice level");
                engine.updateUiSetting("audio.voice.ayaka.muted",true);
                if (MIX_GetTrackGain(voicePlayback->track)>0.001f) throw std::runtime_error("Character mute did not silence only its active voice track");
                engine.updateUiSetting("audio.voice.ayaka.muted",false);
                if (std::abs(MIX_GetTrackGain(voicePlayback->track)-0.24f)>0.03f) throw std::runtime_error("Unmuting did not restore the combined channel and per-character playback gain");
                }
                engine.activeScreen.clear();
                if (!engine.updateUiSetting("ui.fullscreen",true) || !(SDL_GetWindowFlags(engine.window)&SDL_WINDOW_FULLSCREEN)) throw std::runtime_error("Native fullscreen preference did not update the SDL window");
                if (!engine.updateUiSetting("ui.fullscreen",false) || (SDL_GetWindowFlags(engine.window)&SDL_WINDOW_FULLSCREEN)) throw std::runtime_error("Native windowed preference did not restore the SDL window");
                if (!engine.updateUiSetting("ui.effects",false) || engine.uiSettingValues.value("ui.effects",true)) throw std::runtime_error("Native effects preference did not turn transitions off");
                const auto effectStarted=SDL_GetTicks(); engine.command("effect",json::array({"fade","black",1000}));
                if (SDL_GetTicks()-effectStarted>=250) throw std::runtime_error("Disabled Native effect still blocked for its animation duration");
                engine.updateUiSetting("ui.effects",true);
                if (!engine.updateUiSetting("ui.cursorHideDelay",0.333333) || std::abs(engine.uiSettingValues.value("ui.cursorHideDelay",0.0)-0.333333)>0.00001) throw std::runtime_error("Native cursor timeout preference was not stored");
                engine.storyActive=true; engine.activeScreen.clear(); engine.lastMouseActivity=SDL_GetTicks()-5001; engine.pump();
                if (SDL_CursorVisible()) throw std::runtime_error("Native cursor did not hide after its configured idle period");
                SDL_Event pointer{}; pointer.type=SDL_EVENT_MOUSE_MOTION; pointer.motion.x=1; pointer.motion.y=1;
                if (!SDL_PushEvent(&pointer)) throw std::runtime_error(SDL_GetError()); engine.pump();
                if (!SDL_CursorVisible()) throw std::runtime_error("Native cursor did not return when pointer activity resumed");
                if (!engine.updateUiSetting("ui.textSpeed",0.25) || std::abs(engine.uiSettingValues.value("ui.textSpeed",1.0)-0.25)>0.00001) throw std::runtime_error("Native text-speed preference did not update");
                engine.text = "native dialogue speed";
                const auto slowStarted=SDL_GetTicks(); engine.revealDialogueText();
                if (SDL_GetTicks()-slowStarted<250 || engine.text!="native dialogue speed") throw std::runtime_error("Native dialogue was not progressively revealed at the configured speed");
                engine.activeScreen.clear(); engine.screenHistory.clear();
                SDL_Event pendingEvent{}; while (SDL_PollEvent(&pendingEvent)) {}
                engine.automated = false;
                if (!engine.updateUiSetting("ui.shortcut.F1","save") || engine.uiSettingValues.value("ui.shortcut.F1",std::string{})!="save") throw std::runtime_error("Native shortcut preference rejected a valid action");
                if (engine.updateUiSetting("ui.shortcut.F1","arbitrary-command")) throw std::runtime_error("Native shortcut preference accepted an action outside its safe allow-list");
                SDL_Event remappedKey{}; remappedKey.type=SDL_EVENT_KEY_DOWN; remappedKey.key.scancode=SDL_SCANCODE_F1;
                if (!SDL_PushEvent(&remappedKey)) throw std::runtime_error(SDL_GetError()); engine.pump();
                if (engine.currentScreen().value("role",std::string{})!="save-slots") throw std::runtime_error("Native F1 did not execute the configured Save binding");
                engine.activeScreen="system"; engine.screenHistory.clear();
                const auto shortcutItems=engine.visibleScreenItems();
                const auto f12Binding=std::find_if(shortcutItems.begin(),shortcutItems.end(),[](const auto& item){return item.value("action",std::string{})=="shortcut-cycle" && item.value("target",std::string{})=="F12";});
                if (f12Binding==shortcutItems.end()) throw std::runtime_error("Native system UI does not expose the F12 binding selector");
                const auto f12Rect=engine.screenItemRect(*f12Binding);
                inputEvent(SDL_EVENT_MOUSE_BUTTON_DOWN,f12Rect.x+f12Rect.w/2.0f,f12Rect.y+f12Rect.h/2.0f); inputEvent(SDL_EVENT_MOUSE_BUTTON_UP,f12Rect.x+f12Rect.w/2.0f,f12Rect.y+f12Rect.h/2.0f); engine.pump(); engine.pump();
                if (engine.uiSettingValues.value("ui.shortcut.F12",std::string{})!="system") throw std::runtime_error("Native shortcut-cycle control did not update and persist its setting");
                engine.updateUiSetting("ui.shortcut.F12","none");
                engine.updateUiSetting("ui.shortcut.F1","system"); engine.activeScreen.clear(); engine.screenHistory.clear();
                SDL_Event systemKey{}; systemKey.type=SDL_EVENT_KEY_DOWN; systemKey.key.scancode=SDL_SCANCODE_F1;
                if (!SDL_PushEvent(&systemKey)) throw std::runtime_error(SDL_GetError()); engine.pump();
                if (engine.activeScreen!="system") throw std::runtime_error("Native F1 did not open the system screen");
                SDL_Event historyKey{}; historyKey.type=SDL_EVENT_KEY_DOWN; historyKey.key.scancode=SDL_SCANCODE_F10;
                if (!SDL_PushEvent(&historyKey)) throw std::runtime_error(SDL_GetError()); engine.pump();
                if (engine.activeScreen!="log") throw std::runtime_error("Native F10 did not open the dialogue history");
                SDL_Event backKey{}; backKey.type=SDL_EVENT_KEY_DOWN; backKey.key.scancode=SDL_SCANCODE_ESCAPE;
                if (!SDL_PushEvent(&backKey)) throw std::runtime_error(SDL_GetError()); engine.pump();
                if (engine.activeScreen!="system") throw std::runtime_error("Native screen history did not restore the previous screen");
                engine.activeScreen.clear(); engine.screenHistory.clear(); engine.storyActive=true; engine.autoPlayActive=true; engine.skipActive=false; engine.automated=false;
                SDL_Event pauseKey{}; pauseKey.type=SDL_EVENT_KEY_DOWN; pauseKey.key.scancode=SDL_SCANCODE_ESCAPE;
                if (!SDL_PushEvent(&pauseKey)) throw std::runtime_error(SDL_GetError()); engine.pump();
                if (engine.activeScreen!="pause" || engine.autoPlayActive || engine.skipActive) throw std::runtime_error("Native Escape did not stop AUTO and open the pause screen during story playback");
                SDL_Event resumeKey{}; resumeKey.type=SDL_EVENT_KEY_DOWN; resumeKey.key.scancode=SDL_SCANCODE_ESCAPE;
                if (!SDL_PushEvent(&resumeKey)) throw std::runtime_error(SDL_GetError()); engine.pump();
                if (!engine.activeScreen.empty() || !engine.storyActive) throw std::runtime_error("Native Escape did not close pause and return to the active story");
                engine.skipActive=true;
                SDL_Event skipPauseKey{}; skipPauseKey.type=SDL_EVENT_KEY_DOWN; skipPauseKey.key.scancode=SDL_SCANCODE_ESCAPE;
                if (!SDL_PushEvent(&skipPauseKey)) throw std::runtime_error(SDL_GetError()); engine.pump();
                if (engine.activeScreen!="pause" || engine.autoPlayActive || engine.skipActive) throw std::runtime_error("Native Escape did not stop SKIP and open the pause screen during story playback");
                SDL_Event skipResumeKey{}; skipResumeKey.type=SDL_EVENT_KEY_DOWN; skipResumeKey.key.scancode=SDL_SCANCODE_ESCAPE;
                if (!SDL_PushEvent(&skipResumeKey)) throw std::runtime_error(SDL_GetError()); engine.pump();
                if (!engine.activeScreen.empty() || !engine.storyActive) throw std::runtime_error("Native Escape did not return to the active story after pausing SKIP");
                engine.activeScreen="system"; engine.screenHistory.clear(); engine.screenHistory.push_back("title");
                engine.activateScreenItem(json{{"action","open-screen"},{"target","system"}});
                if (engine.activeScreen!="system" || engine.screenHistory.size()!=1) throw std::runtime_error("Native re-opening the active screen added a duplicate history entry");
                engine.activateScreenItem(json{{"action","back"}});
                if (engine.activeScreen!="title" || !engine.screenHistory.empty()) throw std::runtime_error("Native back did not return past a repeated active-screen request");
                engine.activeScreen="system"; engine.screenHistory.clear();
                // This phase drives real SDL clicks; automated playback would
                // dismiss the active screen after each rendered frame.
                engine.automated = false;
                const auto systemItems=engine.visibleScreenItems();
                const auto clickSettingValue=[&](const json& item) {
                    const auto rect=engine.screenItemRect(item); const float x=rect.x+rect.w/2.0f,y=rect.y+rect.h/2.0f;
                    inputEvent(SDL_EVENT_MOUSE_BUTTON_DOWN,x,y); inputEvent(SDL_EVENT_MOUSE_BUTTON_UP,x,y); engine.pump(); engine.pump();
                };
                const auto findEffectsValue=[&](bool value)->json { const auto found=std::find_if(systemItems.begin(),systemItems.end(),[&](const auto& item){return item.value("action",std::string{})=="setting-value" && item.value("target",std::string{})=="ui.effects" && item.value("value",!value)==value;}); if(found==systemItems.end()) throw std::runtime_error("Native system screen is missing a selectable effects value"); return *found; };
                const auto fontChoice=std::find_if(systemItems.begin(),systemItems.end(),[](const auto& item){return item.value("action",std::string{})=="setting-value" && item.value("target",std::string{})=="ui.fontFamily" && item.value("value",std::string{})=="mincho";});
                if(fontChoice==systemItems.end()) throw std::runtime_error("Native system screen is missing the Mincho font option");
                const auto originalFontPath=engine.activeFontPath;
                clickSettingValue(*fontChoice);
                if(engine.uiSettingValues.value("ui.fontFamily",std::string{})!="mincho" || engine.activeFontPath==originalFontPath) throw std::runtime_error("Native font setting did not change the active rendered typeface");
                { std::ifstream preferences(engine.uiSettingsPath); json saved; preferences >> saved; if(saved.value("ui.fontFamily",std::string{})!="mincho") throw std::runtime_error("Native font selection was not persisted in player preferences"); }
                const auto defaultFontChoice=std::find_if(systemItems.begin(),systemItems.end(),[](const auto& item){return item.value("action",std::string{})=="setting-value" && item.value("target",std::string{})=="ui.fontFamily" && item.value("value",std::string{})=="default";});
                if(defaultFontChoice==systemItems.end()) throw std::runtime_error("Native system screen is missing the default font option");
                engine.activateScreenItem(*defaultFontChoice);
                if(engine.activeFontPath!=originalFontPath) throw std::runtime_error("Native default font did not restore the project font");
                const auto resetWindow=std::find_if(systemItems.begin(),systemItems.end(),[](const auto& item){return item.value("action",std::string{})=="reset-window-size";});
                if(resetWindow==systemItems.end()) throw std::runtime_error("Native system screen is missing the window-size reset action");
                SDL_SetWindowSize(engine.window,engine.baseWindowWidth-80,engine.baseWindowHeight-60);
                SDL_SetWindowFullscreen(engine.window,true);
                engine.activateScreenItem(*resetWindow);
                int restoredWidth=0,restoredHeight=0; SDL_GetWindowSize(engine.window,&restoredWidth,&restoredHeight);
                if((SDL_GetWindowFlags(engine.window)&SDL_WINDOW_FULLSCREEN) || restoredWidth!=engine.baseWindowWidth || restoredHeight!=engine.baseWindowHeight) throw std::runtime_error("Native window reset did not restore windowed project dimensions");
                clickSettingValue(findEffectsValue(false));
                if(engine.uiSettingValues.value("ui.effects",true)) throw std::runtime_error("Native system mouse click did not select effects off: "+std::to_string(engine.uiSettingValues.value("ui.effects",true)));
                engine.activateScreenItem(findEffectsValue(true));
                if(!engine.uiSettingValues.value("ui.effects",false)) throw std::runtime_error("Native system mouse click did not select effects on: "+std::to_string(engine.uiSettingValues.value("ui.effects",false)));
                const auto resetSettings=std::find_if(systemItems.begin(),systemItems.end(),[](const auto& item){return item.value("action",std::string{})=="reset-settings";});
                if(resetSettings==systemItems.end()) throw std::runtime_error("Native system screen is missing the settings reset action");
                engine.uiSettingsBeforeReset=engine.uiSettingValues;
                { std::ifstream saved(engine.uiSettingsPath); if(saved) saved >> engine.uiSettingsPersistedBeforeReset; }
                engine.updateUiSetting("ui.effects",false);
                engine.updateUiSetting("audio.bgm",0.37);
                engine.updateUiSetting("ui.fontFamily","mincho");
                clickSettingValue(*resetSettings);
                const auto resetDefaults=engine.gameScreens.value("controlDefaults",json::object());
                if(engine.uiSettingValues.value("ui.effects",false)!=resetDefaults.value("ui.effects",true)
                    || std::abs(engine.uiSettingValues.value("audio.bgm",0.0)-resetDefaults.value("audio.bgm",1.0))>0.001
                    || engine.uiSettingValues.value("ui.fontFamily",std::string{})!=resetDefaults.value("ui.fontFamily",std::string("default"))
                    || engine.activeFontPath!=engine.baseFontPath)
                    throw std::runtime_error("Native SDL reset-settings click did not restore the system defaults");
                { std::ifstream preferences(engine.uiSettingsPath); json saved; preferences >> saved;
                    if(saved.value("ui.effects",false)!=resetDefaults.value("ui.effects",true)
                        || std::abs(saved.value("audio.bgm",0.0)-resetDefaults.value("audio.bgm",1.0))>0.001
                        || saved.value("ui.fontFamily",std::string{})!=resetDefaults.value("ui.fontFamily",std::string("default")))
                        throw std::runtime_error("Native SDL reset-settings click did not persist the restored defaults");
                }
                engine.activeScreen.clear(); engine.screenHistory.clear();
                engine.dialogueHistory.emplace_back("Native Speaker", "Native LOG rendering smoke.");
                engine.activeScreen = "log"; engine.pump();
                const auto pauseItems = engine.gameScreens.at("screens").at("pause").value("items",json::array());
                const auto holdItem = std::find_if(pauseItems.begin(),pauseItems.end(),[](const auto& item){return item.value("action",std::string{})=="hold";});
                const auto nextItem = std::find_if(pauseItems.begin(),pauseItems.end(),[](const auto& item){return item.value("action",std::string{})=="next";});
                if (holdItem==pauseItems.end() || nextItem==pauseItems.end()) throw std::runtime_error("Native pause screen is missing HOLD or NEXT");
                engine.activeScreen="pause"; engine.holdActive=false; engine.activateScreenItem(*holdItem);
                if (!engine.holdActive || !engine.activeScreen.empty()) throw std::runtime_error("Native HOLD did not latch and close the pause screen");
                engine.next=false;
                SDL_Event heldKey{}; heldKey.type=SDL_EVENT_KEY_DOWN; heldKey.key.scancode=SDL_SCANCODE_SPACE;
                if (!SDL_PushEvent(&heldKey)) throw std::runtime_error(SDL_GetError()); engine.pump();
                if (engine.next) throw std::runtime_error("Native HOLD allowed keyboard advance");
                SDL_Event heldClick{}; heldClick.type=SDL_EVENT_MOUSE_BUTTON_DOWN; heldClick.button.button=SDL_BUTTON_LEFT; heldClick.button.x=5; heldClick.button.y=5;
                if (!SDL_PushEvent(&heldClick)) throw std::runtime_error(SDL_GetError()); engine.pump();
                if (engine.next) throw std::runtime_error("Native HOLD allowed mouse advance");
                engine.activeScreen="pause"; engine.activateScreenItem(*holdItem);
                if (engine.holdActive || !engine.activeScreen.empty()) throw std::runtime_error("Native HOLD did not toggle off");
                engine.next=false; engine.activateScreenItem(*nextItem);
                if (!engine.next) throw std::runtime_error("Native NEXT did not advance after HOLD was released");
                engine.activeScreen="pause";
                const auto pauseTree=engine.currentScreen().value("uiTree",json::array());
                const auto* pauseVolume=engine.findScreenInputBySetting(pauseTree,"audio.master");
                if (!pauseVolume || pauseVolume->value("controlSkin",json::object()).value("orientation",std::string{})!="vertical") throw std::runtime_error("Native pause menu is missing its vertical master-volume control");
                const auto pauseTransform=engine.screenCanvasTransform(); const auto& volumeRect=pauseVolume->at("rect");
                const float volumeX=pauseTransform.ox+(volumeRect.value("x",0.0f)+volumeRect.value("width",0.0f)/2.0f)*pauseTransform.sx;
                const float volumeTop=pauseTransform.oy+(volumeRect.value("y",0.0f)+volumeRect.value("height",0.0f)*0.08f)*pauseTransform.sy;
                const float volumeBottom=pauseTransform.oy+(volumeRect.value("y",0.0f)+volumeRect.value("height",0.0f)*0.92f)*pauseTransform.sy;
                if (engine.findScreenInput(pauseTree,volumeX,volumeBottom)!=pauseVolume) throw std::runtime_error("Native vertical volume bottom is outside its rendered hit target: "+std::to_string(volumeX)+","+std::to_string(volumeBottom));
                engine.updateUiSetting("audio.master",0.5f);
                inputEvent(SDL_EVENT_MOUSE_BUTTON_DOWN,volumeX,volumeTop); inputEvent(SDL_EVENT_MOUSE_BUTTON_UP,volumeX,volumeTop); engine.pump(); engine.pump();
                if (engine.uiSettingValues.value("audio.master",0.0f)<0.85f) throw std::runtime_error("Native vertical volume top did not map to maximum");
                engine.updateScreenInput(*pauseVolume,volumeX,volumeBottom);
                if (engine.uiSettingValues.value("audio.master",1.0f)>0.15f) throw std::runtime_error("Native vertical volume bottom did not map to minimum: "+std::to_string(engine.uiSettingValues.value("audio.master",1.0f)));
                engine.automated = true;
            }
            auto queuedLoad = engine.takeQueuedLoad();
            if (queuedLoad.is_object()) {
                debug = queuedLoad;
                program = runtime.load(debug.at("file").get<std::string>());
            }
            runtime.beforeInstruction = [&](const json& instruction, const std::string& scene) {
                runtime.currentSceneName = scene;
                runtime.currentSourceFile = instruction.value("file", runtime.program.value("sourceFile", std::string{}));
                runtime.currentLine = instruction.value("line", int64_t(0));
                if (mode == "--save-boundary-smoke" && runtime.functionCallDepth > 0 && !saveBoundaryChecked) {
                    const bool slotBlocked = !engine.saveSlot(119);
                    const bool quickBlocked = !engine.saveQuickSlot();
                    saveBoundaryChecked = slotBlocked && quickBlocked && engine.saveNotice == "\u95a2\u6570\u306e\u5b9f\u884c\u4e2d\u306f\u4fdd\u5b58\u3067\u304d\u307e\u305b\u3093";
                    if (saveBoundaryChecked && !loopSaveBoundaryChecked) {
                        if (const char* capturePath = std::getenv("NOVEL_SAVE_NOTICE_CAPTURE_PATH"); capturePath && *capturePath)
                            engine.captureSaveNoticeFrame = fs::u8path(capturePath);
                        if (!engine.captureSaveNoticeFrame.empty()) engine.pump();
                    }
                    if (!saveBoundaryChecked) throw std::runtime_error("Native save boundary did not reject saves during a function call");
                }
                if (mode == "--save-boundary-smoke" && runtime.loopDepth > 0 && !loopSaveBoundaryChecked) {
                    const bool slotBlocked = !engine.saveSlot(119);
                    const bool quickBlocked = !engine.saveQuickSlot();
                    loopSaveBoundaryChecked = slotBlocked && quickBlocked
                        && engine.saveNotice == "loop\u306e\u5b9f\u884c\u4e2d\u306f\u4fdd\u5b58\u3067\u304d\u307e\u305b\u3093"
                        && !fs::exists(engine.slotPath(119)) && !fs::exists(engine.quickSlotPath());
                    engine.saveNotice.clear();
                    if (!loopSaveBoundaryChecked) throw std::runtime_error("Native save boundary did not reject slot and quick saves during a loop without writing a snapshot");
                }
                if (!debugStatePath.empty() && !scene.empty()) {
                    static auto lastWrite = std::chrono::steady_clock::time_point{};
                    static std::string lastFile;
                    static std::string lastScene;
                    const auto now = std::chrono::steady_clock::now();
                    const bool locationChanged = runtime.currentSourceFile != lastFile || scene != lastScene;
                    if (locationChanged || now - lastWrite >= std::chrono::milliseconds(65)) {
                        const json state = {{"file", runtime.currentSourceFile}, {"scene", scene}, {"line", runtime.currentLine}};
                        auto temporary = debugStatePath; temporary += ".tmp";
                        { std::ofstream output(temporary, std::ios::binary | std::ios::trunc); if (output) { output << state.dump(); output.flush(); } }
                        std::error_code ignored;
                        fs::remove(debugStatePath, ignored);
                        ignored.clear();
                        fs::rename(temporary, debugStatePath, ignored);
                        lastWrite = now;
                        lastFile = runtime.currentSourceFile;
                        lastScene = scene;
                    }
                }
            };
            runtime.runtimeStateProvider = [&](const std::string& name, const json& args) -> std::optional<json> {
                if (name == "runtime.state.ui.dialog_opacity") {
                    if (!args.empty()) throw std::runtime_error("runtime.state.ui.dialog_opacity に引数は指定できません");
                    if (runtime.runtimeDialogOpacityExplicit) return runtime.runtimeDialogOpacity;
                    return engine.config.contains("dialog.opacity") ? std::stod(engine.config.at("dialog.opacity")) : 1.0;
                }
                if (name == "runtime.state.audio.volume") {
                    if (args.size() != 1 || !args.at(0).is_string()) throw std::runtime_error("runtime.state.audio.volume には文字列の引数が1つ必要です");
                    const auto kind = args.at(0).get<std::string>();
                    if (kind != "bgm" && kind != "se" && kind != "voice") throw std::runtime_error("runtime.state.audio.volume のkindには bgm、se、voice のいずれかを指定してください");
                    const auto override = runtime.runtimeAudioVolumeOverrides.find(kind);
                    if (override != runtime.runtimeAudioVolumeOverrides.end()) return override->second;
                    if (debug.is_object() && debug.contains("presentation")) {
                        const auto savedAudio = debug.at("presentation").value("audio", json::object());
                        const auto savedVolumes = savedAudio.value("volumes", json::object());
                        if (savedVolumes.contains(kind) && runtime.runtimeAudioVolumes.contains(kind)) return runtime.runtimeAudioVolumes.at(kind);
                    }
                    const auto configured = engine.config.find("audio." + kind + "_volume");
                    if (configured != engine.config.end()) return std::stod(configured->second);
                    return kind == "voice" ? 0.5 : 1.0;
                }
                return std::nullopt;
            };
            runtime.restorePresentation = [&](const json& state) { engine.restorePresentation(state); };
            runtime.parallel = [&](const json& batch) {
                if(mode=="--smoke" && !parallelFailureRollbackChecked && batch.size()==1
                   && batch.at(0).value("name",std::string{})=="camera") {
                    const auto before=engine.presentationSnapshot();
                    bool rejected=false;
                    try {
                        engine.parallel(json::array({
                            json{{"name","show"},{"args",json::array({"hero.normal","left","fade",100})}},
                            json{{"name","unsupported"},{"args",json::array({"failure probe"})}}
                        }));
                    } catch(const std::exception&) { rejected=true; }
                    if(!rejected || engine.presentationSnapshot()!=before)
                        throw std::runtime_error("Native parallel failure did not roll back partially prepared presentation state");
                    parallelFailureRollbackChecked=true;
                }
                engine.parallel(batch);
                if(mode=="--smoke") presentationTrace.push_back({{"command","parallel"},{"state",engine.presentationSnapshot()}});
            };
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
                        :(blocking?"blocking":async?"async":type=="se"?"nonblocking":type=="video"?"blocking":"async");
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
                if (mode=="--smoke") {
                    json traceEntry={{"command",n},{"state",engine.presentationSnapshot()}};
                    traceEntry["renderedCategories"]=engine.lastRenderedCategories;
                    if(!engine.visualOnlyKind.empty()) {
                        traceEntry["visualOnlyKind"]=engine.visualOnlyKind;
                        traceEntry["visualOnlyId"]=engine.visualOnlyId;
                    }
                    presentationTrace.push_back(std::move(traceEntry));
                }
            };
            runtime.start=[&](){
                if(engine.automated) return;
            if(engine.gameScreens.empty()) throw std::runtime_error("start()を使うには開始画面を設定してください");
                engine.titleStarted=false;
                if (mode == "--start-runtime-smoke" || mode == "--continue-runtime-smoke") {
                    engine.activeScreen = engine.gameScreens.at("initial").get<std::string>();
                    engine.resetScreenFocus();
                    const auto items = engine.visibleScreenItems();
                    const auto action = mode == "--continue-runtime-smoke" ? "continue" : "start";
                    const auto startItem = std::find_if(items.begin(),items.end(),[&](const json& item){ return item.value("action",std::string{}) == action && !item.value("disabled",false); });
                    if (startItem == items.end()) throw std::runtime_error("Native startup runtime smoke requires an enabled " + std::string(action) + " action on the initial screen");
                    if (mode == "--continue-runtime-smoke") engine.activateScreenItem(*startItem);
                    else {
                        const auto rect = engine.screenItemRect(*startItem);
                        SDL_Event click{}; click.type=SDL_EVENT_MOUSE_BUTTON_DOWN; click.button.button=SDL_BUTTON_LEFT; click.button.x=rect.x+rect.w/2.0f; click.button.y=rect.y+rect.h/2.0f;
                        if (!SDL_PushEvent(&click)) throw std::runtime_error(SDL_GetError());
                    }
                }
                if (mode == "--start-runtime-smoke") markerAtFirstStartScreen = runtime.globals.value("marker", -1);
                engine.runTitleScreen();
                auto startupLoad = engine.takeQueuedLoad();
                if (startupLoad.is_object()) runtime.pendingLoad = std::move(startupLoad);
                if (mode == "--continue-runtime-smoke") engine.automated = true;
                engine.titleStarted=false;
            };
            runtime.choice=[&](const std::string& p,const std::vector<std::string>& labels){engine.text=p;engine.options=labels;engine.choiceScroll=0;engine.hovered=labels.empty()?-1:0;engine.selection=engine.automated?0:-1;engine.pump();while(engine.selection<0)engine.pump();auto selected=engine.selection;if(engine.uiSettingValues.value("ui.autoAfterChoice",true))engine.autoPlayActive=false;if(engine.uiSettingValues.value("ui.skipAfterChoice",true))engine.skipActive=false;engine.options.clear();engine.hovered=-1;return size_t(selected);};
            try {
                if (mode == "--screen-control-smoke") {
                    engine.updateUiSetting("ui.shortcut.F1","save"); engine.updateUiSetting("ui.shortcut.F12","history");
                    std::cout << json{{"uiSettings",engine.uiSettingValues},{"uiSettingsBeforeReset",engine.uiSettingsBeforeReset},{"uiSettingsPersistedBeforeReset",engine.uiSettingsPersistedBeforeReset}}.dump() << "\n";
                    return 0;
                }
                runtime.run(program, debug);
                if (mode == "--save-boundary-smoke") {
                    if (!saveBoundaryChecked || !loopSaveBoundaryChecked) throw std::runtime_error("Save-boundary smoke did not verify function and loop save boundaries");
                    std::cout << json{{"functionBoundaryChecked",saveBoundaryChecked},{"loopBoundaryChecked",loopSaveBoundaryChecked}}.dump() << "\n";
                    return 0;
                }
                if (mode == "--start-runtime-smoke") {
                    const bool resumed = engine.activeScreen.empty() && engine.storyActive && runtime.globals.value("marker",0) == 1;
                    std::cout << json{{"resumedAfterStart",resumed},{"activeScreen",engine.activeScreen},{"storyActive",engine.storyActive},{"markerAtFirstStartScreen",markerAtFirstStartScreen},{"marker",runtime.globals.value("marker",0)}}.dump() << "\n";
                    return resumed ? 0 : 1;
                }
                if (mode == "--continue-runtime-smoke") {
                    const bool restored = runtime.currentSceneName == "saved" && engine.text == "42" && runtime.globals.value("marker",0) == 42;
                    std::cout << json{{"restored",restored},{"scene",runtime.currentSceneName},{"text",engine.text},{"marker",runtime.globals.value("marker",0)}}.dump() << "\n";
                    return restored ? 0 : 1;
                }
                while(engine.video)engine.pump();
                if (mode == "--smoke") {
                    for (int attempt = 0; attempt < 25 && !engine.audio.empty(); ++attempt) { engine.cleanupStoppedAudio(); SDL_Delay(4); }
                    if (!engine.audio.empty()) throw std::runtime_error("Audio tracks did not release after all blocking and cleared playback ended");
                    std::cout << json{{"playbackTimings",playbackTimings},{"presentationTrace",presentationTrace},{"animationMidpoints",engine.animationMidpoints},{"animatedImageFrameChanges",engine.animatedFrameChanges},{"animatedFiniteAnimationsCompleted",engine.animatedFiniteAnimationsCompleted},{"animatedGifRepeatCounts",engine.animatedGifRepeatCounts},{"dialogue",{{"speaker",engine.speaker},{"text",engine.text}}},{"currentScene",runtime.currentSceneName},{"failedCrossfadeRetained",failedCrossfadeRetained},{"failedInstantBgmRetained",failedInstantBgmRetained},{"failedVideoReplacementRetained",failedVideoReplacementRetained},{"failedSpriteReplacementRetained",failedSpriteReplacementRetained},{"failedBackgroundReplacementRetained",failedBackgroundReplacementRetained},{"failedSePlaybackRejected",failedSePlaybackRejected},{"failedVoicePlaybackRejected",failedVoicePlaybackRejected},{"failedIncomingBgmRetiredOutgoing",failedIncomingBgmRetiredOutgoing},{"repeatedImageRaised",repeatedImageRaised},{"completedBgmCrossfadeAfterBlockingWait",completedBgmCrossfadeAfterBlockingWait},{"relativeCharacterMoveMatched",relativeCharacterMoveMatched},{"relativeBackgroundMoveMatched",relativeBackgroundMoveMatched},{"characterSlotReplacementMatched",characterSlotReplacementMatched},{"bgmCrossfadeCompletedDuringBlockingVoice",bgmCrossfadeCompletedDuringBlockingVoice},{"parallelFailureRollbackChecked",parallelFailureRollbackChecked}}.dump() << "\n";
                }
            }
            catch(const Quit&){}
        }
        return 0;
    }catch(const std::exception&e){std::cerr<<"Player error: "<<e.what()<<"\n";return 1;}
}

} // namespace native_player
