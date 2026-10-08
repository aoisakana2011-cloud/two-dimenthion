# 検証階層・開発コマンド・配布物

この文書は開発時のbuild/test commandと、実際の配布経路を区別して記録する。言語/compilerは [`compiler-pipeline.md`](compiler-pipeline.md)、project packageの中身は [`project-format-and-packaging.md`](project-format-and-packaging.md)、Browser/Native runtimeと保存差は [`runtime-semantics.md`](runtime-semantics.md) と [`save-data-and-migration.md`](save-data-and-migration.md) を参照。

## 1. Toolchain

`package.json`はCommonJSのNode projectで、TypeScript compilerはdev dependency、ElectronとElectron Packagerも開発・配布用dependencyです。scriptsは以下の責務を持ちます。

| Command | 実際に行うこと | それだけでは確認しないこと |
|---|---|---|
| `npm.cmd run build` | `tsc`で`src/`をcompileし`dist/`を生成 | Browser/Native実画面、project pack |
| `npm.cmd test` | build成功後、`node --test test/*.test.js`を実行 | `*.browser.cjs`、Native process全体、配布後のOS実動作 |
| `npm.cmd run editor` | TypeScript build後に `Edit/server.js` を起動 | Electron native dialog、Native renderer |
| `npm.cmd run format` | `tools/format.js`によるTDS formatter | 型解析・pack成功 |
| `npm.cmd run pack -- --project <dir>` | projectからNSP packageを作成 | そのpackageをNative/Browser両方で正常表示できること |
| `npm.cmd run native:build` | CMake configure/build、Windows x64 Release player | game UIのE2Eや各projectのpackage |
| `npm.cmd run native -- --project <dir>` | projectの生成済みNSPとNative executableを起動 | package自動生成（必要なら先にpack） |
| `npm.cmd run desktop` | TypeScript build後Electron Editorを起動 | packaged app内での依存DLL/Native asset配置 |
| `npm.cmd run desktop:package:win` | Windows x64 Electron appを `release/` 等へ作成 | 別PCでの署名、インストール、runtime環境全組合せ |

PowerShellでは `npm.ps1` 実行ポリシーの影響を避けるため `npm.cmd` を使います。

## 2. テストの層

| 層 | よくあるファイル | 検証可能な境界 |
|---|---|---|
| Unit/contract | `test/*.test.js` | pure helper、parser/compiler、schema、static validation、storage adapter |
| Browser interaction | `test/*.browser.cjs` | DOM、keyboard/pointer、player overlay、保存画面、見た目state、実HTTP接続のUI経路 |
| API origin boundary | `test/api-origin.browser.cjs` | 別originのsimple POST、same-site別port request、spoofed Hostを拒否し、Originなしのloopback clientを許可 |
| Native integration | `test/*native*.cjs`, `test/native-*.cjs` | C++ executable起動、SDL input/render経路、Native save/screen動作 |
| workflow/E2E | `test/full-workflow-e2e.cjs`, project-specific browser tests | Editor save/build/browser/native integrationを繋ぐ限定シナリオ |
| C++ unit | `native/*_test.cpp` | isolated geometry/audio helper。Player全体の代替ではない |
| audit regression | `test/audit-regression.test.js`, `test/fixtures/audit-cases.json` | 既知の言語・解析回帰条件 |

`npm test`のglobは `test/*.test.js` です。拡張子`.browser.cjs`のBrowserテストや`.cjs` Native integrationを一括で含むとは限りません。各Browser/native harnessの個別入口と必要な実行環境を見て実行します。

## 3. 変更種別ごとの検証範囲

### 構文・静的解析・命令

- Parserの変更: `test/parser.test.js`, `test/language-reference.test.js`。
- 型/診断/domain変更: `test/audit-regression.test.js`, `test/global-scope.test.js`, Flow domains tests。
- 命令形式/compiler/runtime: compiler differential/unitに加え `test/runtime.test.js` と少なくとも対応するPlayer path。

### Project paths・pack

- project root/layout: `test/project-layout.test.js`。
- safe path設定API: `test/project-settings-security.test.js`。
- include/Goto/asset/build: scene graph include scope、packやworkflow tests。

### Editor/UI

