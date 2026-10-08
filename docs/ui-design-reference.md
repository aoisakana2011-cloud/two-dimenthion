# Novel Script ゲームUI設計・実装リファレンス

更新日: 2026-10-06
対象: ゲーム内UI、タイトル/システム/セーブ画面、HTML/CSS画面定義、Browser/Nativeプレイヤー、UI素材、TDS演出命令、エディタの画面編集、テスト。

この文書は「現在の実装」と「未実装/今後の設計課題」を分けて記す。HTML/CSSを画面記述に利用できるが、一般ブラウザの完全なHTML/CSSランタイムを内蔵しているわけではない。安全な画面定義を共通ツリーへコンパイルし、Browser DOMとSDL Nativeがそのツリーを別々に描画する。

## 1. UIの全体構成

作品の画面は、シナリオ本文とは別のプロジェクト設定として管理する。

```text
Project/
  setting/
    game-screens.json           # キャンバス、初期画面、画面一覧、共有CSS等
    screens/
      *.html                    # 各画面の要素と操作
      shared.css                # 共有画面スタイル
      ui-controls.txt           # プレイヤー設定の初期値/許可キー
  asset/
    ui/                         # 画面背景、ボタン、パネル、アイコン等
  senario/                      # TDS本文。画面設定とは別
```

主要実装:

| 役割 | ファイル |
|---|---|
| 画面設定の検証・既定値 | `Edit/game-screens.js` |
| HTML/CSS subsetの解析、共有ツリー生成、共通座標 | `Edit/screen-document.js` |
| Editorの画面設定/プレビュー | `Edit/editor.js` |
| BrowserプレイヤーのUIと画面操作 | `Edit/player.js`, `Edit/player.css` |
| Native SDL描画・入力・保存画面 | `native/player.cpp`, `native/runtime.hpp` |
| 作品サンプル設定 | `Title/setting/game-screens.json`, `Title/setting/screens/` |

画面HTML/CSSは作品側の設定であり、アプリケーション本体の画面とは別である。任意スクリプトを画面へ実行させず、許可されたアクションと設定キーにだけ接続する方針。

## 2. 描画経路とデータの流れ

```text
game-screens.json + HTML + CSS + ui-controls.txt
                  │
                  ▼
        Screen document compiler
  安全検査 / action・setting検査 / layout計算
                  │
                  ▼
        Renderer-neutral UI tree
          ┌───────┴────────┐
          ▼                ▼
     Browser DOM       Native SDL renderer
```

- **Editor preview**: 共通ツリーをBrowser DOMにしてプレビューする。主に編集時確認。
- **Browser player**: 同じ画面ツリーをDOMで描画し、ブラウザ内再生に使う。
- **Desktop/Native player**: 共通ツリーの意味・矩形・操作をNative SDL側で描画する。WebView2は使用しない。
- 画面ツリーは共有されるが、フォントラスタライズ、標準コントロール、OS DPI、入力の細部まで同一描画器ではない。したがってBrowserのプレビューだけではNative出荷時の見た目を保証しない。

画面の描画はゲーム本編の状態と分離される。セーブ画面・システム画面等はゲーム表示の上に重なる画面で、pause/menu画面は背景を持たなければ直前のゲームフレームを下地として利用できる。画面の切替は `data-action` の安全な操作語彙を通じて行う。

## 3. 画面種類と現行サンプル

Title作品では概ね以下の画面IDを使用している（有効なID/テンプレートが正本）。

| 画面 | 主な目的 | 内容・操作 |
|---|---|---|
| `title` | 起動時のホーム | Continue、Start、Load、Extra/About、System、Quit等 |
| `pause` | ゲーム中メニュー | Back/Next、Save/Load、Auto/Skip、Log/System等 |
| `save` | 保存 | ページ切替、スロット選択、保存確定、コピー/移動/削除/ロック等 |
| `load` | 読込 | 保存情報、スロット状態、読込操作 |
| `system` | ゲーム設定 | 表示・スキップ・オート・速度・ショートカット等 |
| `sound` | 音量設定 | Master/BGM/SE/Voice、mute、作品固有の音量欄 |
| `log` | テキスト履歴 | 最近の台詞をスクロール表示 |
| `about`, `guide`, `extra` | 作品固有の情報/追加画面 | テンプレートと操作の範囲で構成 |

