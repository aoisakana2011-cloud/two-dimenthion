# Player UI・画面文書・描画実装仕様

この文書はゲーム実行時の画面、画面設定、Browser/Native renderer差分、UI設定、save/load lifecycleを実装から説明する。シナリオ言語の命令意味は [`syntax-reference.md`](syntax-reference.md)、Editor側の保存/API全般は [`ide-spec.md`](ide-spec.md)、画面設計の互換性表は [`ui-design-reference.md`](ui-design-reference.md) と作品内 `Title/setting/screens/RENDERING-COMPATIBILITY.md` を参照。

## 1. UIを構成するデータと実行レイヤ

Player UIには別々の設定面がある。`setting/player-ui.json` は会話画面（dialog box、nameplate、choices、controls等）のtheme値、`setting/game-screens.json` はタイトル/ポーズ/Save/Loadなどの画面ID、画面遷移とaction、canvas寸法、背景、slot layoutを定める。`setting/game-screens.json` の `controlSettings` が参照する `setting/screens/ui-controls.txt` は入力スキンとユーザー設定可能項目を定義する。画面固有の文書は `setting/screens/*.html` と `*.css` で、ゲーム実行用JavaScriptではなく、限定HTML/CSSとして `Edit/screen-document.js` がparse/validate/compileする。

同一の画面文書からrenderer-neutralなtree/layout/action情報を生成し、BrowserはDOM/CSSを作り、NativeはC++/SDLで描画・入力する。意味の共通化点は文書compilerの中間表現である。DOM/CSSの見た目が一致するという保証ではない。Browser固有selector/JS、未許可HTML属性、未許可CSSは画面文書仕様に含まれない。

| ファイル/モジュール | 主な責務 |
|---|---|
| `Edit/game-screens.js` | screen config defaults、`withSaveLoadScreens()`による補完、`validateGameScreens()` |
| `Edit/screen-document.js` | markup/style/control settings parser、screen tree compiler、canvas transform、DOM mount、許可action検証 |
| `Edit/player.js` | Browser Playerのscreen stack、action dispatch、focus navigation、dialogue、save/load、UI settings、media |
| `Edit/runtime.js` | rendererから独立したscene state、command実行、action/transition/audio状態 |
| `Edit/server.js` | `/api/game-screens`、`/api/player-ui`、Native起動/停止、設定文書のpath/schema検証 |
| `native/player.cpp` | Native playerの画面設定読込、SDL描画/イベント、Native保存とUI設定処理 |
| `Edit/ui-settings.js` | Editor内Player UI設定画面、JSON/field editor、canvas previewとdrag |

## 2. `game-screens.json` の形状と制約

既定値は `defaultGameScreens()` が定める。基底configは `version: 1`、`scaleMode: "contain"`、`initial: "title"` と `screens` を持つ。既定の画面は `title`、`pause`、`save`、`load`。titleの `start` actionは開始シーンへ、pauseにはresume/save/load action、save/loadには `role: "save-slots"` / `"load-slots"` とslot layoutがある。実プロジェクトの設定を読む際は実データを優先し、defaultオブジェクトを画面仕様そのものと取り違えない。

トップレベルで検証される主なfield:

| field | 実装制約/意味 |
|---|---|
| `version` | 必須で1 |
| `canvas.width`, `canvas.height` | 指定時は整数。幅320–4096、高さ180–4096 |
| `scaleMode` | `contain`, `cover`, `stretch` のいずれか |
| `initial` | screen ID形式 `[A-Za-z][A-Za-z0-9_-]{0,39}`、存在するscreenを指す |
| `screens` | object。1–24画面。各IDは上記形式 |
| `defaultBackground` | asset相対パス。絶対path、空path segment、`.`、`..`を拒否 |
| `stylesheet`, `controlSettings` | `screens/` 下の相対pathで、それぞれ `.css`, `.txt` |
| `saveId` | `[A-Za-z][A-Za-z0-9_-]{0,63}` |
| `titleScene` | `{file, scene}`。fileは相対`.tds`、scene名は識別子形式 |
| `controlSkins` | `validateControlSkins()`で検査されるskin定義 |

