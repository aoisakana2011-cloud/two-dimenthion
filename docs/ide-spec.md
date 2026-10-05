# IDE / Editor 実装仕様

この文書は `Edit/` のローカルIDEについて、現行実装の責務、状態、HTTP境界、保存と失敗時の振る舞いを記録する。言語の文法と型規則は [`syntax-reference.md`](syntax-reference.md)、コンパイル処理は [`compiler-pipeline.md`](compiler-pipeline.md)、画面文書とPlayer描画は [`ui-runtime-spec.md`](ui-runtime-spec.md) を参照。

## 1. 実行形態と責務の境界

IDEのUIは `Edit/index.html`、`Edit/styles.css`、`Edit/editor.js` で構成される。`Edit/server.js` はNode HTTPサーバーで、プロジェクトの探索、設定/シーンの読み書き、構文解析・型解析・コンパイル、Browser Player起動ページ、Native Player起動を提供する。Electron版は `Edit/electron-main.js` と `Edit/preload.js` がウィンドウ生成やOSダイアログを仲介し、編集ロジック自体は同じWeb UIを使う。`?embedded=1` は埋め込みEditor用の表示状態を切り替える。

EditorはLanguage Server Protocolのクライアントではない。補完、診断、定義位置、workspace symbolは `editor.js` とローカルHTTP API、Parser/Checker/Analyzerの呼び出しで実装する。Browser Playerは `Edit/player.html` と `Edit/player.js`、Native PlayerはC++/SDL実装であり、Editorの表示プレビューとゲーム実行は別の実行経路である。

## 2. 画面領域と主要DOM

`index.html` が用意する主な領域は次の通り。

| DOM ID / selector | 用途と更新主体 |
|---|---|
| `#project-title`, `#project-path` | 現在のプロジェクト情報。`/api/project` の応答から更新 |
| `#file-tree`, `#file-info` | シーン/設定/assetのツリーと選択ファイル情報。`refreshFiles()`、`showFileInfo()` |
| `#editor-tabs`, `#scene-name`, `#editor` | 開いている文書、アクティブ文書名、シーン本文 |
| `#line-numbers`, `#highlight`, `#minimap`, `#minimap-content`, `#minimap-viewport` | textareaと同期する行番号、語句色付け、概要と表示範囲 |
| `#suggestions` | 入力位置に応じた補完候補 |
| `#result`, `#status` | 診断本文と短い状態メッセージ |
| `#split-group`, `#split-frame`, `#split-tabs`, `#split-resizer` | 右側Editorの分割ペイン |
| `#project-search-input`, `#search-results`, `#quick-access-input`, `#quick-access-results` | workspace検索とQuick Access |
| `#asset-document-viewer` 以下 | 画像・音声・動画の読み取り専用プレビュー、metadata、エラー |
| `#ui-settings-page`, `#ui-settings-json`, `#ui-settings-preview-stage` 以下 | Player UI theme編集、JSON編集、canvas上のプレビュー |
| `#scene-flow-host`, `#scene-flow-frame` | Scene Flow iframe/パネル |

画面の操作はメニューとボタンのイベントから `editor.js` の関数へ接続する。DOMはワークスペース情報の表示面であり、実際のファイル本文は `editor.value` とEditor内の文書状態が正本となる。Explorerを更新しても編集中の本文が自動で保存されるわけではない。

## 3. 文書・タブ・dirty状態

### 3.1 文書種別

`editor.js` は `activeSettingDocument`、`activeStandardLibraryDocument`、`activeAssetDocument` とシーン名を使い、編集可能なTDSシーン、`setting/` 文書、標準ライブラリ文書、読み取り専用assetプレビューを分ける。主なロード関数は `openScene()`、`openSettingFile()`、`openStandardLibraryFile()`、`openAssetDocument()`。`jumpToLocation()` / `jumpToScene()` は診断やシンボルから対象を開き、行・列に移動する。

