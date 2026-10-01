#include "screen_webview.hpp"

#ifdef _WIN32
#include <windows.h>
#include <wrl.h>
#include <WebView2.h>
#include <algorithm>
#include <utility>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

namespace {
std::wstring widen(const std::string& source) {
    if (source.empty()) return {};
    const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, source.data(), int(source.size()), nullptr, 0);
    if (!length) return {};
    std::wstring result(size_t(length), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, source.data(), int(source.size()), result.data(), length);
    return result;
}
std::string narrow(const std::wstring& source) {
    if (source.empty()) return {};
    const int length = WideCharToMultiByte(CP_UTF8, 0, source.data(), int(source.size()), nullptr, 0, nullptr, nullptr);
    std::string result(size_t(length), '\0');
    WideCharToMultiByte(CP_UTF8, 0, source.data(), int(source.size()), result.data(), length, nullptr, nullptr);
    return result;
}
constexpr const char* bridge = R"NOVEL(
<script>
'use strict';
(() => {
  const slots = document.querySelectorAll('[data-role="save-slots"],[data-role="load-slots"]');
  for (const host of slots) {
    const sample = host.querySelector(':scope > button');
    const count = Math.min(100, Math.max(1, Number(host.dataset.count || 8)));
    const role = host.dataset.role;
    host.replaceChildren();
    for (let index = 0; index < count; index++) {
      const item = sample ? sample.cloneNode(true) : document.createElement('button');
      item.type = 'button';
      item.dataset.action = role === 'save-slots' ? 'save' : 'load';
      item.dataset.slotIndex = String(index);
      host.append(item);
    }
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    window.chrome.webview.postMessage({kind:'action', action:button.dataset.action,
      target:button.dataset.target || '', slotIndex:button.dataset.slotIndex ?? null});
  });
  const changed = event => {
    const input = event.target.closest('input[data-setting]');
    if (!input) return;
    window.chrome.webview.postMessage({kind:'setting', key:input.dataset.setting,
      value:input.type === 'checkbox' ? input.checked : Number(input.value)});
  };
  document.addEventListener('input', changed);
  document.addEventListener('change', changed);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') window.chrome.webview.postMessage({kind:'back'});
  });
  window.NovelUI = {
    render(model) {
      const byIndex = model.slots || [];
      document.querySelectorAll('[data-slot-index]').forEach(button => {
        const index = Number(button.dataset.slotIndex);
        const saved = byIndex[index] || null;
        button.disabled = button.dataset.action === 'load' ? !saved?.loadable : !model.canSave;
        button.dataset.state = saved?.status || 'empty';
        button.setAttribute('aria-label', `${index + 1} ${saved?.loadable ? saved.scene + ' ' + saved.text : saved?.status || '空き'}`);
        button.querySelectorAll('[data-slot-field]').forEach(field => {
          const key = field.dataset.slotField;
          let value = key === 'number' ? String(index + 1).padStart(2,'0')
            : key === 'status' ? ({ready:'記録あり',empty:'空き',corrupt:'破損',incompatible:'非対応'})[button.dataset.state]
            : saved && key === 'saved-at' ? saved.savedAtText || ''
            : saved ? saved[key] || '' : '';
          if (field.tagName === 'IMG') {
            if (key === 'thumbnail' && saved?.thumbnail) field.src = saved.thumbnail;
            else field.removeAttribute('src');
          }
          else field.textContent = String(value);
        });
      });
      document.querySelectorAll('[data-action="continue"]').forEach(button => button.disabled = !model.continueAvailable);
      document.querySelectorAll('input[data-setting]').forEach(input => {
        const value = model.settings?.[input.dataset.setting];
        if (value === undefined) return;
        if (input.type === 'checkbox') input.checked = Boolean(value);
        else if (document.activeElement !== input) input.value = String(value);
      });
    }
  };
  const canvas = document.getElementById('novel-canvas');
  const fit = () => {
    const width = Number(canvas.dataset.width), height = Number(canvas.dataset.height);
    canvas.style.transform = `scale(${innerWidth / width},${innerHeight / height})`;
  };
  addEventListener('resize', fit);
  fit();
  window.chrome.webview.postMessage({kind:'ready'});
})();
</script>
)NOVEL";
}

namespace native_player {
struct ScreenWebView::Impl {
    HWND parent = nullptr;
    std::filesystem::path packageRoot, userDataRoot;
    ComPtr<ICoreWebView2Environment> environment;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> web;
    std::vector<nlohmann::json> messages;
    std::string currentId, modelText;
    std::wstring pendingDocument;
    bool initializedCom = false, loaded = false, failed = false, visible = false;
    std::string state = "initializing";
    int imageProbe = -1;

