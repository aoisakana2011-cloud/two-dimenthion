# Novel Script Editor 現行企画・実装仕様書

更新日: 2026-09-30  
対象: このリポジトリにあるエディター、TDS言語、解析・コンパイラー、Browser/Nativeプレイヤー、作品設定と配布処理。

> この文書は将来案ではなく、現行ソースを読んでまとめた実装仕様です。設定例や画面が存在するだけで、実機能が実装されているとは判断していません。根拠となる主な実装箇所は各節に記載します。言語の細かな構文は [構文リファレンス](../syntax-draft.md) が正本です。

## 1. 企画概要

Novel Script Editorは、テキストDSL「TDS」でビジュアルノベルを制作する、Windowsを主対象としたローカル型エディター／実行環境である。作品データとエディター本体を分け、シナリオ、画像・音声・動画、画面設定を作品フォルダーで管理する。エディター内で編集・静的解析・Scene Flow確認を行い、Browserで試験再生し、同じコンパイル済みプログラムをNativeプレイヤーで実再生・配布できる構成を採る。

主要な設計軸は次の通り。

1. シナリオ本文は人が編集できる `.tds` テキストを正本とする。
2. 型・構文・到達性・演出状態を解析し、実行可能なJSON命令列に変換する。
3. 編集アプリは作品外に置き、作品フォルダーを開いて編集する。
4. Browser/Nativeは同じコンパイル形式を読み、表示・入力・音声の実装だけを各環境が担当する。
5. タイトルやセーブ画面は制限付きHTML/CSSを共通UIツリーへ変換し、任意JavaScript実行を許さない。

## 2. 製品の構成と使用技術

| 領域 | 実装技術 | 主な入口 |
|---|---|---|
| コンパイラー／静的解析 | TypeScript 5.7、Node.js、CommonJS出力 | `src/`, `tools/project.js` |
| Webエディター | HTML/CSS/Vanilla JavaScript、Node.js HTTPサーバー | `Edit/index.html`, `Edit/editor.js`, `Edit/server.js` |
| デスクトップ版 | Electron 44、preload経由の限定IPC | `Edit/electron-main.js`, `Edit/preload.js` |
| Browserプレイヤー | HTML/CSS/JavaScript、共通JSONランタイム | `Edit/player.html`, `Edit/player.js`, `Edit/runtime.js` |
| Nativeプレイヤー | C++20、SDL3、SDL_ttf、SDL_image、SDL_mixer、nlohmann/json、FFmpeg | `native/main.cpp`, `native/player.cpp`, `native/runtime.hpp` |
| ビルド／配布 | TypeScript compiler、CMake、vcpkg、Electron Packager | `tools/`, `native/CMakeLists.txt` |
| テスト | Node test runner、Browser自動操作スクリプト、Native smoke/比較テスト、C++小テスト | `test/`, `native/*_test.cpp` |

依存パッケージと実行コマンドは `package.json` に定義される。主要コマンドは `npm.cmd run editor`（Webエディター）、`npm.cmd run desktop`（Electron）、`npm.cmd test`（TypeScript build後にNodeテスト）、`npm.cmd run pack -- --project <path>`（作品ビルド）、`npm.cmd run native -- --project <path>`（Native再生）、`npm.cmd run desktop:package:win`（Windowsデスクトップ配布物）である。

## 3. 作品フォルダーと設定モデル

標準例:

```text
Project/
  setting.txt                 # 作品の場所・開始ファイル等
  senario/*.tds               # TDSシナリオ（ディレクトリ名は設定可能）
  asset/                       # bg/char/bgm/se/voice/video/image等
  setting/
    game-screens.json          # タイトル・メニュー等の画面定義
    player-ui.json             # 会話枠・選択肢・基準音量等
    screens/*.html             # 画面テンプレート
    screens/*.css              # 共通画面CSS
    screens/ui-controls.txt    # 安全なUI設定値
  .novel/                      # IDE生成の索引・キャッシュ・ビルド成果物
```

`tools/project-layout.js` がプロジェクトルート、scenario/settings/assets/buildの各ルートを解決する。`setting.txt` の `scenario_dir`、`asset_dir`、`start_file` が基本設定で、titleも指定できる。CLI引数 `--project` と `NOVEL_PROJECT_ROOT` によるルート指定を持つ。最近開いた作品の管理は `Edit/recent-projects.js`。

作品内参照は安全のため相対パスに制限し、作品ルート外へのパス逸脱を検証する。includeと外部gotoはシナリオディレクトリ基準、asset宣言はassetディレクトリ基準。`std/` はエディター同梱標準ライブラリの予約名前空間で、プロジェクト側の同名パスより優先される。

作品の永続データはシナリオ／素材／setting文書であり、`.novel/variables.json`、`assets.json`、schema類、build JSONはIDE生成・再生成可能な補助データである。エディター本体の `Edit/` と作品は分離する。

## 4. エディター画面・操作

### 4.1 メイン画面

`Edit/index.html`を骨格とし、`Edit/styles.css`と`Edit/scrollbars.css`が外観を定義し、`Edit/editor.js`が操作を統括する。VS Codeに近い、暗色のコンパクトな編集画面を目指す。

- メニューバー: ファイル、編集、選択、表示、実行、ヘルプ。実行操作は「ビルド」「再生」を中心にする。
- Activity bar／サイドバー: Explorer、検索、Scene Flow、表示・演出設定など。
- Explorer: 作品ファイルを列挙し、シナリオを開く。右クリックは説明・定義移動等の文脈操作を提供する。
- タブ: 複数ファイルを別タブで開き、定義ジャンプも現在文書を置き換えず別タブとして開く設計。
- 編集面: textarea上へ構文色付けを重ねる軽量エディター。行番号、ミニマップ、候補ポップアップ、未保存状態を持つ。
- 検索: ファイル内検索／置換は一致件数、前後移動、大小文字・単語・正規表現等を持つ。プロジェクト検索は別ペイン。
- Quick Access／コマンドパレット: `Ctrl+Shift+P`系の機能検索とファイル移動。
- 診断欄: エラー／警告／情報を位置とともに列挙し、該当行へ移動。
- split pane: 定義元等の別文書を分割表示する領域。
- 独自スクロールバー: `Edit/scrollbars.css`を共通適用し、ブラウザー既定のバーをそのまま露出しない。

