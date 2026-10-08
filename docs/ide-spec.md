# IDE / Editor 実装仕様

この文書は `Edit/` のローカルIDEについて、現行実装の責務、状態、HTTP境界、保存と失敗時の振る舞いを記録する。言語の文法と型規則は [`syntax-reference.md`](syntax-reference.md)、コンパイル処理は [`compiler-pipeline.md`](compiler-pipeline.md)、画面文書とPlayer描画は [`ui-runtime-spec.md`](ui-runtime-spec.md) を参照。

## 1. 実行形態と責務の境界

IDEのUIは `Edit/index.html`、`Edit/styles.css`、`Edit/editor.js` で構成される。`Edit/server.js` はNode HTTPサーバーで、プロジェクトの探索、設定/シーンの読み書き、構文解析・型解析・コンパイル、Browser Player起動ページ、Native Player起動を提供する。Electron版は `Edit/electron-main.js` と `Edit/preload.js` がウィンドウ生成やOSダイアログを仲介し、編集ロジック自体は同じWeb UIを使う。`?embedded=1` は埋め込みEditor用の表示状態を切り替える。

EditorはLanguage Server Protocolのクライアントではない。補完、診断、定義位置、workspace symbolは `editor.js` とローカルHTTP API、Parser/Checker/Analyzerの呼び出しで実装する。Browser Playerは `Edit/player.html` と `Edit/player.js`、Native PlayerはC++/SDL実装であり、Editorの表示プレビューとゲーム実行は別の実行経路である。

## 2. 画面領域と主要DOM

`index.html` が用意する主な領域は次の通り。

| DOM ID / selector | 用途と更新主体 |
|---|---|
| `#project-title`, `#project-path` | 現在のプロジェクト情報。`refreshFiles()` が `/api/files` の `title`, `projectRoot` から更新 |
| `#file-tree`, `#file-info` | scene/設定/assetのツリーと選択ファイル情報。`refreshFiles()`、`showFileInfo()` |
| `#editor-tabs`, `#scene-name`, `#editor` | 開いている文書、アクティブ文書名、scene本文 |
| `#line-numbers`, `#highlight`, `#minimap`, `#minimap-content`, `#minimap-viewport` | textareaと同期する行番号、語句色付け、概要と表示範囲 |
| `#suggestions` | 入力位置に応じた補完候補 |
| `#result`, `#status` | 診断本文と短い状態メッセージ |
| `#split-group`, `#split-frame`, `#split-tabs`, `#split-resizer` | 右側Editorの分割ペイン |
| `#project-search-input`, `#search-results`, `#quick-access-input`, `#quick-access-results` | workspace検索とQuick Access |
| `#asset-document-viewer` 以下 | 画像・音声・動画の読み取り専用asset preview、metadata、エラー。accessible nameは `Asset file preview` / `Asset details` |
| `#ui-settings-page`, `#ui-settings-json`, `#ui-settings-preview-stage` 以下 | Player UI theme編集、JSON編集、canvas上のプレビュー |
| `#scene-flow-host`, `#scene-flow-frame` | Scene Flow iframe/パネル |

画面の操作はメニューとボタンのイベントから `editor.js` の関数へ接続する。DOMはワークスペース情報の表示面であり、実際のファイル本文は `editor.value` とEditor内の文書状態が正本となる。Explorerを更新しても編集中の本文が自動で保存されるわけではない。

## 3. 文書・タブ・dirty状態

### 3.1 文書種別

`editor.js` は `activeSettingDocument`、`activeStandardLibraryDocument`、`activeAssetDocument` とシーン名を使い、編集可能なTDSシーンと `setting/` 文書、読み取り専用の標準ライブラリ文書とasset previewを分ける。主なロード関数は `openScene()`、`openSettingFile()`、`openStandardLibraryFile()`、`openAssetDocument()`。`jumpToLocation()` / `jumpToScene()` は診断やシンボルから対象を開き、行・列に移動する。