- keyboard/IME/selection: Browser typing test。
- dirty/save/外部更新: `project-changes` unit + Browser tests。
- screen document: compiler/schema unitに加えBrowser screen testとNative screen harness。
- save/load: store unitだけで完結させず、Browser `save-load.browser.cjs`とNative `native-save-load.cjs`を選ぶ。

テストファイルがあることは、そのテストが現在passしたことを示しません。またBrowser mock/DOM checksだけではNative SDLの画面、保存場所、入力、音声を確認したことになりません。

## 4. Project packageとEditor配布は別物

### 作品package

`npm.cmd run pack -- --project Title` はTypeScript build後、作品projectをNSP runtime packageにします。通常の出力先はprojectの`.novel/build/`です。Native playerはこの作品packageとassetsを読み込んで再生します。packはNSP JSONと参照assetをstageしてから出力先へ移し、通常の例外時には更新対象をrollbackします。失敗時は前回成功したpackageが保持されます。Editor Buildは開始時に以前のbuild-stateを無効化し、成功後にだけ更新するため、失敗後のPlayでは再buildが必要です。作品packageはEditorのインストーラーではありません。

### Native player build

`tools/native-build.js`はCMakeを呼び、`native/.vcpkg/scripts/buildsystems/vcpkg.cmake` toolchain、`native/vcpkg_installed`、`x64-windows` tripletを使って`native/build`へconfigureし、Releaseをbuildします。`tools/native.js`は`native/build/Release/novel_player.exe`と対象NSPの存在を確認してからprocessをspawnします。別のpackage fileをpositional argに渡せます。

### Desktop Editor package

`tools/package-electron.js`は先にNative executableがあることを要求します。Electron Packagerをwin32/x64に固定し、Windows icon/metadataを設定します。既定outputはrepository `release/`で、`NOVEL_EDITOR_PACKAGE_OUT`で変更できます。asarはfalse。依存をpruneし、Native executable、DLL群、image checker、`engine_data`をElectron package内の`resources/app/native/build/Release/`に含めます。`Edit/server.js`は`resources/app`をrepository rootとして扱い、同じ相対パスからNative executableとimage checkerを起動します。

packagerは`.git`, `node_modules`, `release`, `build`, `test`, `src`, `llama.cpp`, `Title`などを除外し、projectデータをDesktop Editor binaryへ同梱しません。起動後の作品選択・project data保存はEditor runtimeの仕事です。

## 5. 配布後の確認項目

Windows packageを成立と判断するには、ビルド成功以外に実際に生成されたfolderを調べます。

1. `NovelScriptEditor.exe`とElectron runtime filesが配布フォルダー直下にあり、Native playerとDLLは`resources/app/native/build/Release/`にある。
2. `engine_data`、SDL image/font/mixer、FFmpeg等のruntime dependencyをNative playerと同じディレクトリに含む。
3. fresh launchで最新の有効なrecent projectを開く。有効なrecent projectがない場合はtemporary workspaceで通常のEditorを開き、作品を開く・作成する・編集することができる。
4. duplicate launchは既存のEditor windowにfocusし、2つ目のwindowやproject serverを作らない。
5. EditorからBrowser Player、Native Playerを別々に起動できる。
6. 保存/build outputが選択したproject rootへ書かれ、package folderや別projectを不用意に変更しない。

これらは配布物を実際に起動して確かめる必要があります。`npm run desktop:package:win`が終了コード0でも、別環境での初回導入、権限、GPU/codec全組合せは証明されません。

## 6. 現在の網羅外・運用上の注意

- package script `test`は全Browser/Native E2Eを暗黙に実行しません。
- Native CMake buildは現在Windows x64 Releaseを明示している。
- `native/build-legacy-n-drive`等の既存build directoryと現行 `native/build`を混ぜず、実行したbinaryを記録する。
- packやplayer smokeは作品`.novel/build/`、save、thumbnail等のfixture outputを更新し得る。既存project dataがdirtyな状態では事前・事後に対象パスを確認する。
- test successは該当レイヤーの挙動根拠であり、全system/browser/OS一律の互換性主張ではない。

## 7. 関連資料

- [構文仕様](syntax-reference.md)
- [コンパイラ・pack仕様](compiler-pipeline.md)
- [IDE仕様](ide-spec.md)
- [UI/Player仕様](ui-runtime-spec.md)
- [セーブデータ仕様](save-data-and-migration.md)
- `native/README.md`