入力補助はファイル種別とカーソル位置に応じたTDS候補／関数・変数等の情報を出す。setting配下の通常txtやHTML/CSSではTDS補完を出さない方針。整形器は `shared/formatter.js` と `tools/format.js` を共有し、整形契約・性能テストを持つ。

### 4.2 解析・ビルドと再生

エディターの編集中内容と最後のビルド内容を区別する。保存とビルドは同義ではなく、ビルド時点からscenarioに変更があれば再ビルドを促す設計である。Browserのテスト再生は開始ファイル／scene／行を指定でき、実行位置をエディター側の該当行に同期する。Native再生はパッケージ化された実行物を起動する。

### 4.3 Scene Flow

`Edit/flow.js`, `flow-layout.js`, `flow-domains.js`, `flow.css`とserverのscene graph APIで構成する。ファイル／sceneをノードとして表示し、goto/include、診断、変数等の情報を補助表示する。フィルター、ズーム、fit、パン、フォルダ単位のドラッグ配置保存、ノード選択、選択ノードに関連する祖先・子孫の距離に応じた強調がある。線の交差・重なりは直交ルーティングと通路オフセットで軽減する設計だが、密なグラフで交差ゼロや最適解を保証するものではない。

## 5. TDS言語とコンパイラー

### 5.1 字句・構文

字句器 `src/parser/lexer.ts` は文字列、コメント、数値、記号、改行、位置情報を扱い、構文器 `src/parser/parser.ts` はAST (`src/parser/ast.ts`) を生成する。トップレベル宣言にはinclude、asset、character、struct、global、関数、sceneがあり、ステートメントには宣言／代入／unset、if/else、for／foreach／while、choice、関数呼出し／return、goto、演出コマンドがある。式にはリテラル、変数、添字、単項・二項演算、呼び出し、dict、listを含む。

プリミティブ型は `int`（符号付き64bit）、`float`（有限倍精度数）、`str`、`bool`。複合型に `dict[T]`、`list[T]`（基本型の要素）、名前付きstruct、専用character値がある。関数戻り値の `none` は値型としては宣言できない。listは値コピー、添字は0始まり。詳細は構文リファレンスを参照する。
includeは別名必須で `include "std/math.tds" as math`、呼出しは `math.sin(x)`。モジュールは宣言主体でsceneや実行命令を含まず、関数はaliasで修飾される。asset/character/struct/globalカタログはプロジェクト全体へ統合される。

### 5.2 型検査・意味解析

`src/checker/type-checker.ts` は名前解決、型適合、関数引数・戻り値、コマンド引数、duration/offset/音量等の範囲を検査する。`src/checker/analyzer.ts` は診断生成、定数伝播、分岐条件の制約・有限値集合、到達性、goto到達scene、無限ループ／到達不能、数値境界、キャラクター登場状態、背景・BGM等の置換状態を解析する。

解析結果は error/warning/info と位置情報を持つ。変数・関数・structの定義／参照位置はコンパイル済みmetadataやIDE symbol APIへ渡され、右クリック説明・定義ジャンプ・Scene Flow補助に使われる。include先関数のローカル変数を呼出し元のファイルスコープ変数一覧に混ぜないことは解析スコープ設計上の要件である。

### 5.3 プロジェクト解決・コンパイル

`tools/project.js`の流れは概ね次の通り。

1. scene sourceを字句走査し、include、struct名、関数名を収集する。
2. includeを再帰解決し、循環・重複・外部パスを検出。struct型を事前収集して構文解析へ渡す。
3. モジュール制約を検証し、取り込んだ関数名・呼出しをalias namespaceへ修飾する。
4. 各ファイルASTを統合し、外部global／character等の解析コンテキストを作る。
5. `compile()`が解析を要求し、ASTを `CompiledProgram`（現在version 2）へ変換。式はinteger/float/literal/load/index/call等、命令はdeclare/set/command/if/loop/choice/function/return/goto等のデータになる。
6. asset参照、goto対象、ファイル存在とプロジェクト内パスを検証する。
7. `.novel/build`以下へJSON出力し、playerが開始ファイルからロードする。

この形式にはasset、character、global初期化、関数、scenes、命令列、変数の定義／参照metadataが含まれる。デバッグ再生時には実行位置等の情報も利用する。

### 5.4 実行時処理

Browser側の実行器は `Edit/runtime.js`。命令pointer、global/local frame、scene状態、choice待ち、goto/file load、時間付きaction、復元可能stateを管理し、player adapterへ演出命令を通知する。`Edit/player.js`は背景・character・画像・video・音声・dialogue・choice・fade/effect/moveをDOM/CSS/Media APIで描画する。

Native側はC++ `native/runtime.hpp`、`player.cpp`、`video.hpp`等で命令実行／SDL描画／入力／音声・動画を担う。SDL3系ライブラリとFFmpegを使う。`scene_geometry.hpp`や`audio_transition.hpp`は幾何・音声遷移の一部を分離し、小テスト対象にしている。

シナリオ状態は背景、character配置、画像/video、audio、dialog opacity、effects、choices、action/transition等を保持する。命令中のvolume/opacity等はfloatを使い、settingで基準、アセット／シナリオ命令／その場の再生指定の優先順で扱う仕様がある。

## 6. ゲーム画面・設定画面のUI

### 6.1 二つの画面設定

- `setting/player-ui.json`: 1280x720等の基準画面、会話パネルの位置・サイズ・画像・opacity、本文・話者名、choice配置、基準audio volumeを設定する。
- `setting/game-screens.json`: initial screen、canvas、各screenの背景・music・role・HTML template、共通stylesheet、controlSettingsを指定する。
- `setting/screens/*.html`: タイトル、pause、system、sound、save/load等の要素・文字・動作。
- `setting/screens/*.css`: layout、色、フォントサイズ、画像、hover状態等。
- `setting/screens/ui-controls.txt`: player-local設定の初期値（audio master/BGM/SE/voice、mute、dialog opacity）。