Titleの参考画面を再現した実画面テンプレートは `Title/setting/screens/{title,pause,save,load,system,sound,log}.html` と `shared.css`。これは一作品のサンプルであり、全作品に固定されるUIテーマではない。

## 4. `game-screens.json` とキャンバス

画面設定JSONは、初期画面、画面サイズ、スケーリング、スタイルシート、操作設定、画面別テンプレート、任意背景等を定義する。Titleの現行サンプルは1280×720を基準にしている。

- `contain`: 縦横比を保ち、全体を収める。余白が出る場合がある。
- `cover`: 縦横比を保って画面を覆う。端をcropする。要素再配置はしない。
- `stretch`: 縦横比を維持せず、両軸を別々に伸縮する。
- `vw` / `vh`: **論理基準キャンバス**の幅/高さに対する長さとして、共通ツリー生成時にpxへ正規化する。例: 1280×720で`10vw=128px`,`10vh=72px`。
- `%`: 現行のレイアウト計算では各プロパティに渡される親/利用可能寸法を基準に計算する。ただしすべてのCSS文脈を持つブラウザ互換計算ではない。

基準キャンバスはレイアウトの座標空間であり、一般WebのviewportまたはOSウィンドウをそのまま意味しない。

## 5. 画面HTML/CSSの契約

### HTML

画面は1つのルート要素で囲み、許可タグだけを使う。主なタグは `main`, `section`, `article`, `aside`, `header`, `footer`, `nav`, `div`, `span`, 見出し/段落、`button`, `input`, `img`, `ul/ol/li`, `label` 等。

各要素の内容はテキストのみ、または子要素のみで記述する。`<p>Before <strong>middle</strong> after</p>` のような混在コンテンツはBrowser/Native共通の画面compilerで拒否される。中間treeが要素内テキストと子要素を別々に保持し、DOM順序と共通レイアウトを保てないためである。子要素を使う場合は、各テキストをleaf要素へ分けて block layout として配置する。

- `<script>`、イベント属性（`onclick`等）、外部URL、未許可タグ/属性は禁止。
- `img src`はプロジェクトasset以下の相対パスに限る。絶対パスや`..`での逸脱は禁止。`img`には`alt`を必須とし、装飾画像には空の`alt=""`を指定する。
- `<button data-action="...">`で許可済み操作に接続する。
- 画面遷移には `data-action="open-screen" data-target="screen-id"` を使い、遷移先の存在をコンパイル時に検証する。
- `input[type=range]` と `input[type=checkbox]` は許可設定キーだけに結び付く。任意のDOM状態や関数は実行できない。
- セーブ/ロードカードは `data-role="save-slots"` / `load-slots` の繰返し領域として展開され、各フィールドは `data-slot-field` で選ぶ。
- 対応する保存欄の状態は `empty`, `ready`, `corrupt`, `incompatible`。状態によってロード不可となるスロットがある。
- その他のデータ駆動領域（キャラクター音量一覧など）を汎用list/repeatする機能はまだない。

### CSS