編集タブは `openTabs`、右側ペインは `splitTabs` が追跡し、`renderEditorTabs()` と `renderSplitTabs()` が表示を作る。分割は `moveTabToRight()` / `moveTabToLeft()`、右ペイン表示は `openSplitScene()`、終了は `closeSplit()` が担当する。未保存内容を破棄する遷移ではdirty確認を挟む。split pane間の切替時に文書を移す操作と、文書を保存する操作は独立している。

Every opened document type, including `setting/` files, must be represented in `openTabs`; selecting, closing, and reopening its tab follows the same active-document lifecycle as scenes. Externally deleted inactive scene documents are removed from open and split tabs; an active deleted document keeps its displayed buffer and warning until the user navigates away.

### 3.2 Dirty、履歴、外部変更

`isDirty`、`sceneRevision`、`projectChangesToken` が保存境界を表す。本文入力は `updateDirtyState()` を介してタブ/Explorerのdirty表示を更新する。`sceneRevision(source)` はサーバーが返すrevisionと照合するための署名で、保存時は期待revisionを送る。`/api/project/changes?since=...` をポーリングして外部変更を取り込み、編集中ファイルに競合がある場合は黙って上書きしない。設定文書も `/api/setting-file` の `expectedRevision` とHTTP 409 `SETTING_CONFLICT` で競合を検出する。

`rememberUndo()`、`restoreEditorHistory()`、`undoStack`、`redoStack` はEditor側の本文履歴であり、ファイル保存履歴ではない。復元後はselection/caretを戻し、dirtyと解析表示を再同期する。`clearEditorHistory()` は文書のロード/履歴初期化に使われる。ファイル削除通知の `forgetDeletedScene()` はopen tabへの参照を整理する。

### 3.3 保存・一括保存

`saveScene()` は現在のシーン名と本文snapshotを `PUT /api/scene` に送り、応答時に同じ文書がまだ開かれている場合だけrevisionを更新する。送信後に本文が編集されていればdirtyを維持し、別文書へ移動済みなら遅れた応答で選択中タブやrevisionを変更しない。`saveAllScenes()` / `saveAllFromMenu()` は未保存のシーンを順に保存し、保存要求の後に残った編集を未保存として表示する。build/playは未保存編集が残る場合に古いディスク本文で続行しない。設定ファイルも `PUT /api/setting-file` 応答後の本文snapshotと文書identityを照合する。JSON設定はパースと対象ごとのvalidatorを通過してから書かれる。Player UI editorは別モジュール `ui-settings.js` の `saveTheme()` が `PUT /api/player-ui` を呼ぶ。

`formatCode()` は現在の本文、`formatProjectScenes()` はプロジェクト内シーンの整形を行う。整形後の本文も通常のdirty状態を経由して保存される。`compileProjectFromMenu()` はbuildを行うが、コンパイル成功はソース保存成功を意味しない。Build出力はEditor上の作業ソースとは別の場所に生成される。`PUT /api/project-build` と `POST /api/native-build` は、scenario・setting・Player UIの保存と同じproject-scoped write lockを使い、別server processからの書き込み中にpack対象やbuild成果物が混在しないよう直列化する。

HTTP server内ではAPI・static requestsはshared project-context gateを通る。`POST /api/project/open` はexclusive gateを取得するため、実行中のrequestが完了するまでproject rootやlayoutを切り替えない。これにより、旧projectのrevisionを読んだ後にlock待ちしている保存が、新projectへ誤って書き込むことを防ぐ。これは1つのserver process内のproject-context切替保護であり、project write lockが担う複数process間の保存直列化とは別の契約である。

失敗時は `request()` がHTTPエラーを例外化し、`showError()` またはstatus/diagnostics領域へ表示する。本文が2 MiBを超えるAPI要求はサーバーが413で拒否する。シーン/設定パスの形式不正やプロジェクト外参照は400相当の失敗となる。保存中の外部更新は409となり、最新ファイルを再読込して編集を統合する必要がある。`serveStatic()` は許可されないIDEリソースや不在ファイルに404、不正なassetパスに403を返し、短い説明は日本語で表示する。