各screenは `title`, `description`, `background`, `items` または `template` を持つ。descriptionは最大2000文字、itemsは最大100要素。screen単位の `role` はsave/load slots用の2値で各1画面まで。`slotLayout` は `x`, `y`, `width`, `height`, `rowHeight`, `gap`, `count` の整数で0–4096の範囲、width/height/rowHeight/countは非ゼロ、countは最大100。`slotPages` は1–10、総slot数は最大120。screen musicは相対asset pathかつ文字列長制限がある。slotStyleの色やimage等は240文字まで、fontSizeは8–48。

画面遷移actionは `game-screens.js` のallowlistに限定される: `start`, `continue`, `resume`, `next`, `auto`, `skip`, `hold`, `save`, `load`, `quick-save`, `quick-load`, `slot-page`, `slot-select`, `slot-commit`, `slot-copy`, `slot-move`, `slot-delete`, `slot-lock`, `open-screen`, `setting-value`, `shortcut-cycle`, `reset-settings`, `reset-window-size`, `back`, `quit`。未知action、重複screen role、存在しないinitial/遷移先、壊れたasset pathは保存検査で拒否される。

`withSaveLoadScreens()` は必要なsave/load role screenがないときに追加し、pauseにsave/load actionがないときは項目を足す。これは読み込み互換の補完で、設定ファイルを書き換えるEditor UI操作と同義ではない。`validateGameScreens()` が書込みの受入条件であり、Browser Player側の `gameScreenConfig` が実行時参照となる。

## 3. Screen document parser/compiler

### 3.1 入力と許可領域

`screen-document.js` は `parseMarkup()`、`parseStylesheet()`、`parseControlSettings()`、`compileScreenDocument()`、`compileGameScreens()` のAPIを公開する。HTMLはサポートelement/属性に限定される。許可属性は `id`, `class`, `src`, `alt`, `title`, `for`, `type`, `min`, `max`, `step`, `value`, `checked`, `aria-label`, `aria-hidden`, `tabindex`, `data-action`, `data-target`, `data-value`, `data-role`, `data-count`, `data-setting`, `data-skin`, `data-slot-field`。`on*` event attributeは明示的に拒否される。未知属性は黙って無視せずエラー。

画面要素にはtext/image/button/input等の描画と操作対象があり、設定コントロールには許可されたsetting名・値だけが割り当てられる。HTML内の `data-action` はaction allowlistに照合され、`open-screen`は`data-target`必須、`shortcut-cycle`はF1–F12、`setting-value`はcontrol schemaで許可されたboolean/enum value、`slot-page`は0–9を要求する。`data-value`をsetting-value以外に付けることはできない。クリックは任意JS評価ではなく `options.onAction(action, target, event, actionNode)` へのdispatchである。

### 3.2 Slot templateと安全性

Slot-list画面はslot専用template構造を検査する。テンプレートのbuttonは最大1個でid/data-actionを持たず、内部に別role、action、button、idを持たせない。compilerがslot indexに応じた要素ID、`data-action="slot-select"`、`data-slot-index`を補う。保存データの画像/labelは `data-slot-field` bindingを通して値として挿入し、markupとして再解釈しない。`slotField` callbackは現slotの値を返し、画像値が空の場合はimgを隠す。

`open-screen` targetがconfig内のscreen IDを参照するときは存在検査される。style/hover/focus styleは許可プロパティsubsetに変換される。任意script、任意DOM mutation、外部ファイルinclude、CSS selector全域、ブラウザ固有アニメーション、ネットワークアクセスはportable機能ではない。

### 3.3 中間表現、layout、寸法

compilerのtree nodeはtag/attrs/text/childrenに加えて、rect、style、hoverStyle、focusStyle等を保持し、action一覧もcompile結果に含める。`canvasTransform()` はcanvas論理サイズを実viewportへ変換し、layout寸法は論理canvas上に配置する。pxはこの論理座標単位。`%`は親rect基準。対応する`vw` / `vh` はウィンドウviewportではなくcanvas基準に正規化される。標準1280×720では10vw=128px、10vh=72px。

`contain`は縦横比維持と余白、`cover`はcanvas全体を覆うcrop、`stretch`は縦横別倍率の変形となる。画面safe area、OS scale factor、font metrics、画像cropは同じ座標系へ全面的に正規化されるとは限らない。ゼロサイズpreviewからscaleを計算してはいけない。Editor previewはhiddenから表示になった後、ResizeObserver/再描画で寸法を測る必要がある。