画面HTML/CSSは任意Webサイトではない。`Edit/screen-document.js`が許可タグ／属性／CSS／動作だけを解析し、共通の限定UI treeとlayout情報を生成する。外部URL、任意script、event handler、任意CSSを禁止してBrowserとNativeで同じ文書を安全に解釈する。利用できる主な要素はmain/section/header/footer/nav/div/span/h1-h3/p/small/strong/button/input/img/br/save-slots。CSSは限定Flex/Grid、position、寸法、余白、色、背景画像、border、opacity、object-fit、z-index等。画面動作はstart/resume/save/load/open-screen/back/quit。

`input[type=range]`はaudio.master/bgm/se/voiceとui.dialogOpacity等の許可設定、checkboxはmute設定に限定される。画像ボタンはHTMLの`img`/CSS background-imageや旧itemsのimage/hoverImage等で表現できる。HTML templateが設定されたscreenではHTML/CSSを正本とし、互換のJSON itemsとの二重管理はしない。

### 6.2 セーブ・ロード

Browserは作品ごとのlocalStorage名前空間にslotとresume stateを保持し、テスト再生は別namespace。状態はversion、ファイル／scene／命令位置、variables、locals、sceneState等を含む。Nativeはpackage横の`saves/slot-N.json`を使うため、配布ゲームを移動するときはsavesを保持する必要がある。保存枠一覧はsave-slots/load-slots roleまたは対応screen actionで構成する。

### 6.3 音声とUI音量

BrowserはHTMLAudioElement/Web Audio経路でBGMのgain transition、チャンネル音量、UIの保存設定を扱う。NativeはSDL_mixer経路。シナリオの基準volumeと実行時指定、UI側のmaster/channel/muteを分ける。実際の同時音声・ブラウザーautoplay許可・Nativeコーデック可否は環境依存である。

## 7. ビルド、起動、配布

- `npm.cmd run build`: TypeScriptを`dist/`へ出力。
- `npm.cmd test`: 上記build後、`test/*.test.js`をNode test runnerで実行。
- `npm.cmd run pack -- --project <root>`: start_fileから必要なscenario/goto、assetを収集・検証し、Native/Browser player向けJSONとasset一式を`.novel/build`へ作る。
- `npm.cmd run native:build`: CMake/vcpkg等でNative実行物を構築。
- `npm.cmd run native -- --project <root>`: 作品packageを用いてNative playerを起動。
- `npm.cmd run desktop:package:win`: Electronアプリ、Native実行ファイル/DLL/engine_dataをまとめたWindows配布フォルダーを生成。

検証群はparser/checker/runtime、project security/layout/change tracking、formatter、標準ライブラリ、画面文書、保存復元、コンパイラー差分、Editor入力・検索・symbol tooltip、flow layout/interaction、Browser player、Native smoke/save-load/titleなどを含む。ただし全テストが常に外部依存を含めて実行されるわけではなく、物理音声出力や全OS・解像度の見た目をユニットテストのみで保証するものではない。

## 8. 現行サンプル作品

リポジトリの`Title/`は作品サンプルで、`Title/senario/main.tds`、`Title/asset/`、`Title/setting/`を持つ。素材には背景、立ち絵、BGM、SE、UIパネル・ボタンがある。これは製品に同梱される特定作品データであり、エディター実装そのものとは分けて扱う。

## 9. 確認された仕様・文書・実装のミスマッチ

以下は今回確認できた範囲での具体的な問題であり、将来課題と区別する。

1. **画面UI READMEが実装より古い** — `Title/setting/screens/README.md`は`input`不可、設定コントロールは見た目のみと説明する。しかし`Edit/screen-document.js`は`input[type=range|checkbox]`、制御対象キー、`ui-controls.txt`連携、設定変更callbackを実装し、テストも存在する。`save-slots`要素もREADMEの許可要素一覧に抜けている。
2. **CSS寸法のvw/vh処理が宣言と一致しない** — parserはpx/%/vw/vhを受け付けるが、`length()`は`%`だけ親寸法へ換算し、`vw`/`vh`は単位を除いた数値をpx扱いする。READMEどおりのviewport単位ではない。寸法の一部はwidth/height文脈で使う親幅／親高も統一的に適用されているとは限らない。
3. **制限HTML/CSSは“HTML/CSS対応”ではない** — 利用できるのは小さな許可リストで、通常のCSS cascade、子孫セレクター、pseudo-class全般、media query、font-face、animation、外部素材、任意DOM/APIはない。`:hover`も専用コンパイラ／renderer経路。READMEや企画説明で単に「HTML/CSS対応」と言うと自由度を過大に見せる。
4. **Browser/Nativeは同一UI treeを使うが画素・操作挙動まで同じとは限らない** — BrowserはDOM/CSS/native inputを利用し、NativeはSDLで要素を描画・入力処理する。フォント、文字折返し、range表示、hover/focus、画像fit等はrenderer別実装の差が残る。共通設定モデルはあるが完全な視覚同一性の根拠にはならない。
5. **保存先と可搬性が実行環境で違う** — BrowserはブラウザーlocalStorage、Nativeはpackage横の`saves/`。同じslot内容が自動同期／相互移行される仕様ではない。ブラウザーの容量・消去・プライベートモード、Native配布時のフォルダー権限も異なる。
6. **文書上の設定場所に履歴差がある** — 現行サンプルは`Title/setting/`にまとめるが、旧形式・互換分岐やREADMEにはroot `setting.txt`、`setting/player-ui.json`、legacy asset配置の記述が混在する。新規実装・移行ではどのlayoutを正とするか明示しないと説明が分岐する。
7. **開始点説明の適用範囲** — TDSの開始sceneは開始ファイル内の先頭sceneだが、画面設定が有効なplayerでは`game-screens.json`のinitial screen／start actionが先に存在する。作品全体の開始点を説明するとき「先頭sceneから開始」だけではタイトル画面経由の流れを説明しきれない。
8. **Editorの“保存”と“ビルド”の区別がUI上重要** — 保存済みscenarioでも最後に生成したpackageとは違うことがある。再生が古い成果物を使う状態は、dirty判定とbuild促進表示に依存するため、単なる保存済み表示を最新実行と誤認させない必要がある。
9. **includeの宣言統合と名前空間の非対称** — 関数呼び出しはalias修飾される一方、assets/characters/structs/globalsはproject-wide catalogへ統合される。`math.sin()`のような一様なmodule namespaceを期待すると、同名衝突やIDEスコープ表示で直感とずれる可能性がある。現行仕様として明記し、衝突検査・補完表示を継続監査すべき。