## 4. Editor入力機能

`#editor` はtextareaを基底入力面として、同じ本文を `#highlight` に反映し、line numbers・search overlay・minimapを同期する。HTML/CSS設定ファイルは同梱PrismJS v1.30.0のMarkup/CSS grammarでhighlightし、token colorはTDSと共有するsyntax paletteを使う。TDS等のシナリオ文書は `highlightSource()` でキーワード・コメント等を軽量表示するが、構文解析や型検査の代用ではない。PrismJSの配布ファイルとMIT licenseは `Edit/vendor/prism/` にあり、runtime network requestは行わない。`insert()`、`insertEditorRange()`、`insertEditorNewline()`、`adjustSelectionIndent()` はテンプレート展開、選択範囲置換、改行時インデント、複数行インデントを扱う。IME変換中 (`event.isComposing` または `Process`) は一部キー操作を介入せず、通常の入力を優先する。

補完は `completionContext()` でカーソル前後、コメント/文字列、現在行の構文位置を評価し、`completionScopes()`、`completionScope()`、`completionVariableDeclarations()`、`completionVariableNames()` と `candidatesFor()` が候補を組み立てる。候補源はキーワード、現在ファイル関数、プロジェクト変数・character・asset、include済み関数、標準ライブラリ (`loadStandardLibraryModules()`)、`list.*` / `text.*` intrinsic、`runtime.state.*` APIなど。runtime.stateは名前空間階層と公開メソッドを補完する。`updateSuggestions()` は古い非同期応答を `suggestionRefreshId` で破棄し、`renderSuggestions()` が候補を出し、`acceptSuggestion()` が `completionRange` に挿入する。候補一覧に表示されることは、現在位置で実際に型検査を通る保証ではない。

`validate()` と `scheduleValidation()` は `/api/validate` を呼び、応答シーケンス `validationSequence` で古い診断結果が後着して上書きするのを防ぐ。プロジェクトbuild応答も開始時のファイル名と本文snapshotに一致する場合だけ現在のエディターへ反映し、build中に編集された場合はその診断を捨てて現在の本文を再検証する。再生前buildの対象が編集中に変わった場合は古いpackageを起動しない。ファイル切替後の非同期読込も `documentNavigationSequence` で無効化し、遅れて返ったscene／setting応答が後から選択した文書を上書きしない。Assetのmetadata取得は現在のassetが引き続き選択されていることを確認してから反映する。 ExplorerのFile Infoもrequest IDを使い、同じfileへの更新が重なっても最新の応答だけを表示する。`renderDiagnosticResult()` は severity (`Error`/`Warning`/`Info`)、file、line、column を `#result[role=region][aria-label="検証結果"]` に表示し、build状態の説明は日本語で、技術ラベルは英語で要約する。詳細diagnosticsはlive regionではなく、更新ごとの全読み上げを避ける。`#status[role=status]` は短い完了・件数の要約を通知する。各diagnosticはaccessible nameを持つbuttonで、Tab/Enter/Spaceで操作できる。押すとfileを開いて該当位置へ移動する。`F8` は現在のfileのdiagnostic間を移動し、`Cmd/Ctrl+Shift+M` はProblems領域へfocusする。コード解析結果を使う `editorSymbolsForCurrentSource()`、`compiledVariablesForCurrentSource()`、`showDeclarationTooltip()`、`showVariableTooltip()` は定義・型・利用位置をtooltipに出す。`F12` とコンテキストメニューから定義に移動できる。

Editorの `aria-modal="true"` ダイアログは表示見出しをaccessible nameにし、初期focusを閉じる操作へ置く。Tab/Shift+Tabはダイアログ内で循環し、閉じると起動元へfocusを戻す。背景の操作はbackdropで遮る。Native Playerは別のSDL focus経路であり、このDOMダイアログ仕様の対象外。