編集タブは `openTabs`、右側ペインは `splitTabs` が追跡し、`renderEditorTabs()` と `renderSplitTabs()` が表示を作る。分割は `moveTabToRight()` / `moveTabToLeft()`、右ペイン表示は `openSplitScene()`、終了は `closeSplit()` が担当する。未保存内容を破棄する遷移ではdirty確認を挟む。split pane間の切替時に文書を移す操作と、文書を保存する操作は独立している。

### 3.2 Dirty、履歴、外部変更

`isDirty`、`sceneRevision`、`projectChangesToken` が保存境界を表す。本文入力は `updateDirtyState()` を介してタブ/Explorerのdirty表示を更新する。`sceneRevision(source)` はサーバーが返すrevisionと照合するための署名で、保存時は期待revisionを送る。`/api/project/changes?since=...` をポーリングして外部変更を取り込み、編集中ファイルに競合がある場合は黙って上書きしない。設定文書も `/api/setting-file` の `expectedRevision` とHTTP 409 `SETTING_CONFLICT` で競合を検出する。

`rememberUndo()`、`restoreEditorHistory()`、`undoStack`、`redoStack` はEditor側の本文履歴であり、ファイル保存履歴ではない。復元後はselection/caretを戻し、dirtyと解析表示を再同期する。`clearEditorHistory()` は文書のロード/履歴初期化に使われる。ファイル削除通知の `forgetDeletedScene()` はopen tabへの参照を整理する。

### 3.3 保存・一括保存

`saveScene()` は現在のシーン名と本文を `PUT /api/scene` に送り、サーバー成功時にrevisionとdirty表示を更新する。`saveAllScenes()` / `saveAllFromMenu()` は未保存のシーンを順に保存する。設定ファイルは `PUT /api/setting-file` を使い、JSON設定はパースと対象ごとのvalidatorを通過してから書かれる。Player UI editorは別モジュール `ui-settings.js` の `saveTheme()` が `PUT /api/player-ui` を呼ぶ。

`formatCode()` は現在の本文、`formatProjectScenes()` はプロジェクト内シーンの整形を行う。整形後の本文も通常のdirty状態を経由して保存される。`compileProjectFromMenu()` はbuildを行うが、コンパイル成功はソース保存成功を意味しない。Build出力はEditor上の作業ソースとは別の場所に生成される。

失敗時は `request()` がHTTPエラーを例外化し、`showError()` またはstatus/diagnostics領域へ表示する。本文が2 MiBを超えるAPI要求はサーバーが413で拒否する。シーン/設定パスの形式不正やプロジェクト外参照は400相当の失敗となる。保存中の外部更新は409となり、最新ファイルを再読込して編集を統合する必要がある。

## 4. Editor入力機能

`#editor` はtextareaを基底入力面として、同じ本文を `#highlight` に反映し、line numbers・search overlay・minimapを同期する。`highlightSource()` はキーワード・コメント等の軽量表示を作るが、構文解析や型検査の代用ではない。`insert()`、`insertEditorRange()`、`insertEditorNewline()`、`adjustSelectionIndent()` はテンプレート展開、選択範囲置換、改行時インデント、複数行インデントを扱う。IME変換中 (`event.isComposing` または `Process`) は一部キー操作を介入せず、通常の入力を優先する。

補完は `completionContext()` でカーソル前後、コメント/文字列、現在行の構文位置を評価し、`completionScopes()`、`completionScope()`、`completionVariableDeclarations()`、`completionVariableNames()` と `candidatesFor()` が候補を組み立てる。候補源はキーワード、現在ファイル関数、プロジェクト変数・character・asset、include済み関数、標準ライブラリ (`loadStandardLibraryModules()`) など。`updateSuggestions()` は古い非同期応答を `suggestionRefreshId` で破棄し、`renderSuggestions()` が候補を出し、`acceptSuggestion()` が `completionRange` に挿入する。候補一覧に表示されることは、現在位置で実際に型検査を通る保証ではない。

