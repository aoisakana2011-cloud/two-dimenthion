#include "player.hpp"
#include "runtime.hpp"
#include "video.hpp"
#include <SDL3_image/SDL_image.h>
#include <SDL3_ttf/SDL_ttf.h>
#include <SDL3_mixer/SDL_mixer.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <thread>
using novel::json;
namespace fs = std::filesystem;
static std::string utf8Path(const fs::path& path) {
    const auto value = path.u8string();
    return std::string(reinterpret_cast<const char*>(value.data()), value.size());
}

struct Quit {};
struct Engine {
    SDL_Window* window = nullptr;
    SDL_Renderer* renderer = nullptr;
    TTF_Font* font = nullptr;
    MIX_Mixer* mixer = nullptr;
    MIX_Track* bgm = nullptr;
    std::vector<MIX_Audio*> audio;
    std::map<std::string, SDL_Texture*> textures;
    struct Sprite { SDL_Texture* texture; std::string position; float alpha = 1; };
    std::map<std::string, Sprite> characters, images;
    SDL_Texture *background = nullptr, *dialog = nullptr, *speakerSkin = nullptr, *choiceSkin = nullptr, *choiceActiveSkin = nullptr;
    std::unique_ptr<Video> video;
    std::map<std::string, std::string> config;
    std::string speaker, text;
    std::vector<std::string> options;
    int selection = -1;
    int hovered = -1;
    bool next = false;
    bool automated = false;
    int width = 960, height = 680;
    float overlay = 0;
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
        auto* t = IMG_LoadTexture(renderer, key.c_str());
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
        if (relative.starts_with("assets/")) relative.erase(0, 7);
        else if (relative.starts_with("asset/")) relative.erase(0, 6);
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
    void applyUiTheme(const json& nativeUi) {
        if (!nativeUi.contains("native_ui_theme")) return;
        const auto themeFile = nativeUi.at("native_ui_theme").get<std::string>();
        if (themeFile.empty() || fs::path(themeFile).is_absolute() || themeFile.find("..") != std::string::npos) throw std::runtime_error("Invalid native UI theme");
        std::ifstream file(root / "asset" / fs::u8path(themeFile));
        if (!file) throw std::runtime_error("Cannot open native UI theme: " + themeFile);
        json theme; file >> theme;
        if (theme.value("version", 0) != 1) throw std::runtime_error("Unsupported native UI theme version");
        if (theme.contains("screen") && theme.contains("dialog") && theme.contains("choices")) {
            const auto& d = theme.at("dialog"), &m = d.at("message"), &n = d.at("nameplate"), &c = theme.at("choices");
            config["dialog.x"] = std::to_string(d.at("x").get<int>()); config["dialog.y"] = std::to_string(d.at("y").get<int>()); config["dialog.width"] = std::to_string(d.at("width").get<int>()); config["dialog.height"] = std::to_string(d.at("height").get<int>());
            config["dialog.text_x"] = std::to_string(m.at("x").get<int>()); config["dialog.text_y"] = std::to_string(m.at("y").get<int>()); config["dialog.text_width"] = std::to_string(m.at("width").get<int>()); config["dialog.text_height"] = std::to_string(m.at("height").get<int>()); config["dialog.text_size"] = std::to_string(m.at("size").get<int>());
            config["dialog.speaker_x"] = std::to_string(n.at("x").get<int>()); config["dialog.speaker_y"] = std::to_string(n.at("y").get<int>()); config["dialog.speaker_width"] = std::to_string(n.at("width").get<int>()); config["dialog.speaker_height"] = std::to_string(n.at("height").get<int>()); config["dialog.speaker_size"] = std::to_string(n.at("text").at("size").get<int>());
            const auto colorText = [](const json& value) { return std::to_string(value[0].get<int>()) + "," + std::to_string(value[1].get<int>()) + "," + std::to_string(value[2].get<int>()) + "," + std::to_string(value[3].get<int>()); };
            config["dialog.text_color"] = colorText(m.at("color")); config["dialog.speaker_color"] = colorText(n.at("text").at("color"));
            dialog = skinImage((fs::path(themeFile).parent_path() / fs::u8path(d.at("image").get<std::string>())).generic_string());
            speakerSkin = skinImage((fs::path(themeFile).parent_path() / fs::u8path(n.at("image").get<std::string>())).generic_string());
            choiceSkin = skinImage((fs::path(themeFile).parent_path() / fs::u8path(c.at("image").get<std::string>())).generic_string());
            choiceActiveSkin = skinImage((fs::path(themeFile).parent_path() / fs::u8path(c.at("activeImage").get<std::string>())).generic_string());
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
        const auto themeDirectory = fs::path(themeFile).parent_path();
        const auto imagePath = [&](const std::string& name) { return (themeDirectory / fs::u8path(name)).generic_string(); };
        if (theme.contains("backdrop") && theme["backdrop"].is_object()) {
            const auto& backdrop = theme["backdrop"];
            config["ui.bottom_fog"] = backdrop.value("bottom_fog", true) ? "1" : "0";
            setColor(backdrop, "fog_color", "ui.fog_color"); setNumber(backdrop, "fog_height", "ui.fog_height"); setNumber(backdrop, "fog_opacity", "ui.fog_opacity");
        }
        if (theme.contains("dialog") && theme["dialog"].is_object()) {
            const auto& dialogTheme = theme["dialog"];
            setNumber(dialogTheme, "x", "dialog.x"); setNumber(dialogTheme, "y", "dialog.y"); setNumber(dialogTheme, "width", "dialog.width"); setNumber(dialogTheme, "height", "dialog.height"); setNumber(dialogTheme, "bottom", "dialog.bottom");
            setColor(dialogTheme, "text_color", "dialog.text_color");
            if (dialogTheme.contains("image") && dialogTheme.at("image").is_string()) dialog = skinImage(imagePath(dialogTheme.at("image").get<std::string>()));
            if (dialogTheme.contains("speaker") && dialogTheme.at("speaker").is_object()) { const auto& speakerTheme = dialogTheme["speaker"]; setNumber(speakerTheme, "x", "dialog.speaker_x"); setNumber(speakerTheme, "y", "dialog.speaker_y"); setNumber(speakerTheme, "size", "dialog.speaker_size"); }
            if (dialogTheme.contains("text") && dialogTheme.at("text").is_object()) { const auto& textTheme = dialogTheme["text"]; setNumber(textTheme, "x", "dialog.text_x"); setNumber(textTheme, "y", "dialog.text_y"); setNumber(textTheme, "size", "dialog.text_size"); setColor(textTheme, "color", "dialog.text_color"); }
        }
        if (theme.contains("choice") && theme["choice"].is_object()) {
            const auto& choiceTheme = theme["choice"];
            setNumber(choiceTheme, "width", "choice.width"); setNumber(choiceTheme, "height", "choice.height"); setNumber(choiceTheme, "gap", "choice.gap"); setNumber(choiceTheme, "bottom_gap", "choice.bottom_gap"); setNumber(choiceTheme, "top_min", "choice.top_min");
            if (choiceTheme.contains("image") && choiceTheme.at("image").is_string()) choiceSkin = skinImage(imagePath(choiceTheme.at("image").get<std::string>()));
            if (choiceTheme.contains("active_image") && choiceTheme.at("active_image").is_string()) choiceActiveSkin = skinImage(imagePath(choiceTheme.at("active_image").get<std::string>()));
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
        width = number("window.width",960); height = number("window.height",680);
        window = SDL_CreateWindow(config.contains("window.title") ? config["window.title"].c_str() : "Novel Script",width,height,0);
        renderer = SDL_CreateRenderer(window,nullptr);
        if (!window || !renderer) throw std::runtime_error(SDL_GetError());
        SDL_SetRenderDrawBlendMode(renderer, SDL_BLENDMODE_BLEND);
        fs::path fontPath = fs::u8path(config.contains("font.path") ? config["font.path"] : "C:/Windows/Fonts/meiryo.ttc");
        if (fontPath.is_relative()) fontPath = data / fontPath;
        font = TTF_OpenFont(utf8Path(fontPath).c_str(), number("font.size",24));
        if (!font) throw std::runtime_error(SDL_GetError());
        if (config.contains("dialog.background_image")) dialog = image(data / fs::u8path(config["dialog.background_image"]));
        const auto nativeUi = packageData.value("native_ui", json::object());
        applyUiTheme(nativeUi);
        if (nativeUi.contains("native_dialog_image")) dialog = skinImage(nativeUi.at("native_dialog_image").get<std::string>());
        if (nativeUi.contains("native_speaker_image")) speakerSkin = skinImage(nativeUi.at("native_speaker_image").get<std::string>());
        if (nativeUi.contains("native_choice_image")) choiceSkin = skinImage(nativeUi.at("native_choice_image").get<std::string>());
        if (nativeUi.contains("native_choice_active_image")) choiceActiveSkin = skinImage(nativeUi.at("native_choice_active_image").get<std::string>());
        mixer = MIX_CreateMixerDevice(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK,nullptr);
        if (!mixer) throw std::runtime_error(SDL_GetError());
    }
    ~Engine() {
        video.reset(); if (mixer) MIX_DestroyMixer(mixer);
        for (auto* a : audio) MIX_DestroyAudio(a);
        for (auto [key,t] : textures) SDL_DestroyTexture(t);
        if (font) TTF_CloseFont(font);
        if (renderer) SDL_DestroyRenderer(renderer);
        if (window) SDL_DestroyWindow(window);
        MIX_Quit(); TTF_Quit(); SDL_Quit();
    }
    void label(const std::string& s, float x, float y, int size, SDL_Color col, float maxWidth = 0) {
        if (s.empty()) return;
        TTF_SetFontSize(font,size);
        auto* surface = TTF_RenderText_Blended_Wrapped(font,s.c_str(),s.size(),col,Uint32(std::max(1.0f,maxWidth > 0 ? maxWidth : float(width)-x-30)));
        if (!surface) throw std::runtime_error(SDL_GetError());
        auto* texture = SDL_CreateTextureFromSurface(renderer,surface);
        SDL_FRect rect{x,y,float(surface->w),float(surface->h)};
        SDL_RenderTexture(renderer,texture,nullptr,&rect); SDL_DestroyTexture(texture); SDL_DestroySurface(surface);
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
        if (speakerSkin) {
            float skinWidth = 0, skinHeight = 0;
            SDL_GetTextureSize(speakerSkin, &skinWidth, &skinHeight);
            frame.w = std::max(frame.w, frame.h * skinWidth / skinHeight);
        }
        if (speakerSkin) frame = fitTexture(speakerSkin, frame);
        else outlinedPanel(frame, color("dialog.background_color", {13,20,33,232}), color("dialog.border_color", {112,159,201,180}), color("dialog.accent_color", {100,190,255,255}));
        if (!name.empty()) label(name, frame.x + (frame.w - labelWidth) / 2.0f, frame.y + (frame.h - labelHeight) / 2.0f, size, col);
    }
    void dialogueLabel(const std::string& value, float x, float y, int size, SDL_Color col, float maxWidth) {
        label(value, x, y, size, col, maxWidth);
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
            SDL_SetRenderDrawColor(renderer, fog.r, fog.g, fog.b, Uint8(std::min(255, int(opacity * t * t))));
            SDL_FRect band{0, start + float(index), float(width), 1.1f};
            SDL_RenderFillRect(renderer, &band);
        }
    }
    SDL_FRect choiceRect(size_t index) {
        const float cardWidth = std::min(float(number("choice.width", 620)), float(width) - 120.0f);
        const float cardHeight = float(number("choice.height", 48)), gap = float(number("choice.gap", 10));
        const float top = std::max(float(number("choice.top_min", 58)), float(height) - float(number("dialog.height", 184)) - float(number("choice.bottom_gap", 42)) - float(options.size()) * (cardHeight + gap));
        return { (float(width) - cardWidth) / 2.0f, top + float(index) * (cardHeight + gap), cardWidth, cardHeight };
    }
    void sprite(const Sprite& s) {
        float w,h; SDL_GetTextureSize(s.texture,&w,&h);
        float scale = std::min(float(height)/h, float(width)/w); w *= scale; h *= scale;
        float x = s.position == "left" ? 0 : s.position == "right" ? width-w : (width-w)/2;
        SDL_FRect rect{x,height-h,w,h}; SDL_SetTextureAlphaModFloat(s.texture,s.alpha);
        SDL_RenderTexture(renderer,s.texture,nullptr,&rect); SDL_SetTextureAlphaModFloat(s.texture,1);
    }
    void pump() {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            if (e.type == SDL_EVENT_QUIT) throw Quit{};
            if (e.type == SDL_EVENT_KEY_DOWN) {
                if (options.empty()) next = true;
                else if (e.key.scancode == SDL_SCANCODE_DOWN) hovered = (hovered + 1 + int(options.size())) % int(options.size());
                else if (e.key.scancode == SDL_SCANCODE_UP) hovered = (hovered - 1 + int(options.size())) % int(options.size());
                else if (e.key.scancode == SDL_SCANCODE_RETURN || e.key.scancode == SDL_SCANCODE_SPACE) selection = hovered < 0 ? 0 : hovered;
            }
            if (e.type == SDL_EVENT_MOUSE_MOTION && !options.empty()) {
                hovered = -1;
                for (size_t i = 0; i < options.size(); ++i) { const auto box = choiceRect(i); if (e.motion.x >= box.x && e.motion.x <= box.x + box.w && e.motion.y >= box.y && e.motion.y <= box.y + box.h) hovered = int(i); }
            }
            if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
                if (options.empty()) next = true;
                else for (size_t i = 0; i < options.size(); ++i) { const auto box = choiceRect(i); if (e.button.x >= box.x && e.button.x <= box.x + box.w && e.button.y >= box.y && e.button.y <= box.y + box.h) selection = int(i); }
            }
        }
        if (video) { video->update(); if (video->finished) video.reset(); }
        SDL_SetRenderDrawColor(renderer,12,15,22,255); SDL_RenderClear(renderer);
        if (background) SDL_RenderTexture(renderer,background,nullptr,nullptr);
        for (const auto& [id,s] : characters) sprite(s);
        for (const auto& [id,s] : images) sprite(s);
        if (number("ui.bottom_fog", 1)) bottomFog();
        const float dialogWidth = std::min(float(number("dialog.width", 900)), float(width) - 48.0f);
        const float dialogHeight = float(number("dialog.height", 184));
        const float dx = config.contains("dialog.x") ? float(number("dialog.x", 0)) : (float(width) - dialogWidth) / 2.0f;
        const float dy = config.contains("dialog.y") ? float(number("dialog.y", 0)) : float(height) - dialogHeight - float(number("dialog.bottom", 26));
        SDL_FRect box{dx, dy, dialogWidth, dialogHeight};
        auto col=color("dialog.text_color",{235,241,248,255});
        SDL_FRect dialogBox = box;
        if (dialog) dialogBox = fitTexture(dialog, box);
        else outlinedPanel(box, color("dialog.background_color", {13,20,33,232}), color("dialog.border_color", {112,159,201,180}), color("dialog.accent_color", {100,190,255,255}));
        const float textX = dialogBox.x + float(number("dialog.text_x", 190));
        const float textY = dialogBox.y + float(number("dialog.text_y", 63));
        const float textWidth = float(number("dialog.text_width", 844));
        speakerLabel(speaker, dialogBox.x + float(number("dialog.speaker_x", 90)), dialogBox.y + float(number("dialog.speaker_y", -52)), number("dialog.speaker_size", number("font.size", 24)), color("dialog.speaker_color", col));
        dialogueLabel(text, textX, textY, number("dialog.text_size", number("font.size", 24)), col, textWidth);
        if (options.empty() && !text.empty()) label("竕ｫ", float(width) - 66, float(height) - 68, 34, {230,240,250,210}, 48);
        for (size_t i=0;i<options.size();++i) {
            SDL_FRect b = choiceRect(i); const bool active = int(i) == hovered;
            if ((active ? choiceActiveSkin : choiceSkin)) b = fitTexture(active ? choiceActiveSkin : choiceSkin, b);
            else outlinedPanel(b, active ? SDL_Color{31,65,98,245} : SDL_Color{14,24,39,232}, active ? SDL_Color{125,210,255,255} : SDL_Color{92,128,163,190}, active ? SDL_Color{112,208,255,255} : SDL_Color{67,114,159,220});
            label(options[i], b.x + float(number("choice.text_x", 24)), b.y + float(number("choice.text_y", 12)), number("choice.text_size", 19), color("choice.text_color", {240,246,252,255}), b.w - 42);
        }
        if (video) SDL_RenderTexture(renderer,video->texture,nullptr,nullptr);
        if (overlay>0) { SDL_SetRenderDrawColor(renderer,overlayColor.r,overlayColor.g,overlayColor.b,Uint8(255*overlay)); SDL_RenderFillRect(renderer,nullptr); }
        SDL_RenderPresent(renderer); SDL_Delay(8);
    }
    void delay(int64_t ms, std::function<void(float)> animate = {}) {
        if (ms<0 || ms>2147483647) throw std::runtime_error("Invalid duration");
        auto start = SDL_GetTicks();
        do { float progress=ms ? std::min(1.0f,float(SDL_GetTicks()-start)/ms) : 1; if(animate) animate(progress); pump(); } while(SDL_GetTicks()-start<uint64_t(ms));
        if(animate) animate(1);
    }
    void sound(const std::string& type,const std::string& id) {
        if (type=="bgm" && bgm) MIX_StopTrack(bgm,0);
        auto* a=MIX_LoadAudio(mixer,utf8Path(asset(type,id)).c_str(),true); if(!a) throw std::runtime_error(SDL_GetError()); audio.push_back(a);
        auto* track=MIX_CreateTrack(mixer); if(!track || !MIX_SetTrackAudio(track,a)) throw std::runtime_error(SDL_GetError());
        auto props=SDL_CreateProperties(); if(type=="bgm") {bgm=track;SDL_SetNumberProperty(props,MIX_PROP_PLAY_LOOPS_NUMBER,-1);}
        bool ok=MIX_PlayTrack(track,props);SDL_DestroyProperties(props);if(!ok) throw std::runtime_error(SDL_GetError());
    }
    void command(const std::string& name,const json& args) {
        auto s=[&](size_t i){return args.at(i).get<std::string>();};
        if(name=="say") {
            speaker=(s(0)=="none" || s(0)=="narrator") ? "" : s(0);
            if(!speaker.empty()) {
                try { auto actor=runtime.get(speaker); if(actor.is_object() && actor.contains("name") && actor.at("name").is_string())speaker=actor.at("name").get<std::string>(); }
                catch(const std::runtime_error&) {}
            }
            text=runtime.interpolate(args.at(1));next=false;if(automated)pump();else while(!next)pump();
        }
        else if(name=="wait") delay(args.at(0).get<int64_t>());
        else if(name=="bg") background=image(asset("bg",s(0)));
        else if(name=="bgm") sound("bgm",s(0));
        else if(name=="play") {
            if(s(0)=="video") {video=std::make_unique<Video>(renderer,utf8Path(asset("video",s(1))));if(args.size()>2 && s(2)=="blocking")while(video)pump();}
            else sound(s(0),s(1));
        } else if(name=="show") {
            if(s(0)=="image") images[s(1)]={image(asset("image",s(1))),s(2)};
            else {
                const auto dot=s(0).find('.');
                if(dot==std::string::npos) throw std::runtime_error("show requires character.pose or image id");
                const auto id=s(0).substr(0,dot), pose=s(0).substr(dot+1);
                characters[id]={image(asset("char",id,pose)),s(1)};
                if(args.size()>2 && s(2)=="fade")delay(args.at(3).get<int64_t>(),[&](float t){characters.at(id).alpha=t;});
            }
        } else if(name=="hide") {
            const auto id=s(0);
            if(characters.contains(id) && args.size()>1 && s(1)=="fade")delay(args.at(2).get<int64_t>(),[&](float t){characters.at(id).alpha=1-t;});characters.erase(id);
        }
        else if(name=="clear") {if(s(0)=="image")images.erase(s(1));else if(s(0)=="bg")background=nullptr;else if(s(0)=="bgm" && bgm)MIX_StopTrack(bgm,0);}
        else if(name=="effect") {overlayColor=s(1)=="white"?SDL_Color{255,255,255,255}:SDL_Color{0,0,0,255};delay(args.size()>2?args.at(2).get<int64_t>():500,[&](float t){overlay=1-t;});}
        else throw std::runtime_error("Unknown command: "+name);
        pump();
    }
};
namespace native_player {
int run(const fs::path& packagePath, const std::string& mode) {
    try {
        std::ifstream file(packagePath);json package;file>>package;
        if(package.value("format","")!="novel-script-package" || package.at("version")!=1)throw std::runtime_error("Unsupported package format/version");
        novel::Runtime runtime;
        runtime.load=[&](std::string name){
            if(!name.ends_with(".tds")&&!name.ends_with(".txt"))name+=".tds";
            if(!package.contains("files")||!package["files"].contains(name))throw std::runtime_error("Missing packaged scene: "+name);
            std::set<std::string> visited;
            std::function<void(const json&, json&)> mergeIncludes = [&](const json& source, json& target){
                for(const auto& include : source.value("includes", json::array())) {
                    auto includeName = include.get<std::string>();
                    if(!includeName.ends_with(".tds")&&!includeName.ends_with(".txt"))includeName += ".tds";
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
        bool headless=mode=="--headless";
        if(headless){
            json transcript=json::array();
            runtime.command=[&](const std::string& n,const json& a){transcript.push_back({{"name",n},{"args",a}});};
            runtime.choice=[](const std::string&,const std::vector<std::string>&){return size_t(0);};
            runtime.run(package.at("program"));std::cout<<json{{"globals",runtime.globals},{"commands",transcript}}.dump()<<"\n";
        }else{
            Engine engine(runtime,fs::absolute(packagePath), package);
            engine.automated = mode=="--smoke";
            runtime.command=[&](const std::string& n,const json& a){engine.command(n,a);};
            runtime.choice=[&](const std::string& p,const std::vector<std::string>& labels){engine.text=p;engine.options=labels;engine.hovered=labels.empty()?-1:0;engine.selection=engine.automated?0:-1;engine.pump();while(engine.selection<0)engine.pump();auto selected=engine.selection;engine.options.clear();engine.hovered=-1;return size_t(selected);};
            try { runtime.run(package.at("program")); while(engine.video)engine.pump(); }
            catch(const Quit&){}
        }
        return 0;
    }catch(const std::exception&e){std::cerr<<"PLAYER ERROR: "<<e.what()<<"\n";return 1;}
}

} // namespace native_player