### 改善優先度

- **P0:** `vw/vh`を本当に実装するか、受理対象から外して`%`/pxに限定する。READMEのinput、checkbox/range、role/属性一覧を実装準拠に更新する。
- **P1:** 共通UI treeに対するBrowser/Native differential testsを増やし、寸法・折返し・画像・hover/focus・range/checkbox・save slotを同じfixtureで比較する。
- **P1:** 旧設定layoutと新しい`setting/` layoutの正本、移行規則、互換期限を統一する。
- **P2:** include catalog統合の名前解決規則とIDEのscope境界を言語仕様として固定し、衝突と定義ジャンプの回帰テストを持つ。
- **P2:** Editorの保存済み／ビルド済み／実行中packageの状態を一目で区別し、古いpackage再生を防ぐ回帰テストを維持する。

## 10. 参照先

- [README](../README.md) — 開発・起動・packの入口
- [構文リファレンス](../syntax-draft.md) — TDS文法の詳細
- [標準ライブラリ](../std/README.md) — `std/`、組込text/list、math/motion
- [画面UI README](../Title/setting/screens/README.md) — 現行実装との差分は本書9節を参照
- [Native README](../native/README.md) — Nativeビルド・実行
- 実装: `src/parser/`, `src/checker/`, `src/compiler/`, `tools/project.js`, `tools/pack.js`, `Edit/`, `native/`
- テスト: `test/`および`native/*_test.cpp`

## 11. Editorとローカルサーバーの責務境界

Web版のEditorは「ブラウザーUI＋同一マシン上のNodeサーバー」である。UIから作品ファイルを直接OS APIで開くのではなく、HTTP APIを介してサーバーに読み書き・列挙・解析を依頼する。Electron版も同じEditor/serverの構成を使い、OSフォルダー選択等の権限が必要な処理だけpreload/main経由に寄せる。

サーバーは`Edit/server.js`。標準ポート4173を使い、使用中なら4174～4183を試す。request body上限は2MiB。静的配信は作品アセット／Editorの許可パスを分け、シナリオ・setting・asset・buildの各読書きは個別の安全なpath resolverを通す。一般ファイル編集APIは`.tds`を対象にし、設定文書は専用APIで扱う。

### 11.1 HTTP API面

| API群 | 主なendpoint | 役割 |
|---|---|---|
| プロジェクト | `GET /api/project`, `POST /api/project/open`, `GET /api/project/changes` | 開いている作品、作品切替、外部変更差分 |
| ファイル | `GET /api/files`, `GET/PUT /api/scene`, `DELETE /api/file` | TDS一覧、本文読み書き、削除 |
| 設定文書 | `GET/PUT /api/setting-file`, `/api/player-ui`, `/api/game-screens` | setting下のHTML/CSS/JSON/TXTとplayer UI設定 |
| 素材・カタログ | `GET /api/assets`, `/api/catalog`, `/api/browse` | 宣言済み素材と候補・ファイル選択 |
| 言語サービス | `POST /api/validate`, `/api/compile`, `/api/editor-symbols` | 診断、コンパイル、定義・参照・補完用情報 |
| Scene Flow | `GET /api/scene-graph`, `/api/flow-domains`, `POST /api/validate-flow` | ノードグラフ、表示ドメイン、開始終了経路の検証 |
| Build/Native | `POST /api/project-build`, `/api/project-build-status`, `/api/native-build`, `/api/native-play`, `GET /api/native-package` | 全体Build、差分状態、Native build／再生／成果物配信 |
| Native補助 | `/api/native-tools/build`, `/api/native-tools/test`, `/api/native-tools/images` | Nativeエンジン構築・回帰・画像検証の呼び出し |

endpoint名は現行実装にある主要群の要約で、完全なHTTP契約（各request/responseのschema、status code、再試行規則）を定めるAPI仕様書ではない。`Edit/server.js`の`handleApi()`が実装正本である。

### 11.2 Editorでの代表的なデータ経路

**シナリオ編集**

```text
Editor textarea
  -> editor.jsのdirty管理／自動補完／syntax表示
  -> PUT /api/scene で保存
  -> validate APIで診断（必要ならinclude・project contextも解決）
  -> 結果を診断欄へ表示、診断クリックでfile/lineをreveal
```

**プロジェクトBuild**

```text
保存済み作品ファイル＋作品設定
  -> project-build API
  -> 全scenarioの構文・意味解析／参照収集
  -> build package生成・snapshot記録
  -> project-build-statusで現在ファイルとの差を確認
  -> 再生時は最新Buildを要求／古ければBuildを促す
```

**定義ジャンプ**

```text
選択した記号
  -> editor-symbols APIが定義位置・symbol種別等を返す
  -> sceneまたはinclude標準モジュールを別タブで開く
  -> 行と列を選択・表示
```

サーバーAPIが返すデータとEditorの見た目は別責務である。Editorはsource本文を保持し、解析APIから返るindexやbuild metadataを編集元として書き戻さない。

## 12. TDSをソースから実行まで追う

### 12.1 ASTの単位

`src/parser/ast.ts`におけるScriptは`assets`, `characters`, `structs`, `globals`, `functions`, `scenes`, `includes`, `body`を持つ。位置情報は行・列・終端位置・ファイル名でAST要素へ付加される。Statement unionはdeclare/set/unset/command/if/for/forEach/while/choice/call/return/goto。Expr unionはliteral/float/variable/index/binary/unary/call/dict/listである。したがって構文木の段階から、「表示命令」と「変数代入」「制御フロー」は異なる節点として扱われる。

