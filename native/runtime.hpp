#pragma once
#include <nlohmann/json.hpp>
#include <algorithm>
#include <charconv>
#include <cstdint>
#include <functional>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>
#include <regex>
#include <set>
#include <cmath>
#include <optional>

namespace novel {
using json = nlohmann::json;
using Int = int64_t;
inline Int integer(const std::string& s) {
    Int n{}; const char* first = s.data();
    if (!s.empty() && s[0] == '+') ++first;
    if (first == s.data() + s.size() || (first != s.data() && (*first < '0' || *first > '9'))) throw std::runtime_error("Invalid int64 conversion: " + s);
    auto result = std::from_chars(first, s.data() + s.size(), n);
    if (result.ec != std::errc() || result.ptr != s.data() + s.size()) throw std::runtime_error("Invalid int64 conversion: " + s);
    return n;
}
inline Int add(Int a, Int b) {
    if ((b > 0 && a > INT64_MAX - b) || (b < 0 && a < INT64_MIN - b)) throw std::runtime_error("int64 overflow");
    return a + b;
}
inline Int sub(Int a, Int b) {
    if ((b < 0 && a > INT64_MAX + b) || (b > 0 && a < INT64_MIN + b)) throw std::runtime_error("int64 overflow");
    return a - b;
}
inline Int mul(Int a, Int b) {
    if (a && b && ((a > 0 && b > 0 && a > INT64_MAX / b) || (a > 0 && b < 0 && b < INT64_MIN / a) || (a < 0 && b > 0 && a < INT64_MIN / b) || (a < 0 && b < 0 && a < INT64_MAX / b))) throw std::runtime_error("int64 overflow");
    return a * b;
}
inline double floating(const std::string& s) {
    if (s.empty() || s[0] == '+' && s.size() == 1) throw std::runtime_error("Invalid finite float: " + s);
    const size_t start = s[0] == '+' ? 1 : 0;
    double value{};
    const auto result = std::from_chars(s.data() + start, s.data() + s.size(), value, std::chars_format::general);
    if (result.ec != std::errc{} || result.ptr != s.data() + s.size() || !std::isfinite(value)) throw std::runtime_error("Invalid finite float: " + s);
    return value == 0.0 ? 0.0 : value;
}
inline double finite(double value) {
    if (!std::isfinite(value)) throw std::runtime_error("float must be finite");
    return value == 0.0 ? 0.0 : value;
}
inline std::string floatText(double value) {
    if (value == 0.0) return "0";
    char buffer[64];
    const auto result = std::to_chars(buffer, buffer + sizeof(buffer), value, std::chars_format::general);
    if (result.ec != std::errc{}) throw std::runtime_error("Cannot format float");
    std::string source(buffer, result.ptr);
    const auto exponentAt = source.find_first_of("eE");
    if (exponentAt == std::string::npos) return source;
    const int exponent = std::stoi(source.substr(exponentAt + 1));
    std::string mantissa = source.substr(0, exponentAt);
    const bool negative = mantissa[0] == '-';
    if (negative) mantissa.erase(0, 1);
    const size_t point = mantissa.find('.');
    const int decimal = int(point == std::string::npos ? mantissa.size() : point) + exponent;
    if (point != std::string::npos) mantissa.erase(point, 1);
    const std::string sign = negative ? "-" : "";
    if (std::abs(value) >= 1e-6 && std::abs(value) < 1e21) {
        if (decimal <= 0) return sign + "0." + std::string(size_t(-decimal), '0') + mantissa;
        if (decimal >= int(mantissa.size())) return sign + mantissa + std::string(size_t(decimal - int(mantissa.size())), '0');
        return sign + mantissa.substr(0, size_t(decimal)) + "." + mantissa.substr(size_t(decimal));
    }
    const int scientific = decimal - 1;
    const std::string normalized = mantissa.substr(0, 1) + (mantissa.size() > 1 ? "." + mantissa.substr(1) : "");
    return sign + normalized + "e" + (scientific >= 0 ? "+" : "") + std::to_string(scientific);
}
inline std::string text(const json& v) {
    if (v.is_string()) return v.get<std::string>();
    if (v.is_null()) return "";
    if (v.is_number_float()) return floatText(v.get<double>());
    return v.dump();
}
inline bool dataSpace(const std::string& value, size_t offset, size_t& length) {
    const unsigned char c = static_cast<unsigned char>(value[offset]);
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') { length = 1; return true; }
    if (offset + 1 < value.size() && c == 0xC2 && static_cast<unsigned char>(value[offset + 1]) == 0xA0) { length = 2; return true; }
    if (offset + 2 < value.size() && c == 0xE3 && static_cast<unsigned char>(value[offset + 1]) == 0x80 && static_cast<unsigned char>(value[offset + 2]) == 0x80) { length = 3; return true; }
    return false;
}
inline std::string normalizeDataSpace(const std::string& value, bool collapse) {
    std::string result, pending;
    for (size_t offset = 0; offset < value.size();) {
        size_t length = 1;
        if (dataSpace(value, offset, length)) {
            if (!result.empty()) { if (collapse) pending = " "; else pending += value.substr(offset, length); }
            offset += length;
            continue;
        }
        if (!pending.empty()) { result += pending; pending.clear(); }
        const unsigned char c = static_cast<unsigned char>(value[offset]);
        length = c < 0x80 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 1;
        if (offset + length > value.size()) length = 1;
        result.append(value, offset, length);
        offset += length;
    }
    return result;
}
inline json splitText(const std::string& value, const std::string& separator) {
    if (separator.empty()) throw std::runtime_error("text.split separator must not be empty");
    json result = json::array();
    size_t start = 0;
    for (;;) {
        const size_t found = value.find(separator, start);
        if (found == std::string::npos) { result.push_back(value.substr(start)); break; }
        result.push_back(value.substr(start, found - start));
        start = found + separator.size();
    }
    return result;
}
inline std::string replaceText(const std::string& value, const std::string& search, const std::string& replacement) {
    if (search.empty()) throw std::runtime_error("text.replace search must not be empty");
    std::string result;
    size_t start = 0;
    for (;;) {
        const size_t found = value.find(search, start);
        if (found == std::string::npos) { result += value.substr(start); break; }
        result += value.substr(start, found - start);
        result += replacement;
        start = found + search.size();
    }
    return result;
}
inline bool matches(const json& v, const json& type) {
    if (type == "int") return v.is_number_integer();
    if (type == "float") return v.is_number_float() && std::isfinite(v.get<double>());
    if (type == "str") return v.is_string();
    if (type == "bool") return v.is_boolean();
    if (!type.is_object()) return false;
    if (type.value("kind", "") == "struct") return v.is_object();
    if (type.value("kind", "") == "list") return v.is_array() && std::all_of(v.begin(), v.end(), [&](const json& value) { return matches(value, type.at("value")); });
    if (type.value("kind", "") != "dict" || !v.is_object()) return false;
    for (const auto& value : v) if (!matches(value, type.at("value"))) return false;
    return true;
}
struct Signal { enum Kind { Next, Return, Goto, Restart } kind = Next; json value; };
class Runtime {
public:
    json globals = json::object(), program;
    std::function<void(const std::string&, const json&)> command;
    std::function<void(const json&)> parallel;
    std::function<size_t(const std::string&, const std::vector<std::string>&)> choice;
    std::function<json(const std::string&)> load;
    std::function<void(const json&, const std::string&)> beforeInstruction;
    std::function<void(const json&)> restorePresentation;
    std::function<std::optional<json>(const std::string&, const json&)> runtimeStateProvider;
    json pendingLoad = nullptr;
    std::string currentSceneName, currentSourceFile;
    int64_t currentLine = 0;
    std::vector<json> locals;
    std::set<std::string> readonlyGlobals;
    std::vector<std::set<std::string>> readonlyLocals;
    std::set<size_t> loopScopes;
    void popLocal() { loopScopes.erase(locals.size()-1); locals.pop_back(); readonlyLocals.pop_back(); }
    json& declarationFrame() { for(size_t i=locals.size();i>0;--i) if(!loopScopes.contains(i-1))return locals[i-1];return globals; }
    std::map<std::string, json> functions;
    // Authoritative query-facing occupancy; updated after successful presentation commands.
    std::map<std::string, std::string> runtimeCharacterSlots;
    std::string runtimeBackground, runtimeBgm;
    double runtimeDialogOpacity = 1.0;
    bool runtimeDialogOpacityExplicit = false;
    std::map<std::string, double> runtimeAudioVolumes;
    std::map<std::string, double> runtimeAudioVolumeOverrides;
    void restoreRuntimeState(const json& state) {
        runtimeCharacterSlots.clear();
        runtimeBackground.clear(); runtimeBgm.clear();
        runtimeDialogOpacity = state.value("ui", json::object()).value("dialogOpacity", 1.0);
        runtimeDialogOpacityExplicit = state.value("ui", json::object()).contains("dialogOpacity");
        runtimeAudioVolumes = {{"bgm", 1.0}, {"se", 1.0}, {"voice", 0.5}};
        runtimeAudioVolumeOverrides.clear();
        const auto audio = state.value("audio", json::object());
        const auto volumes = audio.value("volumes", json::object());
        const auto overrides = audio.value("volumeOverrides", json::object());
        for (const auto& [kind, fallback] : runtimeAudioVolumes) if (volumes.contains(kind)) runtimeAudioVolumes[kind] = volumes.at(kind).get<double>();
        for (const auto& [kind, value] : overrides.items()) if (runtimeAudioVolumes.contains(kind)) runtimeAudioVolumeOverrides[kind] = value.get<double>();
        if (state.contains("background") && state.at("background").is_object()) runtimeBackground = state.at("background").value("asset", std::string());
        if (state.contains("bgm") && state.at("bgm").is_object()) runtimeBgm = state.at("bgm").value("asset", std::string());
        for (const auto& character : state.value("characters", json::array())) {
            if (!character.is_object() || !character.contains("id") || !character.at("id").is_string()) continue;
            runtimeCharacterSlots[character.at("id").get<std::string>()] = character.value("slot", std::string("center"));
        }
    }
    void updateRuntimeState(const std::string& name, const json& args) {
        if (name == "volume" && args.size() == 2 && args.at(0).is_string() && args.at(1).is_number()) runtimeAudioVolumeOverrides[args.at(0).get<std::string>()] = args.at(1).get<double>();
        else if (name == "dialog" && args.size() == 2 && args.at(0) == "opacity" && args.at(1).is_number()) { runtimeDialogOpacity = args.at(1).get<double>(); runtimeDialogOpacityExplicit = true; }
        else if (name == "bg" && !args.empty() && args.at(0).is_string()) runtimeBackground = args.at(0).get<std::string>();
        else if (name == "bgm" && !args.empty() && args.at(0).is_string()) runtimeBgm = args.at(0).get<std::string>();
        else if (name == "play" && args.size() >= 2 && args.at(0) == "bgm" && args.at(1).is_string()) runtimeBgm = args.at(1).get<std::string>();
        else if (name == "clear" && !args.empty() && args.at(0) == "bg") runtimeBackground.clear();
        else if (name == "clear" && !args.empty() && args.at(0) == "bgm") runtimeBgm.clear();
        else if (name == "show" && args.size() >= 2 && args.at(0).is_string() && args.at(1).is_string()) {
            const auto reference = args.at(0).get<std::string>();
            const auto separator = reference.find('.');
            if (reference == "image" || separator == std::string::npos) return;
            const auto id = reference.substr(0, separator), slot = args.at(1).get<std::string>();
            for (auto it = runtimeCharacterSlots.begin(); it != runtimeCharacterSlots.end();) {
                if (it->first != id && it->second == slot) it = runtimeCharacterSlots.erase(it);
                else ++it;
            }
            runtimeCharacterSlots[id] = slot;
        } else if (name == "hide" && !args.empty() && args.at(0).is_string()) {
            runtimeCharacterSlots.erase(args.at(0).get<std::string>());
        }
    }
    json runtimeStateCall(const std::string& name, const json& args) const {
        if (name == "runtime.state.characters.exists") {
            if (args.size() != 1 || !args.at(0).is_string()) throw std::runtime_error("runtime.state.characters.exists expects one str argument");
            return runtimeCharacterSlots.contains(args.at(0).get<std::string>());
        }
        if (name == "runtime.state.characters.list") {
            if (!args.empty()) throw std::runtime_error("runtime.state.characters.list expects no arguments");
            json result = json::array();
            for (const auto& [id, slot] : runtimeCharacterSlots) { (void)slot; result.push_back(id); }
            return result;
        }
        if (name == "runtime.state.characters.position") {
            if (args.size() != 1 || !args.at(0).is_string()) throw std::runtime_error("runtime.state.characters.position expects one str argument");
            const auto id = args.at(0).get<std::string>();
            for (const auto& [character, slot] : runtimeCharacterSlots) if (character == id) return slot;
            return "";
        }
        if (name == "runtime.state.background.exists") { if (!args.empty()) throw std::runtime_error("runtime.state.background.exists expects no arguments"); return !runtimeBackground.empty(); }
        if (name == "runtime.state.background.current") { if (!args.empty()) throw std::runtime_error("runtime.state.background.current expects no arguments"); return runtimeBackground; }
        if (name == "runtime.state.audio.bgm_exists") { if (!args.empty()) throw std::runtime_error("runtime.state.audio.bgm_exists expects no arguments"); return !runtimeBgm.empty(); }
        if (name == "runtime.state.audio.current_bgm") { if (!args.empty()) throw std::runtime_error("runtime.state.audio.current_bgm expects no arguments"); return runtimeBgm; }
        if (name == "runtime.state.execution.current_scene") { if (!args.empty()) throw std::runtime_error("runtime.state.execution.current_scene expects no arguments"); return currentSceneName; }
        if (name == "runtime.state.execution.current_file") { if (!args.empty()) throw std::runtime_error("runtime.state.execution.current_file expects no arguments"); return currentSceneName.empty() ? std::string() : currentSourceFile; }
        if (name == "runtime.state.execution.current_line") { if (!args.empty()) throw std::runtime_error("runtime.state.execution.current_line expects no arguments"); return Int(currentSceneName.empty() ? 0 : currentLine); }
        if (name == "runtime.state.ui.dialog_opacity") {
            if (!args.empty()) throw std::runtime_error("runtime.state.ui.dialog_opacity expects no arguments");
            if (runtimeStateProvider) if (auto provided = runtimeStateProvider(name, args)) return *provided;
            return runtimeDialogOpacity;
        }
        if (name == "runtime.state.audio.volume") {
            if (args.size() != 1 || !args.at(0).is_string()) throw std::runtime_error("runtime.state.audio.volume expects one str argument");
            if (runtimeStateProvider) if (auto provided = runtimeStateProvider(name, args)) return *provided;
            const auto kind = args.at(0).get<std::string>();
            if (!runtimeAudioVolumes.contains(kind)) throw std::runtime_error("runtime.state.audio.volume channel must be bgm, se, or voice");
            const auto override = runtimeAudioVolumeOverrides.find(kind);
            return override == runtimeAudioVolumeOverrides.end() ? runtimeAudioVolumes.at(kind) : override->second;
        }
        if (name == "runtime.state.variables.exists") {
            if (args.size() != 1 || !args.at(0).is_string()) throw std::runtime_error("runtime.state.variables.exists expects one str argument");
            const auto variable = args.at(0).get<std::string>();
            if (globals.contains(variable)) return true;
            return std::any_of(locals.begin(), locals.end(), [&](const json& frame) { return frame.contains(variable); });
        }
        if (name == "runtime.state.variables.names") {
            if (!args.empty()) throw std::runtime_error("runtime.state.variables.names expects no arguments");
            std::set<std::string> names;
            for (auto it = globals.begin(); it != globals.end(); ++it) names.insert(it.key());
            for (const auto& frame : locals) for (auto it = frame.begin(); it != frame.end(); ++it) names.insert(it.key());
            return std::vector<std::string>(names.begin(), names.end());
        }
        if (runtimeStateProvider) if (auto provided = runtimeStateProvider(name, args)) return *provided;
        throw std::runtime_error("Unknown runtime state API: " + name);
    }
    json get(const std::string& name) const {
        for (auto i = locals.rbegin(); i != locals.rend(); ++i) if (i->contains(name)) return i->at(name);
        if (!globals.contains(name)) throw std::runtime_error("Undefined variable: " + name);
        return globals.at(name);
    }
    void set(const std::string& name, const json& v) {
        for (size_t n = locals.size(); n > 0; --n) if (locals[n - 1].contains(name)) { if (readonlyLocals[n - 1].contains(name)) throw std::runtime_error("const variable cannot be changed: " + name); locals[n - 1][name] = v; return; }
        if (!globals.contains(name)) throw std::runtime_error("Undefined variable: " + name);
        if (readonlyGlobals.contains(name)) throw std::runtime_error("const variable cannot be changed: " + name);
        globals[name] = v;
    }
    void assertMutable(const json& target) const {
        std::string name;
        if (target.at("kind") == "load") name = target.at("name").get<std::string>();
        else if (target.at("kind") == "index" && target.at("target").at("kind") == "load") name = target.at("target").at("name").get<std::string>();
        if (name.empty()) return;
        for (size_t n = locals.size(); n > 0; --n) if (locals[n - 1].contains(name)) { if (readonlyLocals[n - 1].contains(name)) throw std::runtime_error("const variable cannot be changed: " + name); return; }
        if (readonlyGlobals.contains(name)) throw std::runtime_error("const variable cannot be changed: " + name);
    }
    std::string interpolate(const json& v) {
        const auto s = text(v); std::regex pattern(R"(\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\})");
        std::string out; size_t offset = 0;
        for (auto it = std::sregex_iterator(s.begin(), s.end(), pattern); it != std::sregex_iterator(); ++it) {
            const auto path = (*it)[1].str(); const auto dot = path.find('.');
            json replacement = get(path.substr(0, dot)); size_t start = dot;
            while (start != std::string::npos) {
                const auto next = path.find('.', start + 1); const auto field = path.substr(start + 1, next - start - 1);
                if (!replacement.is_object() || !replacement.contains(field)) throw std::runtime_error("Missing interpolation field: " + path);
                replacement = replacement.at(field); start = next;
            }
            out += s.substr(offset, it->position() - offset) + text(replacement); offset = it->position() + it->length();
        }
        const auto expanded = out + s.substr(offset);
        const std::regex calls(R"(\{([A-Za-z_][A-Za-z0-9_]*)\(\)\})");
        std::string result; offset = 0;
        for (auto it = std::sregex_iterator(expanded.begin(), expanded.end(), calls); it != std::sregex_iterator(); ++it) {
            result += expanded.substr(offset, it->position() - offset);
            result += text(call((*it)[1].str(), json::array()));
            offset = it->position() + it->length();
        }
        return result + expanded.substr(offset);
    }
    json value(const json& e) {
        if (e.is_null()) return nullptr;
        const auto kind = e.at("kind").get<std::string>();
        if (kind == "integer") return integer(e.at("value"));
        if (kind == "float") return floating(e.at("value").get<std::string>());
        if (kind == "literal") {
            auto v = e.at("value");
            if (v.is_number_unsigned() && v.get<uint64_t>() > INT64_MAX) throw std::runtime_error("int64 overflow");
            return v;
        }
        if (kind == "load") return get(e.at("name"));
        if (kind == "dict") { json d = json::object(); for (const auto& item : e.at("entries")) d[item.at("key").get<std::string>()] = value(item.at("value")); return d; }
        if (kind == "list") { json values = json::array(); for (const auto& item : e.at("items")) values.push_back(value(item)); return values; }
        if (kind == "index") {
            auto d = value(e.at("target")); auto keyValue = value(e.at("key"));
            if (d.is_array()) {
                if (!keyValue.is_number_integer()) throw std::runtime_error("List index must be an integer");
                const Int index = keyValue.get<Int>();
                if (index < 0 || uint64_t(index) >= d.size()) throw std::runtime_error("List index out of range: " + std::to_string(index));
                return d.at(size_t(index));
            }
            if (!keyValue.is_string()) throw std::runtime_error("Dictionary key must be a string");
            auto key = keyValue.get<std::string>();
            if (!d.is_object() || !d.contains(key)) throw std::runtime_error("Missing dictionary key: " + key);
            return d.at(key);
        }
        if (kind == "unary") {
            auto op = e.at("operator").get<std::string>();
            if (op == "-" && e.at("value").at("kind") == "integer") return integer("-" + e.at("value").at("value").get<std::string>());
            auto v = value(e.at("value"));
            if (op == "not") return !v.get<bool>();
            if (v.is_number_float()) return finite(op == "-" ? -v.get<double>() : v.get<double>());
            return op == "-" ? json(sub(0, v.get<Int>())) : v;
        }
        if (kind == "binary") {
            auto op = e.at("operator").get<std::string>(); auto a = value(e.at("left"));
            if (op == "and") return a.get<bool>() && value(e.at("right")).get<bool>();
            if (op == "or") return a.get<bool>() || value(e.at("right")).get<bool>();
            auto b = value(e.at("right"));
            if (op == "==") return a == b;
            if (op == "!=") return a != b;
            if (op == "+" && a.is_string() && b.is_string()) return a.get<std::string>() + b.get<std::string>();
            if (a.is_number_float() && b.is_number_float()) {
                double x = a.get<double>(), y = b.get<double>();
                if (op == "+") return finite(x + y);
                if (op == "-") return finite(x - y);
                if (op == "*") return finite(x * y);
                if (op == "/") { if (y == 0.0) throw std::runtime_error("Division by zero"); return finite(x / y); }
                if (op == ">") return x > y;
                if (op == ">=") return x >= y;
                if (op == "<") return x < y;
                if (op == "<=") return x <= y;
            }
            Int x = a.get<Int>(), y = b.get<Int>();
            if (op == "+") return add(x, y);
            if (op == "-") return sub(x, y);
            if (op == "*") return mul(x, y);
            if (op == "/" || op == "%") {
                if (!y) throw std::runtime_error("Division by zero");
                if (x == INT64_MIN && y == -1) { if (op == "%") return Int(0); throw std::runtime_error("int64 overflow"); }
                return op == "/" ? x / y : x % y;
            }
            if (op == ">") return x > y;
            if (op == ">=") return x >= y;
            if (op == "<") return x < y;
            if (op == "<=") return x <= y;
        }
        if (kind == "call") {
            json args = json::array(); for (const auto& a : e.at("args")) args.push_back(value(a));
            auto name = e.at("name").get<std::string>();
            if (name.rfind("runtime.state.", 0) == 0) return runtimeStateCall(name, args);
            if (name == "str") return text(args.at(0));
            if (name == "int") {
                if (args.at(0).is_number_float()) {
                    const double number = args.at(0).get<double>();
                    if (!std::isfinite(number) || number < double(INT64_MIN) || number >= double(INT64_MAX)) throw std::runtime_error("int64 overflow");
                    return Int(std::trunc(number));
                }
                return integer(args.at(0).get<std::string>());
            }
            if (name == "float") {
                const auto& argument = args.at(0);
                if (argument.is_string()) return floating(argument.get<std::string>());
                if (argument.is_number_integer()) return finite(double(argument.get<Int>()));
                if (argument.is_number_float()) return finite(argument.get<double>());
                throw std::runtime_error("Invalid float conversion");
            }
            if (name == "list.length") return Int(args.at(0).size());
            if (name == "list.append") { auto result = args.at(0); result.push_back(args.at(1)); return result; }
            if (name == "list.contains") { const auto& values = args.at(0); return std::find(values.begin(), values.end(), args.at(1)) != values.end(); }
            if (name == "text.trim") return normalizeDataSpace(args.at(0).get<std::string>(), false);
            if (name == "text.normalize_space") return normalizeDataSpace(args.at(0).get<std::string>(), true);
            if (name == "text.split") return splitText(args.at(0).get<std::string>(), args.at(1).get<std::string>());
            if (name == "text.replace") return replaceText(args.at(0).get<std::string>(), args.at(1).get<std::string>(), args.at(2).get<std::string>());
            return call(name, args);
        }
        throw std::runtime_error("Unknown expression: " + kind);
    }
    json call(const std::string& name, const json& args) {
        if (!functions.contains(name)) throw std::runtime_error("Unknown function: " + name);
        const auto fn = functions.at(name); auto saved = std::move(locals); auto savedReadonly = std::move(readonlyLocals); auto savedLoops = std::move(loopScopes); loopScopes.clear(); locals = {json::object()}; readonlyLocals = {std::set<std::string>{}};
        for (size_t i = 0; i < fn.at("params").size(); ++i) locals.back()[fn.at("params")[i].at("name").get<std::string>()] = args.at(i);
        try {
            auto r = exec(fn.at("body"));
            if (fn.at("returnType") != "none" && (r.kind != Signal::Return || r.value.is_null())) throw std::runtime_error("Function did not return a value: " + name);
            locals = std::move(saved); readonlyLocals = std::move(savedReadonly); loopScopes = std::move(savedLoops); return r.value;
        } catch (...) { locals = std::move(saved); readonlyLocals = std::move(savedReadonly); loopScopes = std::move(savedLoops); throw; }
    }
    Signal scoped(const json& body) {
        locals.push_back(json::object()); readonlyLocals.emplace_back();
        try { auto r = exec(body); popLocal(); return r; } catch (...) { popLocal(); throw; }
    }
    Signal exec(const json& list, bool preserve = false) {
        for (const auto& c : list) {
            currentSourceFile = c.value("file", program.value("sourceFile", std::string()));
            currentLine = c.value("line", int64_t(0));
            if (beforeInstruction) beforeInstruction(c, currentSceneName);
            const auto op = c.at("op").get<std::string>();
            if (op == "declare") {
                auto name = c.at("name").get<std::string>();
                if (preserve && locals.empty() && globals.contains(name)) {
                    if (!matches(globals.at(name), c.at("type"))) throw std::runtime_error("Global type differs between files: " + name);
                    if (c.value("constant", false)) readonlyGlobals.insert(name);
                    continue;
                }
                auto v = c.contains("initial") ? value(c.at("initial")) : c.at("type") == "int" ? json(0) : c.at("type") == "float" ? json(0.0) : c.at("type") == "str" ? json("") : c.at("type") == "bool" ? json(false) : c.at("type").is_object() && c.at("type").value("kind", "") == "list" ? json::array() : json::object();
                auto frameIndex = locals.size();
                for (size_t n = locals.size(); n > 0; --n) if (!loopScopes.contains(n - 1)) { frameIndex = n - 1; break; }
                declarationFrame()[name] = v;
                if (c.value("constant", false)) { if (frameIndex < locals.size()) readonlyLocals[frameIndex].insert(name); else readonlyGlobals.insert(name); }
            } else if (op == "set" || op == "unset") {
                auto t = c.at("target");
                if (t.at("kind") == "load") {
                    if (op == "unset") throw std::runtime_error("unset requires a dictionary element");
                    auto assigned = value(c.at("value"));
                    assertMutable(t);
                    set(t.at("name"), assigned);
                } else {
                    auto name = t.at("target").at("name").get<std::string>();
                    auto assigned = op == "set" ? value(c.at("value")) : json();
                    assertMutable(t);
                    auto keyValue = value(t.at("key")); auto d = get(name);
                    if (d.is_array()) {
                        if (op == "unset") throw std::runtime_error("unset requires a dictionary element");
                        if (!keyValue.is_number_integer()) throw std::runtime_error("List index must be an integer");
                        const Int index = keyValue.get<Int>();
                        if (index < 0 || uint64_t(index) >= d.size()) throw std::runtime_error("List index out of range: " + std::to_string(index));
                        d.at(size_t(index)) = assigned;
                    } else {
                        if (!keyValue.is_string()) throw std::runtime_error("Dictionary key must be a string");
                        const auto key = keyValue.get<std::string>();
                        if (op == "set") d[key] = assigned;
                        else { if (!d.contains(key)) throw std::runtime_error("Missing dictionary key: " + key); d.erase(key); }
                    }
                    set(name, d);
                }
            } else if (op == "parallel") {
                json batch = json::array();
                for (const auto& instruction : c.at("body")) {
                    if (instruction.value("op", std::string()) != "command") throw std::runtime_error("parallel accepts timed visual commands only");
                    json args = json::array(); for (const auto& argument : instruction.at("args")) args.push_back(value(argument));
                    const auto name = instruction.at("name").get<std::string>();
                    batch.push_back({{"name", name}, {"args", args}});
                }
                if (batch.empty()) throw std::runtime_error("parallel requires at least one command");
                if (parallel) parallel(batch);
                else for (const auto& item : batch) command(item.at("name").get<std::string>(), item.at("args"));
                for (const auto& item : batch) updateRuntimeState(item.at("name").get<std::string>(), item.at("args"));
            } else if (op == "command") {
                json args = json::array(); for (const auto& a : c.at("args")) args.push_back(value(a));
                const auto name = c.at("name").get<std::string>();
                command(name, args);
                updateRuntimeState(name, args);
                if (pendingLoad.is_object()) { auto request = std::move(pendingLoad); pendingLoad = nullptr; return {Signal::Restart, std::move(request)}; }
            } else if (op == "call") value(json{{"kind", "call"}, {"name", c.at("name")}, {"args", c.at("args")}});
            else if (op == "return") return {Signal::Return, c.contains("value") ? value(c.at("value")) : json()};
            else if (op == "goto") return {Signal::Goto, c.at("scene")};
            else if (op == "if") {
                json body = c.at("otherwise");
                if (value(c.at("condition")).get<bool>()) body = c.at("body");
                else for (const auto& b : c.at("elseIf")) if (value(b.at("condition")).get<bool>()) { body = b.at("body"); break; }
                auto r = exec(body); if (r.kind != Signal::Next) return r;
            } else if (op == "choice") {
                std::vector<std::string> labels;
                for (const auto& o : c.at("options")) labels.push_back(interpolate(value(o.at("label"))));
                if (labels.empty()) throw std::runtime_error("Empty choice");
                auto selected = choice(c.contains("prompt") ? interpolate(value(c.at("prompt"))) : "", labels);
                auto r = scoped(c.at("options").at(selected).at("body")); if (r.kind != Signal::Next) return r;
            } else if (op == "while") {
                size_t count = 0;
                while (value(c.at("condition")).get<bool>()) { if (++count > 100000) throw std::runtime_error("Loop limit exceeded"); auto r = exec(count == 1 && c.contains("debugBody") ? c.at("debugBody") : c.at("body")); if (r.kind != Signal::Next) return r; }
            } else if (op == "for") {
                Int start = value(c.at("start")), stop = value(c.at("stop")), step = value(c.at("step"));
                if (!step || (start < stop && step < 0) || (start > stop && step > 0)) throw std::runtime_error("Invalid for step");
                locals.push_back(json::object()); readonlyLocals.emplace_back(); loopScopes.insert(locals.size()-1);
                try {
                    size_t count = 0;
                    for (Int i = start; step > 0 ? i <= stop : i >= stop;) {
                        if (++count > 100000) throw std::runtime_error("Loop limit exceeded");
                        locals.back()[c.at("name").get<std::string>()] = i;
                        auto r = exec(count == 1 && c.contains("debugBody") ? c.at("debugBody") : c.at("body")); if (r.kind != Signal::Next) { popLocal(); return r; }
                        if ((step > 0 && i > INT64_MAX - step) || (step < 0 && i < INT64_MIN - step)) break;
                        i += step;
                    }
                    popLocal();
                } catch (...) { popLocal(); throw; }
            } else if (op == "forEach") {
                auto values = value(c.at("iterable"));
                if (!values.is_array()) throw std::runtime_error("for-in requires a list");
                locals.push_back(json::object()); readonlyLocals.emplace_back(); loopScopes.insert(locals.size()-1);
                try {
                    size_t count = 0;
                    for (const auto& item : values) {
                        if (++count > 100000) throw std::runtime_error("Loop limit exceeded");
                        locals.back()[c.at("name").get<std::string>()] = item;
                        auto r = exec(count == 1 && c.contains("debugBody") ? c.at("debugBody") : c.at("body"));
                        if (r.kind != Signal::Next) { popLocal(); return r; }
                    }
                    popLocal();
                } catch (...) { popLocal(); throw; }
            } else throw std::runtime_error("Unknown instruction: " + op);
        }
        return {};
    }
    static json instructionsFromLine(const json& instructions, const std::string& file, int64_t line) {
        for (size_t index = 0; index < instructions.size(); ++index) {
            const auto& instruction = instructions.at(index);
            const auto instructionFile = instruction.value("file", std::string());
            if ((file.empty() || instructionFile.empty() || instructionFile == file)
                && instruction.value("line", int64_t(0)) >= line) {
                json suffix = json::array();
                for (size_t next = index; next < instructions.size(); ++next) suffix.push_back(instructions.at(next));
                return suffix;
            }
            std::vector<json> bodies;
            const auto op = instruction.value("op", std::string());
            if (op == "if") {
                bodies.push_back(instruction.value("body", json::array()));
                for (const auto& branch : instruction.value("elseIf", json::array())) bodies.push_back(branch.value("body", json::array()));
                bodies.push_back(instruction.value("otherwise", json::array()));
            } else if (op == "choice") {
                for (const auto& option : instruction.value("options", json::array())) bodies.push_back(option.value("body", json::array()));
            } else if (op == "for" || op == "forEach" || op == "while") bodies.push_back(instruction.value("body", json::array()));
            for (const auto& body : bodies) {
                auto suffix = instructionsFromLine(body, file, line);
                if (!suffix.is_null()) {
                    if (op == "for" || op == "forEach" || op == "while") {
                        json resumed = instruction;
                        resumed["debugBody"] = std::move(suffix);
                        json result = json::array({std::move(resumed)});
                        for (size_t next = index + 1; next < instructions.size(); ++next) result.push_back(instructions.at(next));
                        return result;
                    }
                    for (size_t next = index + 1; next < instructions.size(); ++next) suffix.push_back(instructions.at(next));
                    return suffix;
                }
            }
        }
        return nullptr;
    }
    void run(json p, json debug = nullptr) {
        bool transferred = false;
        runtimeCharacterSlots.clear();
        currentSceneName.clear(); currentSourceFile.clear(); currentLine = 0;
        runtimeBackground.clear(); runtimeBgm.clear();
        runtimeDialogOpacity = 1.0;
        runtimeDialogOpacityExplicit = false;
        runtimeAudioVolumes = {{"bgm", 1.0}, {"se", 1.0}, {"voice", 0.5}};
        runtimeAudioVolumeOverrides.clear();
        if (debug.is_object() && debug.contains("presentation")) restoreRuntimeState(debug.at("presentation"));
        for (;;) {
            if (p.at("version") != 2) throw std::runtime_error("Unsupported program version");
            program = p; functions.clear();
            for (const auto& fn : p.at("functions")) functions[fn.at("name")] = fn;
            auto r = exec(p.at("globals"), transferred);
            std::map<std::string, json> scenes;
            for (const auto& s : p.at("scenes")) scenes[s.at("name")] = s.at("instructions");
            if (!transferred && debug.is_object() && debug.contains("variables")) {
                for (auto it = debug.at("variables").begin(); it != debug.at("variables").end(); ++it) globals[it.key()] = it.value();
            }
            if (!transferred && debug.is_object() && debug.contains("locals") && debug.at("locals").is_array()) {
                locals = debug.at("locals").get<std::vector<json>>();
                readonlyLocals.assign(locals.size(), std::set<std::string>{});
                const auto readonly = debug.value("readonlyLocals", json::array());
                for (size_t frame = 0; frame < std::min(readonly.size(), readonlyLocals.size()); ++frame)
                    for (const auto& name : readonly.at(frame)) readonlyLocals[frame].insert(name.get<std::string>());
                loopScopes.clear();
                for (const auto& frame : debug.value("loopScopes", json::array())) {
                    const auto index = frame.get<size_t>(); if (index < locals.size()) loopScopes.insert(index);
                }
            }
            const json* first = p.at("scenes").empty() ? nullptr : &p.at("scenes").at(0);
            if (!transferred && debug.is_object() && debug.contains("scene")) {
                first = nullptr;
                for (const auto& scene : p.at("scenes")) if (scene.value("name", std::string()) == debug.at("scene").get<std::string>()) { first = &scene; break; }
                if (!first) throw std::runtime_error("Unknown debug scene: " + debug.at("scene").get<std::string>());
            }
            currentSceneName = first ? first->value("name", std::string()) : std::string();
            if (!transferred && debug.is_object() && debug.contains("presentation")) {
                restoreRuntimeState(debug.at("presentation"));
                if (restorePresentation) restorePresentation(debug.at("presentation"));
            }
            json instructions = json::array();
            if (first) {
                instructions = first->at("instructions");
                if (!transferred && debug.is_object() && debug.contains("line") && !debug.at("line").is_null()) {
                    const auto suffix = instructionsFromLine(instructions, debug.value("file", std::string()), debug.at("line").get<int64_t>());
                    if (suffix.is_null()) throw std::runtime_error("Debug line has no executable instruction in the selected scene");
                    instructions = suffix;
                }
            }
            if (r.kind == Signal::Next && first) r = exec(instructions);
            while (r.kind == Signal::Goto && scenes.contains(r.value.get<std::string>())) { currentSceneName = r.value.get<std::string>(); r = exec(scenes.at(currentSceneName)); }
            if (r.kind == Signal::Restart) {
                debug = std::move(r.value);
                const auto file = debug.value("file", std::string());
                if (file.empty() || !load) throw std::runtime_error("Save slot is missing its scenario file");
                runtimeCharacterSlots.clear();
                if (debug.contains("presentation")) restoreRuntimeState(debug.at("presentation"));
                p = load(file); transferred = false; continue;
            }
            if (r.kind == Signal::Next) return;
            if (r.kind != Signal::Goto || !load) throw std::runtime_error("Invalid scene transfer");
            p = load(r.value); transferred = true;
        }
    }
};
}