Quick Access uses `openQuickOpen()` to filter files and symbols. Workspace-symbol results are refreshed when the scene list changes, even while the palette remains open, so a delayed response from an earlier workspace cannot replace the current project's results. The Command Palette search input is a combobox in a named dialog, links to the listbox with `aria-controls`, and announces the selected option through `aria-activedescendant`. Escape closes the dialog and restores focus to the opener. Editor dropdown menus use `role="menu"`/`role="menuitem"`: Arrow Up/Down opens or moves through items, Home/End selects the first/last item, and Escape closes the menu and restores focus to its trigger. Workspace search uses `#project-search-input`; in-file search uses `#editor-find-input` with result count, previous/next navigation, and single/all replacement. Shortcuts are `Cmd/Ctrl+F`, `Cmd/Ctrl+H`, `F3`, and `Shift+F3`. Other editor shortcuts include `Cmd/Ctrl+/` for line comments, `Alt+Z` for word wrap, `Cmd/Ctrl+Shift+F` for formatting the current scene, and `Cmd/Ctrl+Z/Y` for editor-only history. Long source lines remain on one visual line by default and can be viewed by horizontal scrolling; `Alt+Z` enables optional soft wrapping, and the preference persists. OS/browser reserved keys, IME, and keyboard layout can affect key events.

中央ボタンまたはminimap上のドラッグで中ボタンスクロールを開始し、minimapクリックで本文位置へ移動する。選択・挿入位置と画面スクロール位置は別の状態である。補完のTab/矢印/IME操作などは実ブラウザの入力テストで確認する必要がある。

Editor document navigation uses named `group` containers with ordinary buttons; it does not expose incomplete ARIA `tablist` or `tree` widgets. Open documents use `aria-pressed` on the active selector, with separately named split/close buttons. Explorer folder disclosures are buttons with `aria-expanded` and `aria-controls`; Enter and Space expand or collapse them. Files are buttons named by their full relative path. These controls use the browser's ordinary Tab sequence.

## 5. Explorer、Assets、Scene Flow

`refreshScenes()` は `/api/scenes`、`refreshFiles()` は `/api/files` を読み直す。`showFileInfo()` はシーン・設定・assetの情報を表示し、シーン参照を `jumpToScene()` で開く。コンテキストメニュー `showFileContextMenu()` から名前変更/削除等を行う場合も、最終的なパス検証とファイル操作はサーバー側にある。プロジェクト切替は `/api/browse` と `POST /api/project/open` を使う。

Assetの表示対象拡張子は `assetMediaKind()` に明示され、画像は png/jpg/jpeg/webp/gif、音声は wav/ogg/mp3/flac、動画は mp4/webm。`assetDocumentUrl()` は `asset/` 配下のみを許し、空要素、`.`、`..` を拒否する。`openAssetDocument()` は画像寸法、音声長等のmetadataを表示するが、これは読み取り用ビューでありasset内容の編集機能ではない。Explorerは `Project Folder` を表示し、Project Settingsでは `Scenario Folder` / `Asset Folder` と `Assets` を表示する。Asset path tooltipは `Relative path within Asset Folder`。デコード不能や未対応種別は `#asset-document-error` に出る。

Scene Flowは `flow.html` をiframeとして読み込み、`flow.js` が `/api/scene-graph` のノードと遷移をSVGで配置する。`flow-layout.js` は階層化、交差数低減、直交edge routing、folder境界配置を行う。`flow-domains.js` とサーバーの `/api/flow-domains` は選択ノード/行で変数値が取り得る範囲を計算し、`POST /api/validate-flow` は開始sceneから終端までの到達性等を検査する。Flow test panelの値は静的解析によるdomainの確認用で、任意の外部入力や全実行履歴を再現するruntime debuggerではない。ノードをクリックすると選択し、ダブルクリックまたはフォーカス中のF2で該当sceneをEditorで開く。選択後はDetailsのOpen in Editorボタンも使える（幅が狭くDetailsが隠れる場合はF2を使う）。グラフ更新ではrequest IDを確認し、後から始めたrefreshの結果だけを表示する。グラフのレイアウト座標は表示状態で、シナリオ実行順や本文を書き換えない。