### 3.4 Browser DOM mount

`buildScreenDom()` はtreeをDocumentFragmentへmountする。styleをCSSへ反映し、画像srcは `assetUrl` callbackで解決する。slot値はtextContentまたはimg.srcとして設定する。設定入力はcheckboxならchange、それ以外はinputで `onSettingChange` を呼ぶ。range風controlではpointer captureを使い、pointerdown/move/up/cancelで値を更新する。focus/hoverは実DOM focus/pointer状態からstate styleを更新する。action elementのclickはpropagationを止め、`onAction`へ安全なaction tupleを渡す。

Native側では同じtree情報をSDL widget/draw pathで描画するが、DOM accessibility treeを共有するわけではない。`:hover`、browser native input、font fallback、keyboard/IME、video decoder、audio autoplay policyはrenderer-specificである。

## 4. Browser Player lifecycleとscreen/action

`player.js` の `setActiveGameScreen()` は `activeGameScreen` とDOMの `stage[data-game-screen-open]` を同期する。`showGameScreen(id, {push})` はscreen documentのmount/overlay更新、music再生、focus初期化、履歴操作を含む画面遷移の入口。`activateGameScreenAction(action, target, node)` は各actionをruntime、screen stack、save manager、設定操作へ振り分ける。`back` / `resume`でscreenを閉じるとPlayer controlsが通常状態に戻る。screenが開いている間はgame stage状態とBrowser `#player-controls` 表示を同期し、二重入力を抑える。

`focusFirstScreenControl()` は初期focusを設定し、`navigateScreenFocus()` はArrow keysで近傍controlへ移る候補を距離スコアで選ぶ。HTML focus可能要素とNative SDL focus移動は別実装であり、画面上に見える要素数だけではfocus可能性を判断しない。`aria-label`, `tabindex`等は許可属性として残るが、Nativeに同一のOS accessibility supportがあるとまでは言えない。

Browser screen musicとゲームBGMは経路が異なる。画面音楽は `playScreenMusic()` / `resumeScreenMusic()`、ゲームBGMは `playBgm()`、`animateBgmGain()`、`reconcileBgmAutomations()` を通る。audio settingは `loadUiSettings()`、`updateUiSetting()`、`applyUiAudioMix()` が反映する。`AudioContext`やautoplay制限、decode完了、volume fade精度はBrowser実装依存となる。

## 5. Save/loadデータと操作

Save/load画面は `screenForRole()`、`openSlotScreen()`、`showSlotList()` でroleを解決し、`saveSlotState()`、`readSaveSlot()`、`latestSaveSlotIndex()` でslot状態を取得する。`activateGameScreenAction()` はsave/load/quick-save/quick-load/slot-page/slot-select/slot-commit等を処理し、`runSelectedSlotAction()` はslot選択後のload/save/copy/move/delete/lock等を振り分ける。save slot capacityは `slotLayout.count * slotPages`、総上限120。

Browserは `Edit/save-store.js` の `open()` がIndexedDB database/storeを使い、DB利用不可時はlegacy prefix/localStorage経路へfallbackする。`writeSlot()` はencoded payloadとmetadata/thumbnailを扱い、`transferSlot()` はcopy/move、`read()` は既存データ形式をdecode/migrateしながら返す。ユーザー設定は `writePreference()` で `ui-settings`等のkeyに保存する。Browser保存領域はorigin/profileに依存し、Nativeと同じslot共有領域ではない。

`saveGameToSlot()` はruntime状態をserializeし、必要に応じ `captureSaveThumbnail()` でcanvas画像を作ってslotへ書く。`loadGameSlot()` は検証可能なsaveかを `isLoadableSave()` で確認してstate restoreを始める。Quick save/loadは専用slot規則に従う。空slot、壊れたpayload、互換性のないversion、画像生成失敗、quota不足を一括して「保存済み」と扱ってはならない。実装の画面表示とエラー分岐は `player.js` とsave testsを正とする。