`validate()` と `scheduleValidation()` は `/api/validate` を呼び、応答シーケンス `validationSequence` で古い診断結果が後着して上書きするのを防ぐ。`renderDiagnosticResult()` はseverity、file、line、columnを `#result` に表示し、項目クリックで `jumpToLocation()` を呼ぶ。`F8` は診断間移動、`Cmd/Ctrl+Shift+M` はProblemsへのfocusを行う。コード解析結果を使う `editorSymbolsForCurrentSource()`、`compiledVariablesForCurrentSource()`、`showDeclarationTooltip()`、`showVariableTooltip()` は定義・型・利用位置をtooltipに出す。`F12` とコンテキストメニューから定義に移動できる。

Quick Accessは `openQuickOpen()` 系のUIからファイル/シンボルを絞り込む。workspace全文検索は `#project-search-input` を使う。本文内検索は `#editor-find-input`、件数 `#editor-find-count`、前後移動、置換一件/全件を提供し、`Cmd/Ctrl+F`、`Cmd/Ctrl+H`、`F3`、`Shift+F3` で操作する。`Cmd/Ctrl+/` は行コメント、`Alt+Z` は折返し、`Cmd/Ctrl+Shift+F` は現在のシーンのフォーマット、`Cmd/Ctrl+Z/Y` はEditor専用履歴である。キーイベントはOS・ブラウザの予約キー、IME、キーボード配列の影響を受ける。

中央ボタンまたはminimap上のドラッグで中ボタンスクロールを開始し、minimapクリックで本文位置へ移動する。選択・挿入位置と画面スクロール位置は別の状態である。補完のTab/矢印/IME操作などは実ブラウザの入力テストで確認する必要がある。

## 5. Explorer、資産、Scene Flow

`refreshScenes()` は `/api/scenes`、`refreshFiles()` は `/api/files` を読み直す。`showFileInfo()` はシーン・設定・assetの情報を表示し、シーン参照を `jumpToScene()` で開く。コンテキストメニュー `showFileContextMenu()` から名前変更/削除等を行う場合も、最終的なパス検証とファイル操作はサーバー側にある。プロジェクト切替は `/api/browse` と `POST /api/project/open` を使う。

Assetの表示対象拡張子は `assetMediaKind()` に明示され、画像は png/jpg/jpeg/webp/gif、音声は wav/ogg/mp3/flac、動画は mp4/webm。`assetDocumentUrl()` は `asset/` 配下のみを許し、空要素、`.`、`..` を拒否する。`openAssetDocument()` は画像寸法、音声長等のmetadataを表示するが、これは読み取り用ビューでありasset内容の編集機能ではない。デコード不能や未対応種別は `#asset-document-error` に出る。

Scene Flowは `flow.html` をiframeとして読み込み、`flow.js` が `/api/scene-graph` のノードと遷移をSVGで配置する。`flow-layout.js` は階層化、交差数低減、直交edge routing、folder境界配置を行う。`flow-domains.js` とサーバーの `/api/flow-domains` は選択ノード/行で変数値が取り得る範囲を計算し、`POST /api/validate-flow` は開始sceneから終端までの到達性等を検査する。Flow test panelの値は静的解析によるdomainの確認用で、任意の外部入力や全実行履歴を再現するruntime debuggerではない。ノードをクリックすると該当scene/位置をEditorで開く。グラフのレイアウト座標は表示状態で、シナリオ実行順や本文を書き換えない。

## 6. HTTP API契約（IDEが利用する主要経路）

全APIは同じローカルNode server内の `/api/...`。JSON要求は `readJson()` が読み、本文上限は `MAX_BODY_BYTES = 2 * 1024 * 1024`。対象ルートは `handleApi()` で分岐する。

