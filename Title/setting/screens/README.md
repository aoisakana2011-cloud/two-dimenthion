# 画面UIの作り方

タイトル、ポーズ、セーブ／ロード、システムなどは `setting/game-screens.json` から画面ごとのHTMLと共通CSSを参照します。サンプル作品では音量・ミュート・会話欄不透明度を独立ページへ遷移させず、環境設定画面内にまとめています。シナリオ本文や会話欄は `player-ui.json` とTDSの担当です。

```json
{
  "version": 1,
  "initial": "title",
  "saveId": "my-story",
  "stylesheet": "screens/shared.css",
  "controlSettings": "screens/ui-controls.txt",
  "defaultBackground": "bg/title.png",
  "screens": {
    "title": { "template": "screens/title.html" },
    "save": { "template": "screens/save.html", "role": "save-slots" },
    "load": { "template": "screens/load.html", "role": "load-slots" }
  }
}
```

`defaultBackground` は `background` を省略した画面に適用されます。画面ごとに別の素材を指定すれば上書きでき、空文字列ならその画面だけ背景を表示しません。同じ素材パスを画面ごとに複製せず、共通値として管理してください。

`saveId` は作品ごとに固有にしてください。変更すると以前の保存先とは別の領域になります。BrowserはIndexedDB、Windows NativeはOSのユーザーデータ領域に保存します。旧版の保存データは初回起動時にコピーして移行します。Browserのデバッグ再生と通常再生のデータは分離されます。

HTMLは画面の内容と操作、CSSは位置・色・画像・hoverなどの見た目を定義します。JSONの `background` は画面全体の背景です。同じ見た目をJSONとCSSの両方に書かないでください。テンプレート画面ではHTML/CSSが正本で、共通ツリーに変換してBrowser再生とSDL Native再生の両方で使います。両方で同じ結果にならないCSSプロパティや複雑なセレクターはコンパイル時にエラーになります。詳細は[描画互換性](RENDERING-COMPATIBILITY.md)を参照してください。

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

使用できる操作は `start`、`continue`、`resume`、`next`、`auto`、`skip`、`hold`、`save`、`load`、`quick-save`、`quick-load`、`open-screen`、`setting-value`、`shortcut-cycle`、`reset-settings`、`reset-window-size`、`back`、`quit` とセーブ枠操作です。`shortcut-cycle` は `data-target="F1"`〜`"F12"` を指定し、許可されたプレイヤー操作を順番に切り替えます。`continue` はロード可能な最新セーブがない場合は無効です。画面間移動は `data-target` に画面IDを指定します。`reset-window-size` は全画面を解除し、作品の基準画面寸法へ戻します。Browserはホストが許可するときだけウィンドウサイズを変更できます。ボタン画像はCSSの `background-image:url("asset/ui/button.png")` またはHTMLの `img src` で指定し、`:hover` で見た目を変えられます。参照素材は作品の `asset/` 以下だけに限定されます。

設定値は `setting-value` ボタンを使います。boolean設定は `data-value="true"` / `"false"`、フォント設定 `ui.fontFamily` は `default` / `gothic` / `mincho` の固定選択肢を指定します。許可済みの値だけがプレイヤー設定として保存され、選択中表示もBrowser/Nativeで同期します。任意の設定キーや任意コードは実行できません。

```html
<button data-action="setting-value" data-target="ui.effects" data-value="true">あり</button>
<button data-action="setting-value" data-target="ui.effects" data-value="false">なし</button>
```

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

`data-role="load-slots"` に変えればロード枠になります。フィールドは `thumbnail`、`number`、`status`、`scene`、`speaker`、`text`、`saved-at`。空き枠や不正なセーブはロード不可です。Browser／Native共に`status`を`空き` / `記録あり` / `破損` / `非対応`に分類し、カード要素に `data-state="empty|ready|corrupt|incompatible"` を設定します。カードのルート要素には `.save-slot[data-state="corrupt"] { ... }` のような状態別CSSを指定できます。状態セレクターはセーブ枠カードのルート専用で、子要素には指定できません。操作できない枠もカード全体は透過させず、サムネイルや記録情報を読みやすく保ちます。

作品の設定に `slotPages` を指定し、HTMLに0〜9の `data-action="slot-page"` ボタンを配置するとページを切り替えられます。標準の12枠テンプレートでは10ページ、最大120件を利用できます。

`thumbnail` は保存時の物語画面から作る画像です。現在のキャプチャ対象は背景・立ち絵・追加画像で、セーブ／ロード画面そのものは写り込みません（会話欄・選択肢・文字も含む完全な画面キャプチャではありません）。HTMLテンプレートに `<img data-slot-field="thumbnail" alt="">` を置くと、各カードに対応する保存画像が表示されます。CSSで大きさと `object-fit` を指定できます。空き枠や画像のない旧セーブでは画像欄は空になります。

Browserでは画像をBlobとして保存し、セーブ本体・一覧metadata・サムネイルを同一IndexedDBトランザクションで更新します（IndexedDBが使えない場合のlocalStorage fallbackには画像保存がありません）。Nativeではセーブ先ディレクトリの `slot-N.json` と `thumb-slot-N.png` に分けて保存します。通常のWindows版ではSDLのユーザーデータ領域が使われ、`NOVEL_SAVE_ROOT` が指定されていればその保存先が優先されます。Nativeも対応するサムネイルが欠損・破損していてもセーブ本体をロードできます。

設定操作は `ui-controls.txt` に初期値と許可キーを宣言し、HTMLで `input type="range"` または `type="checkbox"` と `data-setting` を使います。SYSTEM画面では `ui.shortcut.F1`〜`ui.shortcut.F12` の割り当てもボタンで変更できます。音量・ミュート・会話欄透明度・ショートカットの対応値は [CONTROLS.md](CONTROLS.md) を参照してください。画面用画像の用途別フォルダーと、音量バー用素材の現状は [UI画像素材](../../asset/ui/README.md) を参照してください。

共通CSSでは固定キャンバス上の配置、限定的なflex/grid、色・透過、素材画像、基本的な枠線、文字揃え、単純なタグ/class/idセレクターとhover/focusを使えます。グラデーション、角丸、影、transform、transition、複雑なセレクターなど、BrowserとNativeで一致しない指定は保存・パッケージ前のコンパイルでエラーになります。`@media`、外部URL、JavaScript、インラインイベント属性も許可しません。画面の基準寸法と比率適応は共通UI設定および`game-screens.json`で管理します。素材URLは `asset/` から始まる相対パスにしてください。対応範囲は[描画互換性](RENDERING-COMPATIBILITY.md)を参照してください。