    Impl(void* handle, const std::filesystem::path& package, const std::filesystem::path& data)
        : parent(static_cast<HWND>(handle)), packageRoot(package), userDataRoot(data) {
        if (!parent) { failed = true; state = "no parent window"; return; }
        const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        if (FAILED(initialized)) { failed = true; state = "COM init " + std::to_string(initialized); return; }
        initializedCom = true;
        std::filesystem::create_directories(userDataRoot);
        const auto dataPath = (userDataRoot / "webview2").wstring();
        const HRESULT result = CreateCoreWebView2EnvironmentWithOptions(nullptr, dataPath.c_str(), nullptr,
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
                [this](HRESULT status, ICoreWebView2Environment* created) -> HRESULT {
                    if (FAILED(status) || !created) { failed = true; state = "environment " + std::to_string(status); return S_OK; }
                    state = "environment ready";
                    environment = created;
                    return environment->CreateCoreWebView2Controller(parent,
                        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                            [this](HRESULT controllerStatus, ICoreWebView2Controller* createdController) -> HRESULT {
                                if (FAILED(controllerStatus) || !createdController) { failed = true; state = "controller " + std::to_string(controllerStatus); return S_OK; }
                                state = "controller ready";
                                controller = createdController;
                                if (FAILED(controller->get_CoreWebView2(&web))) { failed = true; state = "web creation failed"; return S_OK; }
                                ComPtr<ICoreWebView2Controller2> colorController;
                                if (SUCCEEDED(controller.As(&colorController))) colorController->put_DefaultBackgroundColor(COREWEBVIEW2_COLOR{0,0,0,0});
                                ComPtr<ICoreWebView2_3> resources;
                                if (SUCCEEDED(web.As(&resources))) {
                                    resources->SetVirtualHostNameToFolderMapping(L"novel.invalid", packageRoot.wstring().c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
                                    resources->SetVirtualHostNameToFolderMapping(L"novel-save.invalid", userDataRoot.wstring().c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
                                }
                                ComPtr<ICoreWebView2Settings> settings;
                                if (SUCCEEDED(web->get_Settings(&settings))) {
                                    settings->put_AreDevToolsEnabled(FALSE);
                                    settings->put_AreDefaultContextMenusEnabled(FALSE);
                                    settings->put_IsWebMessageEnabled(TRUE);
                                }
                                EventRegistrationToken token{};
                                web->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
                                    [this](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                                        LPWSTR uri = nullptr;
                                        if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
                                            const std::wstring address(uri);
                                            state = "navigation starting " + narrow(address.substr(0,80));
                                            const bool permitted = address == L"about:blank" || address == L"about:blank/"
                                                || address.starts_with(L"data:text/html;charset=utf-8;base64,");
                                            CoTaskMemFree(uri);
                                            if (!permitted) args->put_Cancel(TRUE);
                                        }
                                        return S_OK;
                                    }).Get(), &token);
                                web->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
                                    [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                                        args->put_Handled(TRUE); return S_OK;
                                    }).Get(), &token);
                                web->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                                    [this](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                                        LPWSTR raw = nullptr;
                                        if (FAILED(args->get_WebMessageAsJson(&raw)) || !raw) return S_OK;
                                        const std::wstring text(raw); CoTaskMemFree(raw);
                                        if (text.size() > 8192) return S_OK;
                                        const auto value = nlohmann::json::parse(narrow(text),nullptr,false);
                                        if (value.is_object() && value.contains("kind") && value.at("kind").is_string()) {
                                            if (value.at("kind") == "ready") { loaded = true; state = "document ready"; sendModel(); }
                                            else if (value.at("kind") == "probe" && value.value("loaded",false)) imageProbe = 1;
                                            else if (value.at("kind") == "probe") imageProbe = 0;
                                            else messages.push_back(value);
                                        }
                                        return S_OK;
                                    }).Get(), &token);
                                resize();
                                web->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>(
                                    [this](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
                                        BOOL success = FALSE; args->get_IsSuccess(&success);
                                        COREWEBVIEW2_WEB_ERROR_STATUS error{}; args->get_WebErrorStatus(&error);
                                        state = success ? "navigation complete, waiting for bridge" : "navigation failed " + std::to_string(error) + " after " + state;
                                        return S_OK;
                                    }).Get(), &token);
                                controller->put_IsVisible(FALSE);
                                if (!pendingDocument.empty()) navigate();
                                return S_OK;
                            }).Get());
                }).Get());
        if (FAILED(result)) { failed = true; state = "environment launch " + std::to_string(result); }
    }
    ~Impl() {
        if (controller) controller->Close();
        web.Reset(); controller.Reset(); environment.Reset();
        if (initializedCom) CoUninitialize();
    }
    void resize() {
        if (!controller) return;
        RECT rect{}; GetClientRect(parent,&rect);
        controller->put_Bounds(rect);
    }
    void navigate() {
        if (!web || pendingDocument.empty()) return;
        loaded = false;
        const auto result = web->NavigateToString(pendingDocument.c_str());
        state = SUCCEEDED(result) ? "navigating" : "NavigateToString " + std::to_string(result);
        controller->put_IsVisible(visible ? TRUE : FALSE);
    }
    void sendModel() {
        if (!web || !loaded || modelText.empty()) return;
        const auto script = widen("window.NovelUI&&window.NovelUI.render(" + modelText + ");");
        web->ExecuteScript(script.c_str(),nullptr);
    }
};

