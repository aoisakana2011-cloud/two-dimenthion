# ホーム／セーブ画面方式の調査と推奨設計

調査日: 2026-09-30  
目的: Novel Scriptのホーム、pause/menu、save/load、preferences画面を、作品テーマに合わせて自由にデザインでき、BrowserとNativeでできるだけ同じ操作・見た目にする方式を決める。

## 現行実装への追記（2026-10-04）

現在の配信経路はBrowser DOMとSDL Native rendererであり、NativeにWebView2/Chromiumを組み込む提案は採用していない。画面HTML/CSSは任意Webページではなく、`Edit/screen-document.js`が共通UI treeへ変換する制限付きサブセットである。slotカードはHTMLテンプレートから設定数を展開し、`data-slot-field`で番号・状態・scene・speaker・text・保存時刻・サムネイルを結び付ける。空・保存済み・破損・非互換の全状態を両rendererが分類し、カードrootの限定的な`data-state` CSSも共通で描画する。

サムネイルは保存時の物語画面から取得し、BrowserではIndexedDB、Nativeではuser-data内の`thumb-slot-N.png`に保存する。キャプチャ範囲や保存形式は異なるため、自動同期はしない。両方ともセーブ本体が有効ならサムネイル欠損・破損だけでロード不可にはしない。画面描画の現在の制限は[画面描画互換性](../Title/setting/screens/RENDERING-COMPATIBILITY.md)、操作・保存仕様は[画面設定README](../Title/setting/screens/README.md)を正とする。

## 結論

採用した方式は、**レイアウトをHTML/CSSで記述する画面文書＋型付きEngine UI部品＋許可済みAction API＋共通UI tree**である。

1. ゲーム制御と画面遷移の正本は `game-screens.json`（または将来の同等manifest）。
2. 表示構造と独自レイアウトはHTML、見た目は共通CSSサブセット。画像、hover/focus、Flex/Gridの一部を指定できる。一般ブラウザーと同等の全CSS・responsive機能は提供しない。
3. save gridはHTMLカードprototypeを設定数へ展開し、state/slot-fieldをengine-managed view modelから結ぶ。range/checkbox、tab/page、slot操作も共通部品として実装済み。
4. HTMLから任意JSを実行せず、検証済み`data-action`だけをengineへ送る。UI設定は宣言済みキーと型を検証して永続化する。
5. BrowserとNativeは同じ画面文書・compiled UI treeを使う。Browser DOMとSDL Native rendererは別描画実装であり、ピクセル完全一致は保証しない。WebView2/Chromiumの採用提案は過去案で、現行rendererではない。
6. セーブsnapshot、slot metadata/thumbnail、ユーザー設定を分けて管理する。Browser/Nativeで保存先・物理形式は異なり、自動同期はしない。

タイトル、ゲーム内MENU、SAVE/LOAD、SYSTEM、SOUNDはHTML/CSS・manifest・型付きactionで構成され、BrowserとNativeの実画面・操作テストを持つ。残作業はrenderer差を縮める個別改善であり、以下の調査・段階案は設計根拠と未解決要件を記録した履歴として読むこと。

## 1. 参考にした公式設計と読み取れること

### Ren’Py: ビジュアルノベルに特化したscreen/action/save

