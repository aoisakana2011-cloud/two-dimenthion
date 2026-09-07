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
    SDL_Texture *background = nullptr, *dialog = nullptr;
    std::unique_ptr<Video> video;
    std::map<std::string, std::string> config;
    std::string speaker, text;
    std::vector<std::string> options;
    int selection = -1;
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
        auto key = path.string(); if (textures.contains(key)) return textures[key];
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
        if (relative.empty()) throw std::runtime_error("Unknown asset: " + id);
        auto base = fs::weakly_canonical(root / "assets"), resolved = fs::canonical(base / relative);
        auto rel = resolved.lexically_relative(base);
        if (rel.empty() || rel.is_absolute() || *rel.begin() == "..") throw std::runtime_error("Asset outside package");
        return resolved;
    }
    Engine(novel::Runtime& rt, const fs::path& package) : root(package.parent_path()), runtime(rt) {
        if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO) || !TTF_Init() || !MIX_Init()) throw std::runtime_error(SDL_GetError());
        fs::path data = fs::path(SDL_GetBasePath()) / "engine_data";
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
        fs::path fontPath = config.contains("font.path") ? config["font.path"] : "C:/Windows/Fonts/meiryo.ttc";
        if (fontPath.is_relative()) fontPath = data / fontPath;
        font = TTF_OpenFont(fontPath.string().c_str(), number("font.size",24));
        if (!font) throw std::runtime_error(SDL_GetError());
        if (config.contains("dialog.background_image")) dialog = image(data / config["dialog.background_image"]);
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
    void label(const std::string& s, float x, float y, int size, SDL_Color col) {
        if (s.empty()) return;
        TTF_SetFontSize(font,size);
        auto* surface = TTF_RenderText_Blended_Wrapped(font,s.c_str(),s.size(),col,Uint32(std::max(1.0f,float(width)-x-30)));
        if (!surface) throw std::runtime_error(SDL_GetError());
        auto* texture = SDL_CreateTextureFromSurface(renderer,surface);
        SDL_FRect rect{x,y,float(surface->w),float(surface->h)};
        SDL_RenderTexture(renderer,texture,nullptr,&rect); SDL_DestroyTexture(texture); SDL_DestroySurface(surface);
    }
    void speakerLabel(const std::string& name, float x, float y, int size, SDL_Color col) {
        if (name.empty()) return;
        TTF_SetFontSize(font, size);
        int textWidth = 0, textHeight = 0;
        if (!TTF_GetStringSize(font, name.c_str(), name.size(), &textWidth, &textHeight)) {
            label(name, x, y, size, col);
            return;
        }

        // The artwork already provides a name plate. Add a quiet ink shadow and
        // a small accent so the speaker remains legible on bright backgrounds.
        const float padX = 18.0f;
        const float padY = 7.0f;
        SDL_FRect shadow{x - padX + 2.0f, y - padY + 3.0f,
                        float(textWidth) + padX * 2.0f, float(textHeight) + padY * 2.0f};
        SDL_SetRenderDrawColor(renderer, 32, 62, 108, 34);
        SDL_RenderFillRect(renderer, &shadow);

        SDL_FRect accent{x - padX, y - padY, 5.0f, float(textHeight) + padY * 2.0f};
        SDL_SetRenderDrawColor(renderer, 89, 143, 225, 230);
        SDL_RenderFillRect(renderer, &accent);

        // A thin highlight gives the label a little depth without competing with
        // the dialogue text or changing the existing asset layout.
        SDL_FRect highlight{x - padX + 8.0f, y - padY,
                           float(textWidth) + padX * 2.0f - 8.0f, 2.0f};
        SDL_SetRenderDrawColor(renderer, 255, 255, 255, 110);
        SDL_RenderFillRect(renderer, &highlight);

        label(name, x + 1.0f, y + 1.0f, size, {255, 255, 255, 105});
        label(name, x, y, size, col);
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
            if (e.type == SDL_EVENT_KEY_DOWN && options.empty()) next = true;
            if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
                if (options.empty()) next = true;
                else if (e.button.x >= 100 && e.button.x <= width-100) {
                    int i = int((e.button.y-150)/50);
                    if (e.button.y >= 150 && i >= 0 && i < int(options.size()) && e.button.y < 150+i*50+40) selection=i;
                }
            }
        }
        if (video) { video->update(); if (video->finished) video.reset(); }
        SDL_SetRenderDrawColor(renderer,12,15,22,255); SDL_RenderClear(renderer);
        if (background) SDL_RenderTexture(renderer,background,nullptr,nullptr);
        for (const auto& [id,s] : characters) sprite(s);
        for (const auto& [id,s] : images) sprite(s);
        int dx=number("dialog.x",30),dy=number("dialog.y",470);
        SDL_FRect box{float(dx),float(dy),float(number("dialog.width",900)),float(number("dialog.height",180))};
        if (dialog) SDL_RenderTexture(renderer,dialog,nullptr,&box);
        else { auto c=color("dialog.background_color",{0,0,0,220}); SDL_SetRenderDrawColor(renderer,c.r,c.g,c.b,c.a); SDL_RenderFillRect(renderer,&box); }
        auto col=color("dialog.text_color",{30,45,70,255});
        speakerLabel(speaker,float(number("dialog.speaker_x",55)),float(dy+number("dialog.speaker_y",25)),number("dialog.speaker_size",number("font.size",24)),col);
        label(text,float(number("dialog.text_x",55)),float(dy+number("dialog.text_y",70)),number("dialog.text_size",number("font.size",24)),col);
        for (size_t i=0;i<options.size();++i) {
            SDL_FRect b{100,150+float(i)*50,float(width-200),40}; SDL_SetRenderDrawColor(renderer,20,30,50,230);SDL_RenderFillRect(renderer,&b);
            label(options[i],120,b.y+5,20,{255,255,255,255});
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
        auto* a=MIX_LoadAudio(mixer,asset(type,id).string().c_str(),true); if(!a) throw std::runtime_error(SDL_GetError()); audio.push_back(a);
        auto* track=MIX_CreateTrack(mixer); if(!track || !MIX_SetTrackAudio(track,a)) throw std::runtime_error(SDL_GetError());
        auto props=SDL_CreateProperties(); if(type=="bgm") {bgm=track;SDL_SetNumberProperty(props,MIX_PROP_PLAY_LOOPS_NUMBER,-1);}
        bool ok=MIX_PlayTrack(track,props);SDL_DestroyProperties(props);if(!ok) throw std::runtime_error(SDL_GetError());
    }
    void command(const std::string& name,const json& args) {
        auto s=[&](size_t i){return args.at(i).get<std::string>();};
        if(name=="say") {speaker=s(0)=="none"?"":s(0);text=runtime.interpolate(args.at(1));next=false;if(automated)pump();else while(!next)pump();}
        else if(name=="wait") delay(args.at(0).get<int64_t>());
        else if(name=="bg") background=image(asset("bg",s(0)));
        else if(name=="bgm") sound("bgm",s(0));
        else if(name=="play") {
            if(s(0)=="video") {video=std::make_unique<Video>(renderer,asset("video",s(1)).string());if(args.size()>2 && s(2)=="blocking")while(video)pump();}
            else sound(s(0),s(1));
        } else if(name=="show" || name=="char") {
            bool show=name=="show"; size_t offset=show?1:0; auto type=show?s(0):"char";auto id=s(offset);
            if(type=="image") images[id]={image(asset("image",id)),s(offset+1)};
            else {
                if(!show && !characters.contains(id))throw std::runtime_error("Character not shown: "+id);
                characters[id]={image(asset("char",id,s(offset+2))),s(offset+1)};
                if(show && args.size()>offset+3)delay(args.at(offset+4).get<int64_t>(),[&](float t){characters.at(id).alpha=t;});
            }
        } else if(name=="hide") {auto id=s(1);if(characters.contains(id) && args.size()>2)delay(args.at(3).get<int64_t>(),[&](float t){characters.at(id).alpha=1-t;});characters.erase(id);}
        else if(name=="clear") {if(s(0)=="char")characters.erase(s(1));else if(s(0)=="image")images.erase(s(1));else if(s(0)=="bg")background=nullptr;else if(s(0)=="bgm" && bgm)MIX_StopTrack(bgm,0);}
        else if(name=="effect") {overlayColor=s(1)=="white"?SDL_Color{255,255,255,255}:SDL_Color{0,0,0,255};delay(args.size()>2?args.at(2).get<int64_t>():500,[&](float t){overlay=1-t;});}
        else throw std::runtime_error("Unknown command: "+name);
        pump();
    }
};
int main(int argc,char**argv) {
    if(argc<2){std::cerr<<"Usage: novel_player package.nsp.json [--headless]\n";return 2;}
    try {
        std::ifstream file(argv[1]);json package;file>>package;
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
        bool headless=argc>2 && std::string(argv[2])=="--headless";
        if(headless){
            json transcript=json::array();
            runtime.command=[&](const std::string& n,const json& a){transcript.push_back({{"name",n},{"args",a}});};
            runtime.choice=[](const std::string&,const std::vector<std::string>&){return size_t(0);};
            runtime.run(package.at("program"));std::cout<<json{{"globals",runtime.globals},{"commands",transcript}}.dump()<<"\n";
        }else{
            Engine engine(runtime,fs::absolute(argv[1]));
            engine.automated = argc>2 && std::string(argv[2])=="--smoke";
            runtime.command=[&](const std::string& n,const json& a){engine.command(n,a);};
            runtime.choice=[&](const std::string& p,const std::vector<std::string>& labels){engine.text=p;engine.options=labels;engine.selection=engine.automated?0:-1;engine.pump();while(engine.selection<0)engine.pump();auto selected=engine.selection;engine.options.clear();return size_t(selected);};
            try { runtime.run(package.at("program")); while(engine.video)engine.pump(); }
            catch(const Quit&){}
        }
        return 0;
    }catch(const std::exception&e){std::cerr<<"PLAYER ERROR: "<<e.what()<<"\n";return 1;}
}