ScreenWebView::ScreenWebView(void* nativeWindow, const std::filesystem::path& packageRoot,
    const std::filesystem::path& userDataRoot)
    : impl_(std::make_unique<Impl>(nativeWindow,packageRoot,userDataRoot)) {}
ScreenWebView::~ScreenWebView() = default;
bool ScreenWebView::ready() const { return impl_ && impl_->web && impl_->loaded && !impl_->failed; }
std::string ScreenWebView::status() const { return impl_ ? impl_->state : "unavailable"; }
void ScreenWebView::show(const std::string& screenId, const std::string& markup,
    const std::string& stylesheet, const nlohmann::json& model) {
    if (!impl_ || impl_->failed) return;
    impl_->visible = true;
    const auto nextModel = model.dump();
    if (impl_->currentId == screenId) {
        if (impl_->modelText != nextModel) { impl_->modelText = nextModel; impl_->sendModel(); }
        if (impl_->controller) impl_->controller->put_IsVisible(TRUE);
        return;
    }
    impl_->currentId = screenId;
    impl_->modelText = nextModel;
    // Markup and CSS are validated by the screen compiler before packaging.
    const auto html = std::string("<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\">"
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src https://novel.invalid https://novel-save.invalid; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri https://novel.invalid; connect-src 'none'; frame-src 'none'; form-action 'none'\">"
        "<base href=\"https://novel.invalid/\"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}"
        "#novel-canvas{position:absolute;left:0;top:0;transform-origin:top left}") + stylesheet
        + "</style></head><body><div id=\"novel-canvas\" data-width=\"" + std::to_string(model.value("canvasWidth",1280))
        + "\" data-height=\"" + std::to_string(model.value("canvasHeight",720)) + "\">" + markup + "</div>" + bridge + "</body></html>";
    impl_->pendingDocument = widen(html);
    impl_->navigate();
}
void ScreenWebView::hide() {
    if (!impl_) return;
    impl_->visible = false;
    impl_->currentId.clear();
    if (impl_->controller) impl_->controller->put_IsVisible(FALSE);
}
void ScreenWebView::resize() { if (impl_) impl_->resize(); }
std::vector<nlohmann::json> ScreenWebView::takeMessages() {
    if (!impl_) return {};
    auto result = std::move(impl_->messages);
    impl_->messages.clear();
    return result;
}
void ScreenWebView::clickForTest(const std::string& action, const std::string& target) {
    if (!ready()) return;
    const auto script = widen("Array.from(document.querySelectorAll('button[data-action]')).find(button => button.dataset.action === "
        + nlohmann::json(action).dump() + " && button.dataset.target === " + nlohmann::json(target).dump()
        + ")?.click();");
    impl_->web->ExecuteScript(script.c_str(),nullptr);
}
void ScreenWebView::probeImageForTest(const std::string& elementId) {
    if (!ready()) return;
    impl_->imageProbe = -1;
    const auto script = widen("setTimeout(() => { const image = document.getElementById(" + nlohmann::json(elementId).dump()
        + "); window.chrome.webview.postMessage({kind:'probe',loaded:!!image && image.complete && image.naturalWidth>0}); }, 600);");
    impl_->web->ExecuteScript(script.c_str(),nullptr);
}
int ScreenWebView::imageProbeResult() const { return impl_ ? impl_->imageProbe : -1; }
void ScreenWebView::setSettingForTest(const std::string& key, double value) {
    if (!ready()) return;
    const auto script = widen("const input = Array.from(document.querySelectorAll('input[data-setting]')).find(input => input.dataset.setting === "
        + nlohmann::json(key).dump() + "); if (input) { input.value = " + nlohmann::json(value).dump()
        + "; input.dispatchEvent(new Event('input',{bubbles:true})); }");
    impl_->web->ExecuteScript(script.c_str(),nullptr);
}
std::pair<int,int> ScreenWebView::boundsForTest() const {
    if (!impl_ || !impl_->controller) return {0,0};
    RECT rectangle{};
    if (FAILED(impl_->controller->get_Bounds(&rectangle))) return {0,0};
    return {rectangle.right - rectangle.left, rectangle.bottom - rectangle.top};
}
} // namespace native_player

#else
namespace native_player {
struct ScreenWebView::Impl {};
ScreenWebView::ScreenWebView(void*, const std::filesystem::path&, const std::filesystem::path&) {}
ScreenWebView::~ScreenWebView() = default;
bool ScreenWebView::ready() const { return false; }
std::string ScreenWebView::status() const { return "WebView2 is Windows-only"; }
void ScreenWebView::show(const std::string&, const std::string&, const std::string&, const nlohmann::json&) {}
void ScreenWebView::hide() {}
void ScreenWebView::resize() {}
std::vector<nlohmann::json> ScreenWebView::takeMessages() { return {}; }
void ScreenWebView::clickForTest(const std::string&, const std::string&) {}
void ScreenWebView::probeImageForTest(const std::string&) {}
int ScreenWebView::imageProbeResult() const { return -1; }
void ScreenWebView::setSettingForTest(const std::string&, double) {}
std::pair<int,int> ScreenWebView::boundsForTest() const { return {0,0}; }
}
#endif