Native Playerはユーザーデータrootに `ui-settings.json` 等を置く。`NOVEL_SAVE_ROOT` はroot上書きに使われ、旧package内 `saves/` を移行元として読む場合がある。Native側slotデータとBrowser IndexedDBには自動同期がない。Windows user data directory、旧package移行、Native save/loadは `native/player.cpp` と `test/native-save-load.cjs` / `test/game-screens-native.cjs` で確認する。

## 6. UI設定とtheme編集

`Edit/ui-settings.js` はEditor内のPlayer UI設定ページを管理する。`loadTheme()` は `/api/player-ui` から取得し、draftと保存済みthemeを分ける。`changed()` はdirty表示を更新し、`saveTheme()` は `PUT /api/player-ui` へthemeを渡す。`parseJsonDraft()` と `#ui-settings-json` は直接JSON編集を提供し、field editorは `getPath()` / `setPath()` と `renderValue()`、`addPrimitiveEditor()` で値を変更する。`#ui-settings-revert` はdraftを読込値に戻す。

previewは `renderPreview()` がcanvas上に会話画面のdialog/message/nameplate/speaker/choices/controls/hitboxなどを組み立てる。`#ui-settings-dimensions`、target basis、grid toggle、snap、grid size、zoom、fitはpreview調整用で、projectのruntime canvas寸法をその場で変える機能と同じではない。`coordinateOrigin()` は部品ごとの座標基準を解決し、`beginDrag()`、`dragMove()`、`endDrag()` はdrag/resizeをtheme座標へ反映する。snap有効時はgridに吸着する。

`sendPlayerPreviewTheme()` は編集中のthemeをPlayer previewへ送り、保存を待たず見た目を試す経路である。`renderAudioMeters()` / audio previewは音量確認用表示で、作品のscenario audio mix自体を書き換えない。`validatePlayerUiTheme()` はサーバー側で設定構造と値域を検証する。保存失敗、JSON parse error、field validation errorは `#ui-settings-error` / statusへ出し、成功時だけdirtyを解除する。

## 7. `player-ui.json` / controls settings

`player-ui.json` はversion 1と `screen`, `dialog.message`, `dialog.nameplate.text`, `choices` 等を必須とする。サーバーの `validatePlayerUiTheme()` が許容field、寸法、色、文字列、asset参照等を検証し、`GET/PUT /api/player-ui` がReader/Writerとなる。theme asset解決は `uiAsset()` / `uiBackground()`、themeの適用は `applyPlayerUi()`、フォントは `applyUiFontFamily()`。character voice mixは `characterVoiceGain()`。

`ui-controls.txt` は `parseControlSettings()` の専用形式で読み、`gameScreenConfig.controlSchema`、`controlDefaults`、`controlSkins`をruntimeへ渡す。`uiSettingRule()` / `isValidUiSettingValue()` は実行時設定値をschemaに照らす。setting変更は `setting-value` actionまたはcontrol inputから `updateUiSetting()`、保存は `save-store` preference（Browser）またはNative設定ファイルへ流れる。Shortcut actionはF1–F12に限定し、`shortcut-cycle`で次の許容操作に切り替える。設定項目が文書に存在しても、Browser/Native双方で同じ効果を持つとは限らないのでrenderer実装を照合する。

## 8. Player scene renderingと状態遷移

`runtime.js` はscene stateを `createSceneState()` で生成し、`sceneStateCommand()` と命令実行器が `say`, `bg`, `show`, `hide`, `play`, `wait`, `effect` 等の描画用状態を更新する。画面rendererはこのstateを見た目へ反映する。Browser側 `player.js` の `command()` はscene command dispatch、`loadScene()` はscene load、`launchGame()` は初期起動を行う。`revealDialogueText()` はtypewriter表示とauto advance、`makeChoice()` はchoice interactionを扱う。

描画レイヤは `applyRenderLayers()`、sprite配置は `sizeSpriteLikeNative()` / `positionSpriteInSlot()`、背景被覆とcameraは `syncBackgroundCoverage()`、`animateCamera()`、遷移は `transitionBackground()`、`fade()`、`applyEffect()`、`moveLayer()` を通る。BGMは複数layer/actionを持てる。mediaでは `media()`、videoは `playVideo()`、generation/action identityとcancel reasonを追う。演出終了、skip、debug pause、scene unloadではanimation/mediaを清掃する経路があり、Browser browser APIsの完了通知はNativeのSDL/media callbackと同時刻とは限らない。

