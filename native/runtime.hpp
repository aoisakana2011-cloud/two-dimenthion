#pragma once
#include <nlohmann/json.hpp>
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
inline std::string text(const json& v) { return v.is_string() ? v.get<std::string>() : v.is_null() ? "" : v.dump(); }
inline bool matches(const json& v, const json& type) {
    if (type == "int") return v.is_number_integer();
    if (type == "str") return v.is_string();
    if (type.is_object() && type.value("kind", "") == "struct") return v.is_object();
    if (!v.is_object() || !type.is_object()) return false;
    for (const auto& value : v) if (!matches(value, type.at("value"))) return false;
    return true;
}
struct Signal { enum Kind { Next, Return, Goto } kind = Next; json value; };
class Runtime {
public:
    json globals = json::object(), program;
    std::function<void(const std::string&, const json&)> command;
    std::function<size_t(const std::string&, const std::vector<std::string>&)> choice;
    std::function<json(const std::string&)> load;
    std::vector<json> locals;
    std::set<std::string> readonlyGlobals;
    std::vector<std::set<std::string>> readonlyLocals;
    std::set<size_t> loopScopes;
    void popLocal() { loopScopes.erase(locals.size()-1); locals.pop_back(); readonlyLocals.pop_back(); }
    json& declarationFrame() { for(size_t i=locals.size();i>0;--i) if(!loopScopes.contains(i-1))return locals[i-1];return globals; }
    std::map<std::string, json> functions;
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
    std::string interpolate(const json& v) const {
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
        return out + s.substr(offset);
    }
    json value(const json& e) {
        if (e.is_null()) return nullptr;
        const auto kind = e.at("kind").get<std::string>();
        if (kind == "integer") return integer(e.at("value"));
        if (kind == "literal") {
            auto v = e.at("value");
            if (v.is_number_unsigned() && v.get<uint64_t>() > INT64_MAX) throw std::runtime_error("int64 overflow");
            return v;
        }
        if (kind == "load") return get(e.at("name"));
        if (kind == "dict") { json d = json::object(); for (const auto& item : e.at("entries")) d[item.at("key").get<std::string>()] = value(item.at("value")); return d; }
        if (kind == "index") {
            auto d = value(e.at("target")); auto k = value(e.at("key")).get<std::string>();
            if (!d.is_object() || !d.contains(k)) throw std::runtime_error("Missing dictionary key: " + k);
            return d.at(k);
        }
        if (kind == "unary") {
            auto op = e.at("operator").get<std::string>();
            if (op == "-" && e.at("value").at("kind") == "integer") return integer("-" + e.at("value").at("value").get<std::string>());
            auto v = value(e.at("value"));
            if (op == "not") return !v.get<bool>();
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
            if (name == "str") return text(args.at(0));
            if (name == "int") return integer(args.at(0).get<std::string>());
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
            const auto op = c.at("op").get<std::string>();
            if (op == "declare") {
                auto name = c.at("name").get<std::string>();
                if (preserve && locals.empty() && globals.contains(name)) {
                    if (!matches(globals.at(name), c.at("type"))) throw std::runtime_error("Global type differs between files: " + name);
                    if (c.value("constant", false)) readonlyGlobals.insert(name);
                    continue;
                }
                auto v = c.contains("initial") ? value(c.at("initial")) : c.at("type") == "int" ? json(0) : c.at("type") == "str" ? json("") : json::object();
                auto frameIndex = locals.size();
                for (size_t n = locals.size(); n > 0; --n) if (!loopScopes.contains(n - 1)) { frameIndex = n - 1; break; }
                declarationFrame()[name] = v;
                if (c.value("constant", false)) { if (frameIndex < locals.size()) readonlyLocals[frameIndex].insert(name); else readonlyGlobals.insert(name); }
            } else if (op == "set" || op == "unset") {
                auto t = c.at("target");
                assertMutable(t);
                if (t.at("kind") == "load") {
                    if (op == "unset") throw std::runtime_error("unset requires a dictionary element");
                    set(t.at("name"), value(c.at("value")));
                } else {
                    auto name = t.at("target").at("name").get<std::string>();
                    auto assigned = op == "set" ? value(c.at("value")) : json();
                    auto key = value(t.at("key")).get<std::string>(); auto d = get(name);
                    if (op == "set") d[key] = assigned;
                    else { if (!d.contains(key)) throw std::runtime_error("Missing dictionary key: " + key); d.erase(key); }
                    set(name, d);
                }
            } else if (op == "command") {
                json args = json::array(); for (const auto& a : c.at("args")) args.push_back(value(a));
                command(c.at("name"), args);
            } else if (op == "sayBlock") {
                auto speaker = value(c.at("speaker"));
                for (const auto& line : c.at("lines")) command("say", json::array({speaker, value(line)}));
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
                while (value(c.at("condition")).get<bool>()) { if (++count > 100000) throw std::runtime_error("Loop limit exceeded"); auto r = exec(c.at("body")); if (r.kind != Signal::Next) return r; }
            } else if (op == "for") {
                Int start = value(c.at("start")), stop = value(c.at("stop")), step = value(c.at("step"));
                if (!step || (start < stop && step < 0) || (start > stop && step > 0)) throw std::runtime_error("Invalid for step");
                locals.push_back(json::object()); readonlyLocals.emplace_back(); loopScopes.insert(locals.size()-1);
                try {
                    size_t count = 0;
                    for (Int i = start; step > 0 ? i <= stop : i >= stop;) {
                        if (++count > 100000) throw std::runtime_error("Loop limit exceeded");
                        locals.back()[c.at("name").get<std::string>()] = i;
                        auto r = exec(c.at("body")); if (r.kind != Signal::Next) { popLocal(); return r; }
                        if ((step > 0 && i > INT64_MAX - step) || (step < 0 && i < INT64_MIN - step)) break;
                        i += step;
                    }
                    popLocal();
                } catch (...) { popLocal(); throw; }
            } else throw std::runtime_error("Unknown instruction: " + op);
        }
        return {};
    }
    void run(json p) {
        bool transferred = false;
        for (;;) {
            if (p.at("version") != 2) throw std::runtime_error("Unsupported program version");
            program = p; functions.clear();
            for (const auto& fn : p.at("functions")) functions[fn.at("name")] = fn;
            auto r = exec(p.at("globals"), transferred);
            std::map<std::string, json> scenes;
            for (const auto& s : p.at("scenes")) scenes[s.at("name")] = s.at("instructions");
            if (r.kind == Signal::Next && !p.at("scenes").empty()) r = exec(p.at("scenes").at(0).at("instructions"));
            while (r.kind == Signal::Goto && scenes.contains(r.value.get<std::string>())) r = exec(scenes.at(r.value.get<std::string>()));
            if (r.kind == Signal::Next) return;
            if (r.kind != Signal::Goto || !load) throw std::runtime_error("Invalid scene transfer");
            p = load(r.value); transferred = true;
        }
    }
};
}