### 12.2 コンパイラーが行うこと／行わないこと

- `compile()`は型・意味解析を通らない不正ASTを通常の実行packageとして通さない。`CompileError`や解析diagnosticを使い失敗を返す。
- 整数リテラルはJSONで精度を失わない文字列表現へ変換し、Browser側ではBigInt、Native側では64bit整数として実行する。
- floatは有限値として保持し、BrowserはJavaScript number、Nativeは浮動小数点型へ読み替える。
- ソース位置と変数定義／参照情報はデバッグ・IDE機能に使う。debugなしの出力との具体的差分はcompilerオプションに依存する。
- compilerは画像をレンダリングせず、音声を再生せず、choice入力も受けない。これらはPlayer adapterの担当。
- Scene Flowはcompiled command列の単純な可視化ではない。AST／遷移情報やプロジェクト索引を集約したIDEビューであり、runtime実行順そのものを常時反映するものではない。

### 12.3 型・値モデルの要点

`int`は符号付き64bitでオーバーフロー検査を要する。`float`は有限値に制限される。`dict[T]`は文字列key、`list[T]`は要素型がそろう。structは名前付きの固定field型、characterは表示poseと状態fieldを併せ持つ専用データである。list APIや標準ライブラリの一部はpure/value-returningで、例えば`list.append`は元listを書き換えず新listを返す。`set`は変数・添字・struct/character field等へ作用し、`unset`は辞書要素を対象とする。

BrowserとNativeの意味的一致は「設計契約」であり、言語形式が共通というだけでは証明されない。特にBigInt/float境界、辞書／listのコピーとalias、文字列からの変換、JSON serialize/restore、NaN/Infinity排除、配列index異常、関数の副作用を差分テスト対象とする。

### 12.4 インクルードと初期化順

`resolveProjectScript()`は各includeを読み、aliasで関数名をqualifyした上でScript要素を統合する。モジュール内global宣言も実行初期化の対象となり、依存関係順でprojectへ取り込まれる。各ファイルのasset/character/struct/globalは別ファイル定義も含めて参照可能なproject catalogになる一方、関数名はaliasで名前空間化される。この設計は「ファイルmodule全体が完全隔離名前空間」というモデルではない。

include循環、二重include、同一symbol重複、global初期化前参照は異なる問題として扱われる。将来的にmoduleを強い隔離単位にするなら、関数以外の宣言可視性・名前衝突規則・IDEのsymbol scope・パッケージABIを同時に変更する必要がある。

## 13. 静的解析の設計と保証範囲

### 13.1 解析情報

Analyzerは式を定数評価できる範囲で評価し、制御フロー位置ごとにknown constant、真偽条件fact、変数制約（整数・float・文字列の境界や有限候補集合）、キャラクター表示状態等を追う。if分岐では各経路の制約を分岐条件で絞り、合流時に複数経路の共通部分／包絡を作る。値域を使った変換安全性・到達可能性は、その時点で解析可能な式に限定される。

解析は一般プログラムの完全決定手続きではない。関数副作用、反復、動的値、有限候補数の上限、複雑な条件式、実行時APIに依存する値では保守的にunknownを残す。したがって「warningがない」は任意入力に対する実行安全性の数学的証明を意味しない。

### 13.2 診断カテゴリ

現行実装には概ね次の診断群がある。

| 分類 | 例 |
|---|---|
| 構文・名前・型 | parse error、未定義名、重複宣言、引数型／戻り値不一致、asset種別不一致 |
| 範囲・算術 | int境界、定数ゼロ除算、時間／座標／音量範囲、変換時に制約外となる可能性 |
| 制御フロー | 到達不能命令、常に真／偽の分岐、条件重複、無限loop、未到達scene |
| symbol品質 | 未使用function argument/local、自己代入等 |
| 演出状態 | 既存背景/BGM/videoの置換、character未表示の可能性、状態遷移の分岐差 |
| project解決 | include循環／重複、外部goto解決不能、asset欠落、project外参照 |

警告はコンパイル停止エラーとは限らない。解析は誤検知を避けるため未知を残す場合があり、すべてのruntime状態を追跡するわけではない。出力は位置つきdiagnosticで、エディター上の診断欄、Scene Flow、analyzer testsで消費される。

### 13.3 静的変数と通常変数

`.novel/variables.json`には生成indexとユーザーが設定するstaticVariablesの区別がある。staticVariablesは複数ファイルに共有されるglobal宣言として解析／buildへ取り込まれる。生成されたvariables一覧は定義・参照カタログであり、ユーザー設定そのものとは扱わない。外部入力の値を固定してテスト再生する場合も、確定値／不確定値を分けて表示する設計がある。解析で確定した値をユーザーの可変入力欄に重複表示・上書きしないことが重要である。

## 14. 再生命令と描画状態の分離

### 14.1 Scene state

Browser runtimeの`createSceneState()`は背景、character map、5つの配置slot、画像、video、BGM/SE/voice、音量、dialog opacity、effects、choices、transfers、action進捗、diagnosticsを保持する。命令が状態を更新し、Rendererが状態をDOM/SVG/Canvas/SDLに反映する。静的解析が追うscene状態と、再生中の実stateを混同しない。

### 14.2 命令の待機と並列性

say/choiceなどはユーザー入力待ち、wait/fade/move/音声videoは時間または媒体の完了待ちを作る。voice/videoにblocking/async、BGMにcrossfade、演出にdurationがある。runtimeはaction idとtransition進捗を追跡し、停止・失敗・完了を同期する。実時間のtimer経過、タブ非表示／window focus、音声autoplay policy等はBrowserではOS/ブラウザーに依存し、NativeはSDL event/audio/video更新の刻みで進む。