- CSS `padding` は1〜4個の値を取るshorthandを受け付け、宣言順に共通の4方向のpaddingへ展開する。shorthandと各sideに負の値は指定できない。
- 共通のwidth、height、gap、font-size、border-width、grid-auto-rows、flex-growには負の寸法を指定できない。position offsetには負の値も使える。
- Grid trackのweightはfractional spaceを配分する前に正規化する。不正値、finiteでないtrack値、geometryのfinite範囲を超える固定trackの合計は拒否する。
- 共通flex subsetでは数値の`flex`をmain axisのbasis 0として扱い、`flex-grow`は指定済みまたはintrinsicなbasisに対する追加成長として扱う。wrappingとshrinkは未対応。
- Block/flex/gridの子要素にあるpercentageは、利用可能なcontaining boxを基準に一度だけ解決する。percentage指定のpadding、font-size、border-widthはBrowser/Nativeで描画する前に共通px値へ変換し、unitlessのfont-sizeとborder-widthはpxとして扱う。
- `line-height`は共通text-paint subsetのproperty。unitless値はfont-sizeの倍率として継承し、`px`値は固定寸法として継承する。`%`値は宣言nodeのcomputed font-sizeを基準に解決してから固定寸法として継承する。範囲は0〜1,000,000で、0も有効。Browser CSSとNative SDLの行間は複数行fixtureで検証する。
- `position: relative` offsets are applied to the shared rectangle before placing descendants; left/top take precedence over right/bottom.

CSSはプロジェクトのテーマ表現に使うが、完全なCSSレイアウト/ペイントエンジンではない。現在は共通ツリーに変換できる安全なsubsetを採用する。

- セレクタ: 単純なtag/class/id、および限定された `:hover`, `:focus`, `:focus-visible`。`:focus`は入力方法を問わないfocused control、`:focus-visible`はkeyboard focusに適用し、Browser/Nativeで状態を分けて描画する。複雑な子孫/疑似要素等は共通機能として期待しない。
- Keyboard順序はscreen action、settings input、semantic buttonを対象とし、`tabindex`の正値を昇順、その後に既定値0を並べる。`tabindex="-1"`は順次focusから外す。Nativeはactionのないsemantic `<button>`もfocus状態を描画する。compiler-assigned `focusKey`でnodeを識別するため、HTML `id`の有無/重複に左右されない。任意のstatic nodeをOS accessibility targetにはしない。
- inherited paint propertyの`color`、`font-size`、`line-height`、`text-align`は、親nodeの`:hover`、`:focus`、`:focus-visible`やslot stateで変化した場合も、子nodeに同じpropertyの宣言がなければ継承する。
- 配置: absolute座標、寸法、限定的なflex/grid、gap、padding、z-index等。一般ブラウザの全レイアウト規則ではない。
- ペイント: 色、opacity、画像、object-fit、基本border、text-align等。
- `border` shorthandはborder width、style、colorとして解析する。widthのunitは共通px値へ変換し、Browser/Nativeで描画する前に対応するstyleとcolorを検証する。`--name`や`var()`などのCSS custom propertyは未対応。
- 非対応または共通でない表現: transform、transition、shadow、clip、advanced font、複雑なselector、一般的なmargin/min-max/wrapping等。未対応宣言はコンパイル時拒否の対象。
- 「parserの許可リストにある」ことだけではBrowser/Native共通実装を意味しない。最終契約は互換性表と両描画器のテスト。

## 6. 操作、状態、UI設定

### 安全な画面アクション

現行のaction語彙は、開始/継続/再開、次/auto/skip/hold、save/load、quick save/load、slot操作、画面遷移、setting-value、shortcut-cycle、reset、back、quit等に限定される。任意のコマンド実行やユーザー定義イベントハンドラは提供しない。

HTML上のボタンが見えるだけでは操作可能性を保証しない。各要素に実アクションが接続され、キーボード・マウス双方で動作することをテストする必要がある。

### `ui-controls.txt`

このファイルはゲーム設定初期値とscreen templateに公開するキーを列挙する。設定変更はplayer-local preferenceとして保存され、TDSの物語変数や番号付きセーブとは独立している。

主な設定キー:

| キー群 | 種類/役割 |
|---|---|
| `audio.master`, `audio.bgm`, `audio.se`, `audio.voice` | 0..1の音量値 |
| `audio.*Muted` | mute用boolean |
| `audio.voice.<character>` と `.muted` | 許可されたキャラクター単位のvoice設定 |
| `ui.dialogOpacity` | 会話欄透明度 |
| `ui.autoSpeed`, `ui.textSpeed` | オート進行/文字表示速度 |
| `ui.skipUnseen`, `ui.autoAfterChoice`, `ui.skipAfterChoice` | 再生動作boolean |
| `ui.fullscreen`, `ui.effects`, `ui.cursorHideDelay` | 表示・操作設定 |
| `ui.fontFamily` | `default`, `gothic`, `mincho`の列挙値 |
| `ui.shortcut.F1`〜`F12` | 安全な既知プレイヤー操作への割当て |

範囲は型と許容値を検査し、booleanをrangeに結び付ける等の誤配線を拒否する。Range/checkboxはBrowser/Native共通の意味を持つ。音量・速度等のスライダーskinは画像置換に対応するが、一般の任意UIスクリプトではない。

## 7. 共通コントロールと画像素材

### 現行コントロール

- Button: textまたは画像を使用可能。HTML/CSSの画像やhover styleを利用する。
- Range: 0..1の正規化値。横/縦、track/fill/thumb画像skin、hover thumbに対応。
- Checkbox: on/off画像skinおよびhover状態に対応。
- Save slot: スロットデータをフィールド単位で表示し、slot status/selectedを反映。
- Shortcut: F1-F12に対し許可actionをcycleする操作。
- Tabs/menus等: 意味付き専用widgetとは限らず、HTML buttonとactionで組む。

現在未提供/限定的な素材機能: 9-slice、atlas crop、disabled専用skin、完全なpressed/focus/selected artwork、任意のSVG/animation、CSS transition、汎用マスク/clip。Range/checkbox以外の任意コントロールskin DSLも未整備。

### 素材配置

Titleサンプルでは `Title/asset/ui/` 以下に背景、ボタン、コントロール、アイコン、ロゴ、装飾、パネル、ポートレート等を分類している。作品の見た目を画像で作れることは重要だが、文字を画像へ焼くと翻訳・拡大・状態切替が難しくなるため、文言と意味のあるラベルは原則テキストとして保持する。

ボタン全面を一枚絵にする場合でも、透明余白を含む画像寸法、実ヒット領域、hover/focus資産、読み上げラベル、縮小時の画質を揃える必要がある。装飾画像の透明部分へ矩形背景/枠が付かないこともBrowser/Native双方で確認する。

## 8. タイトル、設定、セーブ画面の設計

### Title/Home

TDS entryは`start_file`で選び、entry実行中の`start()`が呼ばれた位置で`game-screens.json`の`initial`画面を開く。画面の開始操作後は同じTDS実行の次の命令へ戻る。起動時の自動表示や別title scene設定は使わない。Continueが使えない時は無効状態/非表示等の視覚反応を実アクションと揃える。背景美術と文字メニューを分離するとローカライズしやすい一方、hover/focus/selected演出、BGM開始、遷移演出の設計が要る。実行契約は[Startup flow](startup-flow.md)を参照。

### SYSTEM/SOUND

設定UIは説明、現在値、選択状態、変更結果、保存先を一貫して示す。SYSTEMの `Mouse Controls` 欄は右クリック割当がこの画面では利用できないことを伝える案内だけを表示し、割当操作は提供しない。

サウンドページは共通チャンネル設定を意味付きrange/checkboxで操作する。Titleのキャラクター個別音量欄はサンプル人数分をHTMLへ手書きする構造であり、キャラクター集合を動的に列挙する汎用list componentではない。登場人物が増えた場合、件数、スクロール、検索、portrait欠損、長い名前、保存キーの一貫性を別途設計する必要がある。

### Save/Load