Scene FlowのScene graph語彙は英語で表示する（`Scene`、`Scene transition`、`Reachable`、`Unreachable`、`Parse error`）。ノードのscene数は `file · N scenes`、詳細欄は `Scenes (N)`、`Sources`、`Destinations`、`goto destinations`、`Reachable scenes: N/M` とする。折り返し線の説明も同じ英語UIに揃え、操作手順や補足説明は自然な日本語にする。

## 6. HTTP API契約（IDEが利用する主要経路）

全APIは同じローカルNode server内の `/api/...`。JSON要求は `readJson()` が読み、本文上限は `MAX_BODY_BYTES = 2 * 1024 * 1024`。JSON本文はオブジェクト形式とし、構文不正またはトップレベルが `null`・配列・primitive の場合はHTTP 400、上限を超えた要求はHTTP 413で返す。対象ルートは `handleApi()` で分岐する。

このserverにuser authenticationはありません。listenerは `127.0.0.1` のみで、Hostもloopback名に限定します。`Origin` headerがあるrequestは、Hostと同一originでなければHTTP 403で拒否します。`Sec-Fetch-Site` が`same-origin`または`none`以外のBrowser requestも拒否し、same-siteの別portからのsimple requestを遮断します。Origin/Fetch Metadataなしのloopback requestはNode/Native toolingとの互換用に許可し、Browser/Electron UIはserverと同じoriginから接続します。

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
| `PUT /api/project/settings`, `DELETE /api/file` | project layout設定の更新、シナリオまたは素材ファイルの削除 |
| `POST /api/project-build-status` | 現在のシナリオ状態と最後のbuild snapshotの差分 |
| `POST /api/native-tools/build`, `/api/native-tools/test`, `/api/native-tools/images` | Native build/test/image check。`{ok, stage, output}` に結果全文を含める |
| `GET /api/native-package?name=` | project内に生成されたNative packageの安全な配信 |

`readJson()` は全JSON要求の本文を2 MiBで制限し、JSON object以外のbodyを400、上限超過を413で返す。シーン／設定のstale revisionは409と専用 `code` を返す。Native tool routesは作業ログをWorkbenchに残すため、ツール実行失敗もHTTP 200のJSON応答 `{ok:false, stage, output}` で返す。これらのrouteは `response.ok` だけで成否判定せず、bodyの `ok` と `output` を確認する。

`sceneName()`、`safeScenePath()`、`safeSettingDocumentPath()`、`safeAssetPath()` 等がパスを正規化し、root外、symlink経由の逸脱、Windows alternate data streamや予約device名などの特殊なパス要素を拒否する。`/asset/` URLのpercent-encodingが壊れている場合はHTTP 400で拒否し、server errorとして扱わない。Explorerの `/api/files` 列挙と変更通知の署名スキャンも対象directoryと通常ファイルを検査し、外部symlink/junctionやhard linkが混入した場合は拒否する。UIで非表示のパスであっても、サーバーのallowlistとroot検査が最後の境界である。API応答形の細部は各routeとvalidatorを正とし、この表はIDEが利用する主要経路の索引である。

## 7. 失敗と競合の扱い

* Parser/Checker/Analyzerの診断、Flow到達性警告、Native起動失敗、build失敗は別の失敗層である。Editor診断が空でもPlayer起動やasset decodeの成功は保証しない。
* `request()` は非2xxを成功データとして扱わず、呼出し元にエラーを返す。画面上の表示先は機能によりstatus、診断一覧、asset error、Flow load errorに分かれる。
* ファイルのrevisionが一致しない保存は競合として止める。Editor server経由の書き込みは同一マシン上の複数Editor server process間でもproject単位に直列化する。同じrevisionの要求は一方だけが成功し、後続はHTTP 409となる。ロックはOS temporary directory内のheartbeat leaseで、stale intervalは現在120秒。owner markerが一致するprocessだけが通常終了時にlockを削除し、停止後に残ったlockはstale interval経過後に回収される。ロック取得が約60秒のretry中に解消しなければHTTP 503となる。lockがcompromisedと判定された場合はprovider既定のfatal errorでserver processを終了させる。processがleaseより長く停止した場合に古い処理を拒否するfencing保証はなく、Editor外から直接書き込むprocessも調停しない。staleな `setting.txt` 保存ではscenario/asset directoryを、存在しないnested setting documentへのstale保存では親directoryを作成しない。利用者は最新版を再読込し、必要な編集を再適用する。
* 選択ファイルが削除/移動された場合はExplorerとopen tabsを更新する。外部ツールがファイルを変更したときはproject change pollingが検出し、編集中データを暗黙に破棄しない。
* 解析や補完を連続実行した際の応答順はsequence/tokenで管理する。遅れて届いた旧応答をUIに反映しない。
* Native debug sessionはサーバープロセスのセッションに結び付く。Editor/サーバー再起動後に以前のsession idが有効とは限らない。