`move`はTDS側で位置差分と時間を指定し、プレイヤー側が補間する。ユーザー定義の`std/motion/walk.tds`等は通常TDS関数であり、専用walk命令をcompilerに増設する設計ではない。各フレームごとに値を計算するscenario loopと、時間付きmoveのruntime animationは別機構である。

### 14.3 座標・拡大縮小

会話再生画面の基準寸法はplayer-ui theme、フロント画面はgame-screens canvasで別々に管理する。Browserは画面stageへのscaleとDOM座標を使い、NativeはSDL rendererのlogical size／scene geometryを使う。キャラクターslot配置、x/y差分、背景fill、dialogue boxの内部座標、window aspect ratio、letterbox/crop処理の仕様はそれぞれ確認が必要で、同じ1280x720を指定しただけで全解像度の画素一致を保証しない。

## 15. UI文書コンパイラーの詳細

### 15.1 変換段階

`Edit/screen-document.js`はHTML/CSSをブラウザーの任意DOMとして実行せず、制限付きgrammarとして読む。

1. HTMLコメントを除去し、tag tokenとtextを読む。
2. 許可tag、属性、閉じtag、要素数2000以下・深さ64以下等を検証する。
3. `input` type、data-setting key、range min/max/step、checkbox/mute対応を検証する。
4. CSSのselector、property、値域、外部URL／at-rule／危険値を検査する。
5. class/id/tag/hover selectorをnodeへ適用し、継承対象color/font-size/text-alignを解決する。
6. intrinsic size、flex/grid、absolute positioning等からUI tree上のrectを計算する。
7. save/load slotsを専用roleから生成し、control defaultsを結び付ける。
8. Browser rendererまたはNative package rendererに渡すデータとしてシリアライズする。

画面HTMLは最大120KB、CSS80KB、controls text20KB、要素数2000・入れ子64の上限がある。属性はid/class/src/alt/type/min/max/step/value/checked/aria-label/data-action/data-target/data-role/data-count/data-setting等の許可形式に限定される。

### 15.2 自由度の範囲

現時点で実現できるのは、画面canvas内のpanel/button/image/text、限定layout、hover時style、範囲値のsliderとmute checkbox、save/load slot一覧、画面遷移、画像ボタン、背景画像／screen music等である。任意のWeb component、任意JavaScript、DOM event、外部font、animation timeline、複雑なselector、viewport responsive breakpoint、カスタムslider thumb、音声波形・複合binding等は別途実装が必要。

つまり「HTML/CSSライクな簡易UI DSL」であり、WebページをそのままゲームUIとして持ち込む方式ではない。安全なBrowser/Native共通を維持するには、要素やstyleを足すたびにUI tree schema、Browser renderer、Native renderer、editor validation、テストfixtureを一緒に更新する必要がある。

## 16. テスト体系とその意味

| 層 | 主なテスト | 保証するもの | 単独では保証しないもの |
|---|---|---|---|
| Parser/Checker | `parser.test.js`, `language-reference.test.js`, `audit-regression.test.js`等 | grammar、型、診断、回帰例 | 任意シナリオで誤診断ゼロ |
| Runtime | `runtime.test.js`, `compiler-differential.test.js` | 命令意味、Browser/native比較fixture | 全API・全分岐・全型の等価性 |
| Editor browser | `editor-*.browser.cjs`, `project-changes.browser.cjs` | DOM操作、入力・検索・tooltip・保存経路 | Electron全OSでの安定性、アクセシビリティ完全適合 |
| Scene Flow | `flow-layout.test.js`, `flow-*.browser.cjs` | 配置計算、DOM上の重なり、選択／関連node | すべての巨大グラフで交差なし |
| Screen UI | `game-screen-document.test.js`, `ui-controls.browser.cjs`, `game-screens-native.cjs` | parser制限、Browser setting操作、Native package/操作の対象経路 | 全CSSと全解像度で完全同一 |
| Save/Load | `save-load.browser.cjs`, `native-save-load.cjs` | sample state保存・復元、slot経路 | BrowserとNative間のsave file移行 |
| Native | `native-smoke.cjs`, `native-title-scene.cjs`, C++ geometry/audio tests | 起動・描画／処理経路の限定smoke | 実GPU/音響機器すべてでの知覚品質 |
| Desktop | `desktop-*.test.js`, `desktop-*.cjs` | startup、package、dialog等の回帰 | あらゆるWindows構成でのinstaller運用 |

BrowserのPlaywright等が使えるtestは一時作品を作り、ブラウザー操作とlocalStorage等を実測する。Native testは実行ファイル・SDL/FFmpeg等が存在しない環境ではskip、限定実行、環境依存となりうる。CIや手元で通ったtest件数はpackage.jsonと環境を併記しない限り固定の品質指標ではない。

## 17. 追加のミスマッチ・監査項目

既存9項目に加えて、今回の詳細確認では以下を「仕様を明確にすべき境界」として記録する。これらは全て確定bugと断定するのではなく、文書と複数実装を継続比較する対象である。

10. **「同じコンパイル形式」と「同じ実行意味」は別** — package schema共有は確認できるが、Browser JSとNative C++は別runtime実装である。辞書alias、型変換、例外、restore、整数／float境界を演算ごとに differential testしなければ意味等価とは言えない。
11. **API一覧は公開契約としては未固定** — `/api/*`が豊富にある一方、endpointごとのrequest/response schemaやversion、compatibility、error formatはserver実装へ分散している。Editor UIとNode serverの密結合がある。
12. **解析精度に上限がある** — analyzerは有限値集合・制約伝播を行うが、動的入力や関数副作用を含むプログラム全体を証明するものではない。診断文言で「必ず／可能性」を適切に使い分け、unknownを確定扱いしない必要がある。
13. **実行位置debugと通常Buildの範囲** — source location metadata、debug compile option、全体packageの再生の関係を、どのBuildを使うか別々に説明する必要がある。テスト再生での行同期成功は、Native製品packageで同等の同期UIがあることを意味しない。
14. **応答性・大規模作品時の性能契約が薄い** — server request body上限やscreen HTML要素数等の安全上限はあるが、TDS総行数、include深さ、asset数、Scene Flow node数、解析時間の利用者向け上限・キャンセル／進捗表示は別途調査が必要。
15. **設定値の3層を明確に分ける必要** — 開発者が編集するsetting defaults、ゲーム起動後のuser preference、再生中のscenario stateは保存先・寿命が異なる。例えば`ui-controls.txt`とBrowser localStorageとNative preference保存の関係を「値がどこへ保存され、どの優先度で効くか」単位で仕様化する必要がある。