- Browserの番号付きセーブとNativeのセーブは各playerの保存領域に置く。UI設定は番号付きslotと独立。
- Save/Load templateはdata-roleからスロットカードを展開し、thumbnail、番号、状態、scene、speaker、本文、時刻等を埋め込む。
- ページ切替、保存/読込、quick save/load、copy/move/delete/lock等の操作は、それぞれ適切なslot stateで有効/無効を決める。
- 壊れた/非互換データは明示し、ロード不能とする。サムネイル欠損だけでセーブ本体を無効化しない。
- Browserのサムネイルはストーリー表示をCanvas合成し、NativeはSDLの描画済みstory frameを保存する。含まれる要素は揃える設計だが、CSS独自表現やフォントで差が残る可能性がある。実画面の一致は別途比較する。
- 保存操作には確認、上書き、コピー/移動先の競合、空slot、破損slotなどを含む状態遷移テストが必要。

## 9. プレイ中のUIレイヤーとTDS演出

UIレイヤーと物語演出は区別する。基本画面の固定描画層をプレイヤーが用意し、背景揺れ/移動/ズーム等の時間変化はTDS命令から操作する。

現行の基本的なstory stack:

```text
background → video → characters → images → dialogue → player controls
```

（UIの画面overlayは、pause/system/save等を開いたときにstory画面へ重ねる。）

現行命令群には背景切替/フェードやwipe、background/characterのmove、カメラzoom/reset、dialogueのvisible切替、動画のopacity/async/blocking、`--only`による対象以外の表示抑制等がある。例:

```tds
bg room wipe-left 600
move bg by x+5 y-2 over 300
move character hero by x+12 y+8 over 500
camera zoom 1.25 at 640 360 over 800
dialog visible false
play video op async opacity 0.5
```

命令の正確な構文とasset要件はParser/Type checkerが定める。上記は機能群を示す例であり、個別の引数順・対象制限は構文リファレンスと`test/player-visual-only.browser.cjs`、`test/native-smoke.cjs`を参照する。

### `--only` / Visual-only

限定表示中は非対象の描画だけでなく、後続物語の進行・入力・音声が裏で進まないことが重要。video-only等のテストではレイヤーvisibility、状態遷移、cleanup後の復帰を確認する。視覚非表示とruntime停止を混同しない。

### 演出の設計上限

現状は固定スタックと個別命令が中心。任意数の背景/動画を作者が自由に順序変更するレイヤーシステム、汎用タイムライン、任意easing、複数対象の一括同期、mask/clip、モーション中の割込み/合成を包括的に提供するものではない。演出APIを増やす際は一命令ずつ特殊処理を足すのでなく、対象・時間・補間・合成・キャンセルを共通モデルにする。

## 10. エディタでの編集体験

- Editorの画面設定UIはHTML/CSSを読み、screenを選択し、scale mode/preview ratioを変えてプレビューできる。
- テンプレートを持つscreenではHTML/CSSが正本となり、現行UIではLegacy JSON itemのボタン追加/ドラッグ位置調整を停止する。HTML/CSSファイルへのsource linkからCode Editorで編集する。
- そのため「自由記述へ移ると直接操作編集を失う」というワークフローの断絶がある。画面上の要素選択、ドラッグ/リサイズ、整列、z-order、数値インスペクタとHTML/CSSを同じ文書モデルで同期させるのが望ましい。
- プレビュー領域が非表示/0×0の時は描画を保留し、可視化後のResizeObserver再描画で寸法を得る。0×0を例外としてページへ漏らしてはならない。
- エディタプレビューとBrowser/Native本体のUI状態・データ差し込み・アクション動作は同じ契約を使うべき。プレビュー専用ダミーデータが実画面の操作可能性を偽らないようにする。

## 11. 見た目品質・アクセシビリティ基準

各画面について次の軸を受入条件として確認する。