Ren’Pyは、story内の画像・scene表示とUI screenを分け、main menuは起動時に自動表示、ゲーム中menuは操作によって表示する。buttonは単一の操作actionを呼び、セーブ画面は画面要素とFileSave/FileLoad/FileDelete等の操作を組み合わせる。screen側からsave slotの日時、名前、thumbnail、loadable/newest等の状態を読み出せる。このため、標準save機能を独自UIから呼べるが、ゲーム本体の保存契約はUIから切り離されている。[Screens and Screen Language](https://www.renpy.org/doc/html/screens.html), [Screen Actions and File Actions](https://www.renpy.org/doc/html/screen_actions.html)

Ren’Pyのslotは単なるindex labelではなく、page、名前、空き状態、上書き確認、削除確認、最新保存、quick/auto page、保存後actionを持つ。thumbnailはセーブ画面へ移る前に取得できる。save fileにはengine/game version、時刻、表示名、任意metadata、screenshotが付き、loadできない旧データ／変更されたscriptへの扱いも設定される。[GUI customization / slots](https://www.renpy.org/doc/html/gui.html), [Saving, Loading, and Rollback](https://www.renpy.org/doc/html/save_load_rollback.html), [Configuration: saving](https://www.renpy.org/doc/html/config.html)

### Godot: Control tree、container、theme、focus

GodotはUIをControl node treeとして構成し、Button/Label等の内容部品と、HBox/VBox/Grid/Margin/Scroll等のlayout部品を分ける。Containerが子の配置を管理し、nestすることで解像度変化に追従する。Themeを部品種類へ適用し、キーボード/controller focus navigationを扱う。[UI overview](https://docs.godotengine.org/en/stable/tutorials/ui/index.html), [Containers](https://docs.godotengine.org/en/stable/tutorials/ui/gui_containers.html), [Theme editor](https://docs.godotengine.org/en/stable/tutorials/ui/gui_using_theme_editor.html)

ここから採るべき原則は「レイアウトコンテナをエンジン部品として持つ」「画面専用styleと共有themeを分ける」「マウスだけでなくkeyboard/gamepad focusを第一級の状態にする」。絶対座標だけを許す画面形式では、save gridや各解像度の調整がすぐ破綻する。

### Unity UI Toolkit: markup/style/data/eventを分離

Unity UI ToolkitはUXMLでvisual treeを記述し、USSでstyle、runtime codeでdata bindingとeventを扱う。標準Button/Toggle/ListView等、reusable control、flex-based layout、event dispatchを提供する。Unityは新しいUIにUI Toolkitを推奨している。[UI Toolkit overview](https://docs.unity3d.com/ja/6000.0/Manual/ui-systems/introduction-ui-toolkit.html), [Runtime UI](https://docs.unity3d.com/cn/2023.2/Manual/UIE-support-for-runtime-ui.html)

ここから採るべき原則は、markup/style/engine behaviorの分離と、データ集合の表示に専用list/repeaterを使うこと。プロジェクトへUnityの仕組み自体を導入するという意味ではない。

### Web標準: responsive layoutとkeyboard semantics

CSS Grid/Flexは画面幅に応じて列数や余白を調整でき、media queryはviewport・向き・ユーザー設定等でlayout/styleを切替できる。Gridで視覚順だけをDOM順と違わせるとkeyboard操作順が不自然になるため、文書順を意味順に保つのが重要。[MDN Responsive Design](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout/Responsive_Design), [MDN Grid accessibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Grid_layout/Accessibility)

操作可能なUIはマウスだけでなくキーボードからfocus・activationでき、focus表示を持つべきである。buttonらしい見た目のdivを大量に作るより、button、input、select等の意味要素とARIA labelを使う。[MDN Keyboard accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility/Guides/Understanding_WCAG/Keyboard)

### Storage: BrowserはlocalStorageよりIndexedDB

localStorageは小さな文字列設定向けで同期API。一方IndexedDBは大量の構造化データやBlobを扱うtransactional client databaseで、screenshot入りsave recordに向く。[MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)

Nativeは作品package横ではなくユーザー書込み可能な専用user-data directoryが適切。作品インストール先がread-only、管理者権限、更新で置換、USB移動等でもsaveを守れる。Godotもuser://の永続データ領域とJSON/独自保存を分けて説明している。[Godot saving games](https://docs.godotengine.org/en/latest/tutorials/io/saving_games.html), [Godot file/data I/O](https://docs.godotengine.org/en/stable/tutorials/io/)

## 2. 現在のエンジンに対する評価

現在すでにある土台:

- `game-screens.json`にinitial、canvas、screenごとのtemplate/background/roleを置く。
- HTML/CSS文書を`Edit/screen-document.js`で制限付きUI treeへコンパイルする。
- 許可されたbutton action、range/checkbox、画像、save-slots/load-slots roleがある。
- Browser側はDOMへUI treeを作り、hover/focusとUI設定変更を扱う。
- Native側にも画面設定／コントロールをpackageする経路とsmoke testがある。
- Browser save snapshotはfile/scene/line、variables、locals、sceneState、現在の話者・本文・時刻等を保存する。

調査時点の課題を現行コードで再評価:

1. HTML/CSSはnative browser documentではなく独自の小さなparser/layoutであり、標準CSSの表現力を大きく制限する。
2. **解消済み:** save/load slotはHTMLテンプレートから複製され、thumbnail、number、status、scene、speaker、text、saved-atを個別に配置できる。サムネイルは両rendererで表示される。ただし現状の画像は背景・立ち絵・追加画像で、会話欄・本文・選択肢を含む全画面ではない。
3. save gridは汎用の任意data bindingではなく、`save-slots`／`load-slots` roleに結び付いた固定数展開である。
4. BrowserはIndexedDB（利用不能時はlocalStorage fallback）、NativeはSDLユーザーデータ領域を使う。Nativeはslot JSONとthumbnail PNGを別ファイルで保存し、`NOVEL_SAVE_ROOT`で保存先を指定できる。Browser/Native間の自動同期はなく、可搬性・容量・backup方法も異なる。
5. **一部解消:** BrowserのSaveStoreはsnapshot／metadata／thumbnailを分離し、IndexedDBでは同一トランザクションで更新する。NativeはsnapshotとPNGを別ファイルに保存する。preferenceも別管理だが、両platformで同一の物理schema/serviceを共有するわけではない。
6. title、pause、save/load/preferences間のnavigation、continue availability、page switching、slot copy/move/delete/lockは実装済み。screen history/actionを中心とした契約であり、複雑な任意遷移workflowやgamepad navigationは未実装。
7. Web画面とNative画面のrenderer差により、同じUI treeでもfocus、font、range、text wrap、hover、image cropの見た目が一致する保証はない。

## 3. 推奨する4層モデル

```text
作品画面文書                 Engine services                 Renderer
HTML structure + CSS theme -> typed UI tree / view models -> Browser DOM
Screen manifest + actions  -> Navigation / SaveStore       -> SDL Native renderer
```

### A. Screen manifest（画面の意味・遷移）

JSONは画面一覧と起動点、ゲーム用とtitle用screenの分類、各document/style、画面ごとのbackground/music、標準action、save role、layout profileを保持する。現在のJSONを捨てず、現行の`version`管理されたmanifestを画面metadataの正本にする。

責務:

- 起動時に最初に出すscreen (`initial: title`)
- title/home、pause、save、load、system、sound、about等のID
- screen間の遷移とback stack policy
- story開始、continue、save/load、quit等のaction eligibility
- save/load screenのmodel（slotページ数、autosave/quick/manual分類、一覧のread/write mode）
- document HTML/CSSへの安全な相対参照

manifestは座標・色・各ボタンを重複定義しない。documentが存在するscreenではHTML/CSSが見た目の唯一の正本。

### B. View document（自由な構造・見た目）

HTMLは意味順の構造、CSSはlayoutとappearanceを持つ。Web標準をそのまま全部採用するかはNativeのrendererを決めてから確定するが、最低限次の文法群を共通サポートすべき:

- semantic elements: `main`, `nav`, `header`, `section`, `button`, `label`, `input`, `img`, `p`, `span`, `ul/li`等。
- reusable class/id、descendant selector、pseudo states `:hover`, `:focus-visible`, `:disabled`, `.is-selected`。
- flex/grid layout、gap、min/max size、aspect ratio、overflow/scroll、percentage/viewport units、z-order。
- border radius、background image/size/position, gradients/color, opacity, text style, shadow, focus ring。
- narrow/wide orientationやcanvas aspect ratioに基づくbreakpoint。
- `asset/...`相対参照だけを許可。ネットワーク参照、script、inline event handler、任意filesystem accessは不可。

HTML/CSSに見える書きやすさを優先しつつ、screenから触れるengine APIは明示attributeだけにする。画面は任意scriptなしで十分に表現でき、action値はコンパイル時にallowlist検証される。

### C. Engine UI components（エンジンが意味を知る部品）

最初に必要なのは次の少数部品。

| Component | Engineが提供するもの | Designerが決めるもの |
|---|---|---|
| SaveGrid/SaveSlot | slot一覧、empty/loadable、metadata、thumbnail、latest、page | カード構造、画像比、文字位置、列数、state styling |
| PageTabs | manual/auto/quick等のpage stateと切替 | tab外観、並べ方、active state |
| ContinueButton | newest valid save有無、押下時load | label/art、無効時表示、hover/focus |
| RangeSetting | key、min/max/step、現在値、変更通知 | track/thumb、label/layout/value text |
| ToggleSetting/SelectSetting | 型付き設定値のread/write | control art、説明、現在値表示 |
| ConfirmDialog | delete/overwrite/return-to-title等の確認 | 文面、画像、ボタン配置 |

SaveGridは固定の`data-count`だけではなく、スロットを繰り返し展開するlist componentとする。安全かつ自由にする実装案は、画面文書のsave-grid内にslot itemのprototypeを1個書き、許可された`data-slot-field`でのみデータをbindする方式。

```html
<section class="save-list" data-component="save-grid" data-mode="load" data-page-size="12">
  <button class="save-card" data-component-item="slot" data-action="save.load">
    <img class="save-card__shot" data-slot-field="thumbnail" alt="保存時の画面">
    <span class="save-card__chapter" data-slot-field="chapter"></span>
    <time class="save-card__time" data-slot-field="savedAt"></time>
    <span class="save-card__dialogue" data-slot-field="dialogue"></span>
    <span class="save-card__state" data-slot-field="stateLabel"></span>
  </button>
</section>
```

`data-slot-field`は任意pathやexpressionを評価せず、`thumbnail`, `chapter`, `scene`, `savedAt`, `dialogue`, `stateLabel`, `playTime`, `slotNumber`等の既知fieldだけを許可する。空slotではthumbnail/time等が空値、load actionはdisabled、save actionなら保存可能。これでカード全体のCSS自由度を維持し、任意JavaScriptや任意slot data accessを避けられる。

### D. Engine action API（実行権限）

buttonはengine action名を送るだけで、TDS式やJavaScriptをHTML内で評価しない。例: `game.new`, `game.continue`, `screen.open`, `screen.back`, `game.save`, `game.load`, `save.delete`, `save.page.next`, `settings.set`, `game.quit`。actionごとに必要payloadをschema化し、currently allowed/disabledもEngineが返す。

`data-action="save.load"`のボタンから送るrequest例:

```json
{"action":"save.load","payload":{"slotId":"manual-0007"}}
```

Engineは結果を`success`, `confirmation-required`, `unavailable`, `error`に分け、UIは確定dialog・toast・disabled reasonを表示する。slot indexを直接ファイルパスに連結しない。外部dataはtextContent相当として扱い、保存metadataにHTMLを実行させない。

## 4. ホーム画面の仕様案

### 起動時のstate

起動時にEngineはtitle menu view modelを1度ロードし、`continue`の可否、最新save要約、新規／resume項目、system等への遷移を返す。load slotを列挙するのとContinueは同じSaveStoreから得る。

```text
起動 -> title screen
  ├─ はじめから -> 必要な確認 -> entry sceneを初期stateで開始
  ├─ つづきから -> newest valid autosave/manual policyで復帰
  ├─ データを読む -> load screen (manual/quick/auto page)
  ├─ 環境設定 -> preferences group
  ├─ extra/about -> story-defined screen
  └─ 終了 -> Nativeで確認後quit / Browserではclose不可を明示
```

homeのボタンをCSS background imageにするだけでなく、button内に`img`とtextを自由配置できる。idle/hover/focus/selected/disabled各状態のartをCSS pseudo stateで切替し、画像のみボタンにもaccessible labelを必須にする。未ロードsaveがない時はContinueを隠すかdisabledにし、作品側で選べる設定を用意する。

title背景音楽は画面manifestのscreen music設定として扱い、sound preferencesのBGM mute/volumeを反映する。ブラウザーautoplayで再生開始できない場合は最初のuser gestureで再開する。screen遷移時に音楽を停止するか維持するかはnavigation policyで明示する。

## 5. Save/Load画面の仕様案

### 5.1 Slot model

slot idは表示番号と分離する安定IDとし、slotを次の種類に分類する。

- `manual`: ユーザーが選ぶ複数pageの保存枠
- `quick`: quick save/quick load専用の循環枠
- `auto`: autosave枠。UIでは保護状態や最新位置を表示
- 将来 `checkpoint`: エンジン／シナリオが指定するcheckpoint

slot summaryは次のようなデータを返す。

```json
{
  "slotId": "manual-0007",
  "kind": "manual",
  "status": "loadable",
  "savedAt": "2026-09-30T08:15:00Z",
  "gameVersion": "1.2.0",
  "chapter": "入学式の朝",
  "scene": "crossroad",
  "speaker": "綾瀬",
  "dialogue": "曲がり角の向こうから、誰かが走ってくる。",
  "playTimeSeconds": 4520,
  "thumbnail": "save-thumbnail:manual-0007"
}
```

画面表示用summaryと重いruntime snapshotは別recordにする。Load画面の初回表示はsummaryだけ読み、thumbnailはvisible card近辺から遅延ロードできる。空slotは`status: empty`、古いschemaや別作品のdataは`incompatible`、破損は`corrupt`などを区別する。

### 5.2 Slot actions / behavior

- Save screen: occupied slotを押すと上書き確認を出し、save成功時だけscreenを閉じる／成功通知を出す。
- Load screen: empty/invalid slotはdisabled。load前に必要なら現在stateをautosaveしておく。
- Delete: 別actionで明示し、誤クリック防止の確認を行う。削除後はそのpageのslot modelをrefresh。
- Page tabs: page changeはURL/navigationでなくUI view state。keyboard/gamepadから切替可能。
- Continue: SaveStoreが選ぶnewest valid manualまたはauto slotをロードし、壊れた最新slotで止まらず次点へfallbackするpolicyを持つ。
- Quick save/load: UI buttonとshortcutが同じengine actionを呼ぶ。slot名／pageのルールを一箇所に集める。
- title画面からのloadとゲーム中menuからのloadは同じserviceを呼ぶが、成功後のnavigation policyは異なる。

### 5.3 Thumbnailと書込タイミング

Save操作を押した瞬間にsave画面を描画してから撮影すると、save UIがthumbnailに写り込む。Ren’Pyが説明するように、**画面遷移前に現在のplay画面をcaptureし、その後metadataとruntime stateをまとめて保存する**順序にする。保存中のaudio/videoはthumbnailには含めず、resume時のstate restoreに扱いを限定する。

保存可能pointはdialogue/choice等の安全なinteraction boundaryを基本にする。fadeやblocking move/audio/videoの途中は、実行taskを再開できる形式を作るまではsave禁止、または次のsafe pointまで保留する。無理にasync callbackやOS audio handle自体をserializeしない。

## 6. Save dataとPreference dataを分ける

### Save snapshot

論理schema例:

```json
{
  "format": "novel-save",
  "schemaVersion": 2,
  "projectId": "stable-project-id",
  "gameVersion": "1.2.0",
  "engineVersion": "...",
  "createdAt": "...",
  "checkpoint": {"file":"chapters/one.tds","scene":"crossroad","line":42,"id":"crossroad.before-meet"},
  "execution": {"globals":{},"frames":[],"readonly":[],"loopScopes":[]},
  "sceneState": {"background":{},"characters":[],"audio":{},"ui":{}},
  "display": {"chapter":"...","speaker":"...","dialogue":"...","thumbnailRef":"..."}
}
```

- `schemaVersion`はengine save envelopeの読み替え、`gameVersion`は作品更新との互換判定に使う。
- `projectId`で別作品／別project rootのslot混入を避ける。作品名や保存pathだけで同一作品判定しない。
- source行番号だけの復帰はシナリオ改稿でずれる。短期はfile/scene/line＋scenario fingerprintで一致確認し、将来は任意名checkpoint IDを指定できるようにする。
- runtime snapshotにはint64を失わない表現を使い、JSON numberの丸めを避ける。現在のBrowser serializerのBigInt markerを正式schemaに取り込むか統一する。
- schema migratorはversionごとに純粋な変換を用意し、変換不能時に元ファイルを消さず理由を表示する。
- 書込みはtemp record→検証→atomic replaceに近いtransaction。BrowserはIndexedDB transaction、Nativeはuser-data内temporary file + flush/rename等。途中終了で既存slotを壊さない。
- autosave/quick/manualは別slot namespaceと保持数policyを持つ。autosave削除／上書きの扱いをmanualと区別する。

### User preferences

音量、dialog opacity、画面モード、文字速度、skip/auto、window設定等はstory checkpointへ含めないuser preferencesである。Saveをloadしてもユーザーの音量や表示設定が昔の値へ戻らないようにする。Browserは小さいpreferenceだけlocalStorage可、slot metadata/snapshot/thumbnailはIndexedDB。Nativeはアプリのuser-data directory配下へpreferenceとsave profileを分ける。将来platform adapterを作り、同じkey schemaを使う。

## 7. 推奨する糖衣構文と設定例

### 画面一覧は現在のmanifestを維持

JSON manifestは画面ID、document、style、role、action policyを宣言する。デザインをJSON座標へ戻さない。

```json
{
  "version": 2,
  "initial": "title",
  "canvas": {"width": 1600, "height": 900, "fit": "contain"},
  "screens": {
    "title": {"template": "screens/title.html", "stylesheet": "screens/title.css", "music": "bgm/title"},
    "save": {"template": "screens/save.html", "role": "save-slots", "mode": "manual"},
    "load": {"template": "screens/load.html", "role": "load-slots", "mode": "manual"},
    "system": {"template": "screens/system.html", "role": "preferences"}
  }
}
```

### title HTML/CSSで独自画面

```html
<main class="title">
  <img class="title__logo" src="asset/ui/logo.png" alt="作品名">
  <nav class="title__menu" aria-label="タイトルメニュー">
    <button class="menu-button" data-action="game.new">はじめから</button>
    <button class="menu-button" data-action="game.continue" data-bind-disabled="continue.available">つづきから</button>
    <button class="menu-button" data-action="screen.open" data-target="load">データロード</button>
    <button class="menu-button" data-action="screen.open" data-target="system">システム</button>
    <button class="menu-button" data-action="game.quit">終了</button>
  </nav>
</main>
```

```css
.title { display:grid; grid-template-columns:minmax(18rem, 34vw) 1fr; min-height:100%; }
.title__menu { display:flex; flex-direction:column; gap:1.15rem; align-self:center; padding:4vw; }
.menu-button { background-image:url("asset/ui/menu-idle.png"); background-size:100% 100%; border:0; min-height:4rem; }
.menu-button:hover, .menu-button:focus-visible { background-image:url("asset/ui/menu-hover.png"); }
.menu-button:disabled { opacity:.45; }
```

この記法の肝は`data-bind-disabled`のようなbindingが許可されたview-model pathに限定されること。JavaScript式を任意evalしない。

### Save画面

HTMLにslot cardを一度だけ書き、Engineがslot summaryの数だけtemplateをcloneする。CSS gridでcolumns、card image、chapter/text、state badge等を自由に配置する。カードtemplateを誰でも自由にscript化する方式でなく、標準field bindingをサポートする。

### TDSからの任意UI遷移

シナリオ文法に`home/menu/save`専用の座標・style命令は増やさない。シナリオから画面を開く必要があるなら、意味のある少数命令（例: `ui.open "screen-id"`、`ui.close`）だけをruntime commandとして定義し、画面内buttonも同じnavigation serviceを呼ぶ。通常はtitle/pause/saveのルーティングはmanifestと標準Engine actionで足りる。

slotカードに表示するstory固有情報の糖衣は、任意dictをUIへ晒すのでなく、明示的なdisplay metadata APIを小さく追加する。

```tds
# 例示案。現行TDS文法に実装済みではない。
save label "入学式の朝"
save metadata chapter = "第一章"
```

story metadataは表示専用snapshotにだけ入り、loadされるglobal変数や分岐結果とは別フィールドに置く。標準ではchapter/scene/speaker/dialogue/timeをEngineが取得し、作品固有の表示labelだけを任意指定にする。

## 8. Native rendererをどうするか

### 候補比較

| 方式 | HTML/CSS自由度 | Browserとの見た目一致 | 配布・保守 | 評価 |
|---|---:|---:|---:|---|
| 現行制限treeを拡張しSDL描画 | 低～中 | 低～中 | 初期導入が軽いがCSS実装を自前保守 | 今の制限が再発する。共通IRの基盤には使える |
| WebView2をNativeのmenu画面へhost | 高 | Windowsでは高 | Evergreen runtime検出／installer／host bridgeが必要。Fixed runtimeは250MB超増の可能性 | 現行Windows desktop配布なら第一候補 |
| CEF/ChromiumをNativeにembed | 高 | 高 | cross-platform化しやすいがruntime配布・build・更新・security負担が大きい | 複数OSで同等UIが必須の場合の選択肢 |
| CSS-to-SDL独自実装で全CSS準拠 | 見かけ上高 | 実ブラウザーと微差 | selector/layout/font/eventを継続的に自作 | 推奨しない。CSS標準の再実装がエンジン保守の本業になる |

MicrosoftのWebView2はNativeアプリ内にweb contentをhostできるが、host側bridgeへweb contentが接続されるため、公式Security guidanceどおり、trusted local documentsのみ読み、navigation/permissionsを制限し、少数の型付きmessageだけを受け付ける必要がある。[WebView2 security](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security)

WebView2配布ではRuntimeの存在確認が必要。Evergreenはsecurity/feature updateを受け取るが環境ごとのversion差を前提にする。Fixed Versionはversion固定できる反面Runtimeをpackageへ含める必要があり、公式記載でbinaryは250MB超となる。[WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)

CEFはChromiumを別アプリへ埋め込むframeworkだが、browser engineそのものを同梱・更新・security対応する責任が増える。[CEF project](https://github.com/chromiumembedded/cef)

### 当時の推奨案（現行採用仕様ではない）

以下は調査時に検討したWebView案である。現在は採用していない。現行Native playerはSDL rendererであり、共通の限定HTML/CSSをUI treeへ変換して描画する。WebView2/CEFは将来の選択肢として比較した記録で、実装手順や現在の方式として読まないこと。

当時はBrowser DOMを正本とし、NativeでWebView2を利用する案を推奨した。現在はこの判断を採用せず、Native独自SDL rendererで共通UI treeを描画する方式に決定している。WebView合成やCEF prototypeに関する以下の旧検討は、現行実装の要件ではない。

## 9. 当初の実装順序と合格条件（履歴）

以下は調査時点の計画であり、現在の残作業一覧ではない。Phase 0–3は一部差分を残しつつ実装済み。Phase 4のWebView renderer案は不採用で、SDL Native rendererを継続している。

### Phase 0: 現行契約を固定

- Screen manifest、UI tree、Browser actions、Native screen action、SaveStore、slot summaryの現状を分けてテスト化。
- Browser/Nativeに同じmock view modelとaction traceを入れる。
- 画面READMEの古い記載と`vw/vh`等既知差分を解消。

### Phase 1: Engine SaveStoreへ集約

- Browser localStorage direct accessをSaveStore interfaceへ封じ、IndexedDB adapterを実装。
- Native save pathをpackage隣からuser dataへ移行し、旧slotを安全にimportできる手段を用意。
- save schema/version/project ID、metadata、thumbnail、migration、corrupt handlingを定義。
- save/load/delete/continue/quick/autoをUIから独立したRuntime APIにする。

### Phase 2: UI treeにrepeatとslot fields

- `<save-grid>` prototypeを1つ定義し、SaveStore summaryに基づきitemsを作る。
- CSS grid/flex、overflow、responsive sizing、pseudo state、focus/keyboard/gamepad navigation。
- empty/loading/incompatible/corrupt/writing/confirm/error statesを用意。
- Browser E2Eで12slot、複数page、custom card layout、keyboardのみ操作を検証。

### Phase 3: home/menu navigation

- initial screen→new/continue/load/preferences/about/quitを状態機械として定義。
- title画面からsave/load、ゲーム中menu、return-to-title、quitの確認を検証。
- Continue availability/newest saveとload screenのslot一覧が同じSaveStore query結果を使うことを検証。

### Phase 4: Native HTML renderer prototype

- 1 screen（titleとpauseのいずれか）をBrowserとNativeで同じHTML/CSSから描画。
- alpha overlay、focus routing、keyboard/controller、window resize、DPI、Japanese font、image assets、screen action bridgeを測る。
- package size、cold startup、memory、native build/deployment依存を記録し、WebView2 vs CEF vs SDL rendererを決定。

### 完了条件

- Browser/Nativeで同一fixtureのaction sequenceとSaveStore結果が一致する。
- save UIを変更してもruntime snapshot schema／scenario executionがUI依存にならない。
- cardをHTML/CSSだけで全面再配置し、slot数や列数を変えてもTDS/runtime compilerにsave画面専用分岐を増やさない。
- 破損slot、別作品slot、旧version、容量不足、保存中終了に対して既存データを壊さない。
- mouse、keyboard、gamepadのfocus/activate/backが同じaction contractへ到達する。

## 10. 最終判断

**現行方式は、画面HTML/CSS＋manifest遷移＋許可済みengine actions＋共通UI treeをBrowser DOM/SDL Nativeの両方で描画する構成である。** セーブsnapshot・thumbnail・preferenceは分離し、renderer固有の保存adapterを使う。作品側はテンプレートや画像・色・レイアウトを編集できるが、使えるCSSは互換性表に記載した限定サブセットである。

完全なHTML/CSS自由度と自前SDLの低依存配布を同時に得ることはできない。現在は配布サイズ・Web runtime依存を避けるためSDL共有treeを選択している。将来renderer方針を再検討する場合は、WebView2/CEFを「すでに採用済み」と誤読せず、配布・セキュリティ・OS範囲を再評価する必要がある。

## Sources

- [Ren’Py Screens and Screen Language](https://www.renpy.org/doc/html/screens.html)
- [Ren’Py Screen Actions and File Actions](https://www.renpy.org/doc/html/screen_actions.html)
- [Ren’Py GUI Customization](https://www.renpy.org/doc/html/gui.html)
- [Ren’Py Saving, Loading, and Rollback](https://www.renpy.org/doc/html/save_load_rollback.html)
- [Godot UI overview](https://docs.godotengine.org/en/stable/tutorials/ui/index.html)
- [Godot Containers](https://docs.godotengine.org/en/stable/tutorials/ui/gui_containers.html)
- [Godot Theme Editor](https://docs.godotengine.org/en/stable/tutorials/ui/gui_using_theme_editor.html)
- [Unity UI Toolkit](https://docs.unity3d.com/ja/6000.0/Manual/ui-systems/introduction-ui-toolkit.html)
- [MDN Responsive Design](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout/Responsive_Design)
- [MDN Grid Accessibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Grid_layout/Accessibility)
- [MDN Keyboard Accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility/Guides/Understanding_WCAG/Keyboard)
- [MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [WebView2 Security](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security)
- [WebView2 Distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)
- [CEF Project](https://github.com/chromiumembedded/cef)
