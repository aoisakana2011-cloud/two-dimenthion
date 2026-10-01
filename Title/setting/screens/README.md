# 画面UIの作り方

タイトル、ポーズ、セーブ／ロード、システムなどは `setting/game-screens.json` から画面ごとのHTMLと共通CSSを参照します。シナリオ本文や会話欄は `player-ui.json` とTDSの担当です。

```json
{
  "version": 1,
  "initial": "title",
  "saveId": "my-story",
  "stylesheet": "screens/shared.css",
  "controlSettings": "screens/ui-controls.txt",
  "screens": {
    "title": { "background": "bg/title.png", "template": "screens/title.html" },
    "save": { "template": "screens/save.html", "role": "save-slots" },
    "load": { "template": "screens/load.html", "role": "load-slots" }
  }
}
```

`saveId` は作品ごとに固有にしてください。変更すると以前の保存先とは別の領域になります。BrowserはIndexedDB、Windows NativeはOSのユーザーデータ領域に保存します。旧版の保存データは初回起動時にコピーして移行します。Browserのデバッグ再生と通常再生のデータは分離されます。

HTMLは画面の内容と操作、CSSは位置・色・画像・hoverなどの見た目を定義します。JSONの `background` は画面全体の背景です。同じ見た目をJSONとCSSの両方に書かないでください。テンプレート画面ではHTML/CSSが正本で、ビルド時にNative用の操作項目とSDLフォールバック配置が生成されます。ブラウザ再生とエディタのプレビューはブラウザのレイアウト、Windows NativeはWebView2で表示します。WebView2が使えない環境ではSDLフォールバックを使いますが、高度なCSSの見た目は一致しません。

```html
<main class="title-screen">
  <nav class="title-menu">
    <button data-action="start">はじめから</button>
    <button data-action="continue">続きから</button>
    <button data-action="load">記録から再開</button>
    <button data-action="open-screen" data-target="system">環境設定</button>
  </nav>
</main>
```

使用できる操作は `start`、`continue`、`resume`、`save`、`load`、`open-screen`、`back`、`quit`。`continue` はロード可能な最新セーブがない場合は無効です。画面間移動は `data-target` に画面IDを指定します。ボタン画像はCSSの `background-image:url("asset/ui/button.png")` を使い、`:hover` で画像や色を変えられます。HTMLの `img src` も作品の `asset/` 以下だけを参照できます。

セーブ枠はひな形のボタンを1個だけ書きます。エンジンが `data-count` 個に複製し、クリック時の保存／読込を割り当てます。

```html
<div class="save-slot-grid" data-role="save-slots" data-count="12">
  <button class="save-slot">
    <img data-slot-field="thumbnail" alt="">
    <span data-slot-field="number"></span>
    <span data-slot-field="scene"></span>
    <span data-slot-field="text"></span>
    <span data-slot-field="saved-at"></span>
  </button>
</div>
```

`data-role="load-slots"` に変えればロード枠になります。フィールドは `thumbnail`、`number`、`status`、`scene`、`speaker`、`text`、`saved-at`。カードの `data-state` は `empty` / `ready` / `corrupt` / `incompatible` になり、破損データや別作品のデータはロード不可として区別します。サムネイルは保存時の背景・立ち絵などから生成します。保存データ本体、枠メタデータ、サムネイルはBrowserでは同一IndexedDBトランザクションで更新します。Nativeでは別ファイルです。

設定操作は `ui-controls.txt` に初期値と許可キーを宣言し、HTMLで `input type="range"` または `type="checkbox"` と `data-setting` を使います。音量・ミュート・会話欄透明度の対応キーは [CONTROLS.md](CONTROLS.md) を参照してください。

CSSはflex/grid、画像、グラデーション、角丸、影、transform、transition、疑似クラス、子孫セレクターなどを使えます。固定キャンバスを再生画面へ拡大縮小するため、各画面の基準寸法は共通UI設定から取得します。`@media`、外部URL、JavaScript、インラインイベント属性は許可しません。未知のCSS宣言はビルド時にエラーにして、Browserだけで表示される差異を防ぎます。素材URLは `asset/` から始まる相対パスにしてください。