1. **構図**: 安全領域、余白、整列、画面端、階層、文字と背景のコントラスト。
2. **状態**: normal/hover/focus/focus-visible/selected/disabled/pressed/loading/error。現行実装で表現できない状態は、UIに出す前に仕様化する。
3. **入力**: マウス、キーボードtab/矢印/Enter/Escape、コントローラー対応の有無。視覚focusと実focusが一致すること。
4. **文字**: 最小サイズ、折返し、長い日本語/英語、フォントfallback、文字拡大、読み上げラベル。
5. **解像度**: 16:9基準に加え、窓の小型化、超横長/縦長、DPI変更、contain余白、cover crop。
6. **データ状態**: empty/ready/corrupt/incompatible、slot page上限、長文、欠損画像、未使用音声キー。
7. **移植**: Editor preview、Browser player、SDL Nativeで意味/操作一致。ピクセル差が許容される箇所と一致必須箇所を分ける。
8. **演出中**: 遷移中入力、停止/skip、画面を閉じた後の状態、動画終了/失敗、音声停止、z-order。

色だけで状態を区別しない。画像に焼いた文字を必須情報にしない。操作可能な見た目を持つものは、実操作・disabled状態・ラベルを必ず持つ。

## 12. 現在の主要課題

### 既知の実装/デザイン制約

- 固定基準キャンバスと多数のabsolute座標に依存し、縮小・長文・ローカライズに弱い。`cover`はreflowしない。
- 共通CSSは一般ブラウザCSSではない。親制約、flex/grid、margin/min-max/wrapping等に制約がある。
- テンプレートの直接配置/ドラッグ編集がなく、ソース編集と視覚編集が分かれている。
- SYSTEMの右クリック割当は未対応で、画面には利用できない旨を表示する。設定操作としては提供していない。
- キャラクター音量UIは作品のキャラクター一覧から自動生成されない。
- 部品/状態セットが薄い。Generic repeat/list、scroll container、radio/select/key capture、modal等は汎用意味付きコントロールとして不足。
- Range/checkbox以外の広範な画像skin、9-slice、atlas、disabled/focus/pressed状態、animation、transform/shadow/clip等が制限される。
- BrowserとNativeでフォント/標準widget/DPIが違い、pixel-identical renderingを保証しない。
- BrowserとNativeのセーブサムネイル生成経路が異なり、特殊なCSS描画を完全一致させない場合がある。
- CSS診断はscreen ID、HTML/CSSファイルパス、selector、CSSルール先頭の行・列、問題のpropertyを示す。宣言内の細かな列位置はまだ報告しない。

### 構造的なリスク

- HTML/CSS、JSON、初期設定キー、Browser action handler、Native action handlerの対応が別箇所に分散すると、見た目だけのコントロールや片側だけ動く操作が生じる。
- 表示コードだけの変更がNativeで確認されないと、出荷版で位置/フォント/当たり判定が異なる。
- 個々の画面に対する例外CSS/if分岐を積むと、テーマ/作品ごとの保守負荷が増大する。
- 保存形式変更は、旧スロットの互換性、quick slot、settings preference migrationに影響する。

## 13. 推奨する発展方針

これは今後の設計提案であり、すべて実装済みという意味ではない。

### A. UIスキーマを共通契約にする

Controlごとに`type`, `value source`, `action`, `states`, `layout`, `accessibility label`, `asset skin`, `keyboard behavior`を一つの検証可能な定義から生成する。Browser/Native/Editorの三者が同じ意味モデルを使う。画面作者に自由なJSを許さず、許可された宣言UIの組合せで拡張性を上げる。

### B. ソースと視覚編集の同一モデル化

HTML/CSSまたはその安全なASTを正本にして、canvas上の選択・移動・resize・整列・inspectをそのASTへ反映する。逆にソース編集はcanvas選択位置へ即反映。Legacy itemsとtemplateを二重正本にしない。

### C. 制約レイアウト

absolute座標を残しつつ、anchor、親edge、padding/gap、min/max、scroll region、wrap、breakpoint、safe areaを追加する。既存ゲームの固定構図を壊さず、窓サイズ/文字量で崩れる箇所だけadaptive layoutにできるようにする。

### D. 再利用可能な意味付き部品