| Method / route | 用途・主要応答 |
|---|---|
| `GET /api/project`, `GET /api/project/changes?since=` | project root/layout情報、外部変更トークンと変更一覧 |
| `GET /api/scenes`, `GET /api/files` | シーン一覧、project root/scenarioDir/files |
| `GET/PUT /api/scene?name=` または本文 `name, source, expectedRevision` | シーン読込/保存。読込は `source`, `revision`。保存はrevisionを返す |
| `GET/PUT /api/setting-file?name=` / 本文 `name, source, expectedRevision` | `setting/` 内文書の読込/保存。`setting.txt`、JSON、game-screens/player-ui等を個別検査 |
| `POST /api/validate` | `source`, `name` 等を検査し診断を返す。`includeProgram` 相当の内部経路はcompileと区別 |
| `POST /api/compile` | シーンまたは全体build用のコンパイル結果 |
| `POST /api/editor-symbols` | 現在ソースを含む定義・参照用symbol data |
| `GET /api/scene-graph`, `GET /api/flow-domains`, `POST /api/validate-flow` | Flow graph、値domain、start/end到達性検査 |
| `GET /api/variables`, `GET /api/assets`, `GET /api/asset-info`, `GET /api/ui-assets` | project symbolやasset catalog/metadata |
| `GET /api/catalog`, `GET /api/standard-library`, `GET /api/standard-library-file` | 補完辞書と標準ライブラリ内容 |
| `GET/PUT /api/player-ui`, `GET/PUT /api/game-screens` | UI themeとscreen configを検証して読書き |
| `GET /api/browse`, `POST /api/project/open` | project選択/切替 |
| `POST /api/native-build`, `/api/native-play`, `/api/project-build` | Native起動またはbuild。debug sessionにはstate/stop routeがある |

`sceneName()`、`safeScenePath()`、`safeSettingDocumentPath()`、`safeAssetPath()` 等がパスを正規化し、root外、symlink経由の逸脱、特殊なパス要素を拒否する。UIで非表示のパスであっても、サーバーのallowlistとroot検査が最後の境界である。API応答形の細部は各routeとvalidatorを正とし、この表はIDEが利用する主要経路の索引である。

## 7. 失敗と競合の扱い

* Parser/Checker/Analyzerの診断、Flow到達性警告、Native起動失敗、build失敗は別の失敗層である。Editor診断が空でもPlayer起動やasset decodeの成功は保証しない。
* `request()` は非2xxを成功データとして扱わず、呼出し元にエラーを返す。画面上の表示先は機能によりstatus、診断一覧、asset error、Flow load errorに分かれる。
* ファイルのrevisionが一致しない保存は競合として止める。利用者は外部版を再読込し、必要な編集を再適用する。
* 選択ファイルが削除/移動された場合はExplorerとopen tabsを更新する。外部ツールがファイルを変更したときはproject change pollingが検出し、編集中データを暗黙に破棄しない。
* 解析や補完を連続実行した際の応答順はsequence/tokenで管理する。遅れて届いた旧応答をUIに反映しない。
* Native debug sessionはサーバープロセスのセッションに結び付く。Editor/サーバー再起動後に以前のsession idが有効とは限らない。

## 8. テストと確認範囲

主要なBrowser入力/IDE回帰テストは `test/editor-typing.browser.cjs`、`test/editor-find.browser.cjs`、`test/editor-quick-access.browser.cjs`、`test/editor-symbol-tooltip.browser.cjs`、`test/editor-analysis-check.cjs`、`test/full-workflow-e2e.cjs`。Flowは `test/flow-layout-browser.cjs`、`test/flow-debug.browser.cjs`、`test/flow-debug-values.browser.cjs`、`test/flow-node-related.browser.cjs`、domain/layout単体テストは `test/flow-domains.test.js` と `test/flow-layout.test.js`。Native経路には `test/native-smoke.cjs` とworkflow関連テストがある。

この仕様書はソース上の現行実装とテストファイル構成に基づく。ここではテストコマンドを実行していないため、列挙したテストが現在のcheckoutで通ること、全ての入力方式/OSで同じキーバインドになることまでは主張しない。Editorの挙動を変更した場合、API単体応答だけでなくdirty/競合、IMEを含むBrowser入力、実際のBrowser PlayerおよびNative経路を対象にしたテストを確認する。