## 8. テストと確認範囲

主要なBrowser入力/IDE回帰テストは `test/editor-typing.browser.cjs`、`test/editor-find.browser.cjs`、`test/editor-quick-access.browser.cjs`、`test/editor-symbol-tooltip.browser.cjs`、`test/editor-analysis-check.cjs`、`test/build-warning-toast.browser.cjs`、`test/full-workflow-e2e.cjs`。Build warningのEdge E2Eは複数file:line navigation、close、stale build response、成功build後のdismissを確認する。同じEdge CDP Accessibility tree検査で、Command Paletteのdialog/combobox/listbox、Problems領域、名前付きdiagnostic button、modal内のfocus trap、diagnosticからソースへのkeyboard navigationを確認する。 `editor-analysis-check.cjs` はreadonly標準library document、画像assetのdecode/寸法と失敗表示、WAV duration、WebMのdecode・寸法・duration metadataを検証する。Flowは `test/flow-layout-browser.cjs`、`test/flow-debug-native.browser.cjs`（従来の `test/flow-debug.browser.cjs` からも実行可能）、`test/flow-debug-values.browser.cjs`、`test/flow-node-related.browser.cjs`、domain/layout単体テストは `test/flow-domains.test.js` と `test/flow-layout.test.js`。Native経路には `test/native-smoke.cjs` とworkflow関連テストがある。

この仕様書はソース上の現行実装とテストファイル構成に基づく。ここではテストコマンドを実行していないため、列挙したテストが現在のcheckoutで通ること、全ての入力方式/OSで同じキーバインドになることまでは主張しない。Editorの挙動を変更した場合、API単体応答だけでなくdirty/競合、IMEを含むBrowser入力、実際のBrowser PlayerおよびNative経路を対象にしたテストを確認する。 On 2026-10-07, `node test/editor-quick-access.browser.cjs` passed in headless Edge with CDP Accessibility tree assertions for the Command Palette and Problems; this does not replace assistive-technology user testing. The opening sentence records the documentation snapshot before this run; current test evidence is listed after it.
## Scene Flow上のFrontend Screen

entry programがstart()を呼ぶと、Scene Flowに型付きscreen nodeとscreen/resume relationを表示する。このscreen nodeはgame-screens.jsonのUI stateを表し、編集対象のTDS fileやgoto targetではない。graphの意味は[スタート画面の実行フロー](startup-flow.md)を参照。

Editor起動時のproject選択はこのPlayer screenとは独立している。Electronは `NOVEL_PROJECT_ROOT` または有効なrecent projectを使い、どちらもなければtemporary workspaceを作る。Browser serverの直接起動では `--project`、`NOVEL_PROJECT_ROOT`、呼び出し側の既定project（通常はrepositoryの `Title/`）が使われ、Electronのrecent listやprocess current directoryからは選ばれない。詳細は[Startup flow](startup-flow.md)を参照。

Build-blocking warnings appear in a compact notification at the upper right, below the Build/Play toolbar. It stays visible without a timeout until the user presses its × button. Each warning shows its project-relative file path, line number, and message. Selecting the file:line link opens that file and moves the editor to the diagnostic. Multiple warnings appear in a scrollable list.