### 監査方法の注意

本書はソースと存在するテストを読む静的な実装調査であり、この追記時点で全`npm test`、Browser操作一式、Native実機再生を再実行したという意味ではない。実機の目視・音声・入力遅延を根拠にする記述は「未検証」と区別し、変更後には実行環境別のテスト結果を追記する。

## 18. TDSコマンド・宣言の実用目録

ここでは「命令文」と「宣言」「式中で呼ぶ関数」を分ける。`src/parser/parser.ts`が語句をASTにし、`src/checker/type-checker.ts`が引数型・数・値域を確認し、`src/compiler/compiler.ts`が`command`または制御命令にする。利用者向けの全構文表は [`syntax-draft.md`の命令一覧](../syntax-draft.md#21-命令一覧) が詳細である。

### 18.1 ファイル先頭で行う宣言

| 宣言 | 例 | 用途・制約 |
|---|---|---|
| include | `include "std/math.tds" as math` | 別名必須。module関数を`math.sin(...)`で呼ぶ |
| asset | `asset bgm morning = "asset/bgm/morning.mp3" volume 0.5` | 素材ID・種別・相対パス・任意の基準音量を宣言 |
| character | `character hero { ... }` | `name`、任意field、`pose <id> = <path>`をまとめる |
| struct | `struct SaveData { score: int }` | 固定field型の値構造体 |
| global | `global int score = 0` | ファイル間をまたいで保つscenario変数 |
| function | `fn clamp(x: float, lo: float, hi: float) -> float { ... }` | 再利用可能なTDS処理。関数内でchoice/goto不可 |
| scene | `scene prologue { ... }` | 再生可能なscene。本ファイルで最初に宣言されたsceneがentry |

sceneのないmoduleはトップレベル宣言専用で、トップレベル実行命令は許可されない。includeされたglobalは初期化対象になり得るため、module globalは単なる型宣言と同義ではない。

### 18.2 実行命令

| 命令 | 構文例 | 効果／詳細 |
|---|---|---|
| 会話 | `say hero "おはよう"`、`say narrator "..." opacity 0.7` | 会話パネルへ話者と本文を提示。`narrator`はassetではなく組込み話者。opacityは当該sayだけ |
| 背景 | `bg school`、`clear bg` | 画像背景を設定／消去 |
| BGM | `bgm morning`、`clear bgm` | BGM開始／停止。音量は別にvolume命令またはplay optionで制御 |
| 立ち絵 | `show hero.smile left x+30 y-8 fade 250` | 5位置slotにposeを表示。既存キャラならpose/位置更新 |
| 立ち絵消去 | `hide hero fade 200` | キャラ表示解除。fade省略時は即時 |
| 一般画像 | `show image logo center`、`clear image logo` | characterとは別layerの画像表示／消去。現行show imageはfade不可 |
| 移動 | `move character hero by x+40 y-5 over 600` | 表示キャラを差分移動。時間指定ありは完了待ち |
| 動的対象移動 | `str target = "hero"`の後に`move character (target) by x+(delta)` | 対象をstr式で渡す場合は括弧が必要。静的にIDが分かる場合はキャラクター定義の存在も検査 |
| 背景移動 | `move bg by x-12 over 1000` | 背景を差分移動。波状移動／専用walk動作ではない |
| 音声 | `play se door`、`play voice greeting volume 0.5 blocking` | SE/voice再生。voice既定async、blockingなら完了待ち |
| BGM再生 | `play bgm theme volume 0.7 crossfade 400` | BGM再生。crossfadeはBGMのみ。命令volumeはその再生に適用 |
| 動画 | `play video opening async` | `blocking`/`async`。省略時async |
| チャンネル音量 | `volume voice 0.5` | 以後のシナリオ状態として基準音量を変更 |
| 会話欄 | `dialog opacity 0.8` | 以後の会話欄背景面のopacity。本文文字そのもののalphaではない |
| 待機 | `wait 1000` | 1000msのscenario時間を進行 |
| 画面効果 | `effect fade black 500` | 黒／白fade。時間省略時500ms |
| 分岐 | `if route == "a" { ... } elif ... else ...` | 条件式で実行経路を選択 |
| 選択肢 | `choice "どちらへ？" { "駅" { ... } }` | Player入力を待つ。関数本体では不可 |
| ループ | `for i from 0 to 3 { ... }`, `for name in names { ... }`, `while score < 5 { ... }` | rangeは両端含む。上限は静的／実行時保護と合わせ100,000反復 |
| scene遷移 | `goto ending` | 同一ファイルsceneへ移動し現在scene命令を終了 |
| file遷移 | `goto "chapter/next.tds"` | scenario_dir相対の別TDSへ移る |
| 変数変更 | `set score = score + 1` | 既存可変値更新。field/index更新も許可 |
| 辞書key削除 | `unset flags["seen"]` | dict要素を削除。一般変数削除ではない |
| 関数呼出し | `math.clamp(x, 0.0, 1.0)` | 戻り値を式に使うか、戻り値none関数を命令として呼ぶ |
| return | `return result` | 関数のみ。全経路でnon-none returnが必要 |

数値時間はms、表示位置差分はpx。音量とopacityは0.0から1.0。整数は64bit、durationは符号と最大時間を検査する。`show`位置のy+は下方向、moveもx+右／y+下。実際の画面上の見た目は基準slot、画像native size/scale、canvas拡大方式に依存する。

### 18.3 変数・式・演算子

```tds
global int day = 1
const str chapter_name = "first"
float progress = 0.25
bool available = day >= 1 and progress < 1.0
list[str] routes = ["common", "true"]
dict[int] flags = {"seen": 1}
set flags["seen"] = flags["seen"] + 1
```

- 宣言は型付き、または文法で許可される型推論形式。`global`はトップレベルに限定。
- `const`は宣言値を再代入できない。複合値の内部更新が可能かは、対象型と代入targetのchecker実装に従う。
- 演算子には算術`+ - * / %`、比較`== != < <= > >=`、論理`and or not`がある。`+`は数値加算またはstr結合。
- 整数除算は整数演算。float演算はfloat値を保ち、有限でない結果はruntimeで拒否される。
- boolは`true`/`false`。条件はboolであり、intを暗黙に真偽値化しない。
- 文字列補間`say narrator "score={score}"`は変数の文字列表現を本文へ埋め込む。関数呼出し補間にも対応するが、引用・escapeとmodule aliasの規則に従う。
- 添字はlist int index、dict str key。リスト範囲外と未登録dict keyの参照はいずれもruntime errorになる。dictのkey membership専用演算子／builtinは現状ない。
- 辞書リテラルのkeyは文字列。list/dict/structのcopy、比較、関数引数の値渡しはBrowser/Nativeで一致すべき言語契約である。

### 18.4 組み込み関数とruntime API

下表は`src/language/builtins.ts`で言語組込として認識するもの。TDS `include`不要。

| 関数 | signature | 意味 |
|---|---|---|
| `str(x)` | `int|float|bool -> str`等 | 値を文字列化 |
| `int(x)` | `str|float`等から`int` | 整数変換。64bit境界を検査 |
| `float(x)` | 数値／数値文字列から`float` | 有限float変換 |
| `list.length(xs)` | `list[T] -> int` | 要素数 |
| `list.append(xs, x)` | `list[T], T -> list[T]` | 元listを変更せず末尾追加した値 |
| `list.contains(xs, x)` | `list[T], T -> bool` | 等価要素の有無 |
| `text.trim(s)` | `str -> str` | 対応空白を両端除去 |
| `text.normalize_space(s)` | `str -> str` | 空白連続をASCII space 1個へ正規化 |
| `text.split(s, sep)` | `str, str -> list[str]` | separatorで分割。空要素を保持、空separator不可 |
| `text.replace(s, old, new)` | `str, str, str -> str` | 全一致を置換。old空文字不可 |
| `runtime.state.characters.exists(id)` | `str -> bool` | 現在表示中のIDか |
| `runtime.state.characters.list()` | `() -> list[str]` | 現在表示中IDを重複なし・昇順で返す |

Pure builtinはAnalyzerのconstant folding／副作用推定でも特別扱いされる。runtime APIは状態を読むがcompile-time constantではない。`compile.*`と`ide.*`は実行runtime namespaceとしてまだ公開されず、TDSシナリオから呼べる組込ではない。

### 18.5 TDS標準ライブラリ

標準ライブラリはTDS自体で書かれ、通常のinclude aliasで取り込む。これはcompilerの個別命令ではなく、上記builtinや基本構文を組み合わせた関数群である。

| module | API | 用途 |
|---|---|---|
| `std/math.tds` | `pi()`, `tau()`, `radians(x)`, `degrees(x)`, `sin(x)`, `cos(x)` | 角度・三角関数（Taylor近似） |
| 同上 | `abs(x)`, `min(a,b)`, `max(a,b)`, `clamp(x,lo,hi)`, `sign(x)` | 基本計算 |
| 同上 | `floor(x)`, `ceil(x)`, `round(x)`, `sqrt(x)` | 丸め・近似平方根。演出向けで科学計算精度保証なし |
| 同上 | `lerp(a,b,t)`, `map_range(x,in0,in1,out0,out1)`, `distance(x1,y1,x2,y2)`, `approach(current,target,delta)` | 補間・距離・追従 |
| 同上 | `smoothstep`, `smootherstep`, `ease_in/out/in_out_quad/cubic` | 0..1進行値のイージング |
| `std/text.tds` | `split_words(s)`, `join_words(items, separator)` | 単語分割・結合 |
| `std/collections.tds` | `index_of_str(items,target)`, `append_unique_str(items,item)`, `remove_all_str(items,item)` | 文字列list操作 |
| `std/motion/walk.tds` | `walk_x(distance,progress)`, `walk_bob(amplitude,progress)` | 進行率から横移動／上下揺れを計算 |
| `std/motion/effects.tds` | `shake(amplitude,progress,cycles)`, `breathe(amplitude,progress)`, `hop(height,progress)`, `drift(amplitude,progress,cycles)` | 演出オフセット計算 |

`progress`は通常0..1へ制限される。これらの関数は値を返すだけで、キャラ表示、frame scheduler、animation lifecycleを自動で開始しない。計算結果をシナリオ変数へ入れ、`move`命令へ渡す実装と、runtime内で補間する実装を区別する。

### 18.6 禁止・受理しない構文の代表

- 旧say block形式など、リファレンスで正式構文外とした旧構文は互換対象ではない。
- sceneを宣言したファイルのtop-levelに、scene実行を曖昧にするchoice/goto等を置けない。
- 関数内のchoice/goto、再帰呼び出し、型と一致しない代入、異なる要素型のlistは不可。
- include pathの外部逸脱、循環、同一module重複、aliasなしincludeは不可。
- arbitrary JavaScriptや標準外のTDS commandを追加命令として書く拡張機構はない。未登録命令はcheckerで拒否される。
- `runtime.*`は現状characters queryのみ。`runtime.state.audio`等を名前だけで呼び出せるわけではない。

### 18.7 構文リファレンスとの検査を継続する箇所

言語機能を足したときは、最低限、`parser.ts`の受理形、`type-checker.ts`の型・範囲、`analyzer.ts`の定数／副作用解釈、`compiler.ts`のIR化、Browser `runtime.js`、Native `runtime.hpp`、補完／tooltip、`syntax-draft.md`、unit/differential/GUI testsを照合する。文書に構文があるだけ、Browser runtimeだけにあるだけ、compilerが任意call名を保持するだけでは、TDS機能として完成とはみなさない。