`--only` / visual-only previewは通常の全scenario実行の代替ではなく、画面表示の局所確認モードである。選択肢遷移、全変数状態、save/load継続性、音声/video lifecycleを完全に再現するものではない。

## 9. Browser / Native差分と互換性

| 項目 | Browser | Native |
|---|---|---|
| screen文書 | `compileGameScreens()` → `buildScreenDom()`、HTML DOM/CSS | compiled screen treeをSDL renderer/widgetへ変換 |
| 入力 | pointer/keyboard/DOM input/change、Web focus | SDL eventとNative widget処理 |
| settings | IndexedDB preference、失敗時localStorage fallback | user data rootのJSON、`NOVEL_SAVE_ROOT` override |
| save slots | Browser origin内IndexedDB、metadata/thumbnail | Native user data root/package migration経路 |
| fonts/text | OS/browser font、DOM metrics、IME | Native font/SDL text measurement |
| media | browser decode、AudioContext、HTML media policy | Native decode/mixer/SDL lifecycle |
| layout | CSS box/layout/rendering | SDL座標/texture/widget rendering |
| accessibility | DOM semantics/ARIAの一部 | DOM accessibility treeを共有しない。Native個別機能を確認 |

互換文書は `Title/setting/screens/RENDERING-COMPATIBILITY.md` と `CONTROLS.md` が具体的なHTML/CSS/input subsetの根拠。canvas寸法一致だけでは描画pixel一致を保証しない。font metrics、focus ring、hover、checkbox/range、crop、alpha、音声gain、video codec、OS key repeatを実機で照合する。

画面markup/styleを変更する場合はHTML allowlist、CSS parser/layout compiler、action validation、Browser rendererとNative rendererのすべてを追う。Browserだけで動くscriptやselectorを加えるとshared semanticsから外れる。schema更新時は旧設定の読み込み、validation error、default補完と保存後のround-tripも検査する。

## 10. テストマトリクス

| 面 | 主なテスト | 確認対象 |
|---|---|---|
| Screen config/document compiler | `test/game-screens.test.js`, `test/game-screen-document.test.js` | schema constraints、許可属性/action、tree/layout、CSS subset |
| Browser screen UI/actions | `test/game-screens.browser.cjs`, `test/ui-controls.browser.cjs`, `test/title-screen.browser.cjs` | screen遷移、focus/input、setting永続化、見えるDOM |
| Browser save/load | `test/save-store.test.js`, `test/save-load.browser.cjs`, `test/save-slot-card.browser.cjs` | IndexedDB store、slot metadata、thumbnail、load/save UI |
| Native screen/save | `test/game-screens-native.cjs`, `test/native-save-load.cjs`, `test/native-title-scene.cjs`, `test/native-smoke.cjs` | C++/SDL起動、Native画面・設定・slot操作 |
| UI editor | `test/editor-analysis-check.cjs` 内のUI settings preview assertions | editor preview/drag/settings統合 |

テストファイルが存在することと、今回の環境で成功したことは別である。この資料作成時点では実行結果を採取していない。Browser DOMテストはNative描画の証拠にならず、Native smoke testは全OS/browser media動作の証拠にならない。画面仕様変更を完了扱いにする前に、該当するBrowserとNativeの両方の実行経路を確認する。

## 11. 調査範囲と未確定点

記述は `Edit/game-screens.js`、`Edit/screen-document.js`、`Edit/player.js`、`Edit/runtime.js`、`Edit/ui-settings.js`、`Edit/save-store.js`、`Edit/server.js`、`native/player.cpp`、関連 `test/` と `Title/setting/screens/` の設定・互換性文書を基準にした。Native側は巨大なC++実装の全分岐を逐行追跡したものではなく、設定・save/loadの挙動はNative integration testsも索引としている。各OSのuser-data path実値、SDL font fallback/IME差、全asset codecの対応状況、IndexedDB quota/旧save migrationの全version組合せは、ここでは網羅を確認していない。これらは具体的なruntime/packaged buildで検証が必要。