最初にButton、Toggle、Range、Tabs、ScrollList、SlotCard、KeyBinding、VolumeChannel、Modal/Confirmを揃える。状態・操作・フォーカス・選択・保存値を共通実装し、テーマで外観を差し替える。CharacterVolume等は一般的なdata repeatで生成し、人数をHTMLに固定しない。

### E. デザインtokens/theme

色、文字、space scale、ボタン高、角/線、透明度、focus色、パネルsurfaceをtheme tokensとして宣言する。作品ごとに統一変更でき、個別CSSのAI風色/サイズの混入や画面間の揺れを減らす。

### F. 統一した視覚回帰

各screen/各状態について、基準OS/解像度のNative screenshotとBrowser screenshotを保存・比較する。許容差、DPI、フォント、transparent asset、長文、入力当たり判定を明示する。behaviorテストとpixel/layout testを分ける。

## 14. テストマトリクス

現行の主要テスト入口:

| 範囲 | コマンド/ファイル | 確認すること |
|---|---|---|
| TypeScript build + 全unit | `npm.cmd test` | parser/checker/runtime/settings/compiler等 |
| HTML/CSS共通ツリー | `node --test test/game-screen-document.test.js` | HTML安全性、layout、actions、setting bindings、skin、vw/vh |
| Browser画面 | `node test/game-screens.browser.cjs` | template編集、preview、actions、save slot、legacy fallback |
| Browser controls | `node test/ui-controls.browser.cjs` | image range/toggle、pointer interaction、persistence |
| Native screens | `node test/game-screens-native.cjs` | SDL captures、audio controls、persistence、shortcut |
| Browser/Native screen paint order | `node test/screen-focus-visual.browser.cjs` | Overlapping siblings retain authored focus order while z-index controls painted pixels in Edge and SDL |
| Story visual/effects | `node test/player-visual-only.browser.cjs` | video-only、opacity、camera、dialog visibility/layer cleanup |
| Native runtime/media | `node test/native-smoke.cjs` | media blocking/async、BGM crossfade、effects、debug-start parity |
| Editor autocomplete/diagnostics | `node test/editor-analysis-check.cjs` | grammar-aware completion、diagnostics、syntax highlight、tooltips |
| Editor typing | `node test/editor-typing.browser.cjs` | caret/selection, indentation, undo, setting file editing |
| Symbol context menu | `node test/editor-symbol-tooltip.browser.cjs` | help, definition jump, F12, menu clamping |
| Syntax reference | `node test/language-reference.browser.cjs` | in-place search, chapter, no navigation |
| Full editor/player flow | `node test/full-workflow-e2e.cjs` | open/edit/save/compile/play/diagnostics/restart |

テストは実行時の保証範囲を超えて主張しない。Browser headless合格は実機Native visual acceptanceの代替ではない。Native dummy SDLの操作試験も、Windowsの通常ウィンドウ/DPI/IMEでの完全な見た目確認とは別である。

## 15. 関連ドキュメント

- [画面再現デザイン監査](game-ui-recreation-audit.md) — 参考画像との再現差、重大度、改善優先順。
- [画面HTML/CSSの作成方法](../Title/setting/screens/README.md) — template/action/slotの実用例。
- [Browser/Native互換表](../Title/setting/screens/RENDERING-COMPATIBILITY.md) — 描画可能範囲と禁止CSS。
- [共有コントロール](../Title/setting/screens/CONTROLS.md) — setting keys、range/toggle skin。
- [UI素材調査](ui-assets-research.md) — skin素材の要件と限界。
- [エディタ/プロジェクト全体仕様](editor-project-overview.md) — Editor、Compiler、Player、保存方式を含む総覧。


### Border, padding, and nested screen elements

The shared screen compiler stores each node rectangle as its painted outer box. Child rectangles begin inside the parent's border and padding; Browser DOM mounting subtracts the parent's border from the child-local coordinate because absolute positioning is relative to the parent's padding box. This keeps the DOM's containing-block origin aligned with the shared geometry and Native SDL rectangles.
