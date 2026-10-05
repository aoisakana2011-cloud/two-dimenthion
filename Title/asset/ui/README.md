# UI画像素材

## Generated title and settings artwork

- `backgrounds/spring-ensemble-key-visual.jpg`: original image-generated spring school romance ensemble artwork used as the title/settings/save/load background. No existing game characters, title lettering, or logos are embedded; menu text remains editable HTML/CSS.
- `portraits/ayaka-volume.png`: original transparent bust portrait used in the sound configuration panel.
- `portraits/sister-volume.png`: generated from the existing sister character reference as a matching transparent, upper-body anime portrait for her sound configuration card.
- `buttons/sakura-menu-plate.png`: image-generated pearl-and-sakura button face used behind independently rendered title-menu labels in both Browser and Native playback.
- `buttons/sakura-menu-plate-hover.png`: generated, transparent selected-state counterpart. Its brighter ivory/pink highlight is activated by `:hover` and `:focus-visible` without introducing a rectangular CSS backing.
- `buttons/sakura-menu-plate-hover-v2.png`: generated stronger hover-light variant; its rose/champagne glow is distinguishable at native playback size and used by the current title stylesheet.
- `logos/spring-late-love-title.png`: first generated transparent Japanese title wordmark (retained as the untrimmed source variant).
- `logos/spring-late-love-title-v2.png`: cleaned transparent Japanese title wordmark used in the title screen; isolated alpha bounds prevent faint fringe pixels from appearing as stray Native renderer marks. The title remains accessible through its HTML alt text.
- `icons/{save,load,system,sound,favorite,tips}.png`: six individually generated, alpha-transparent navigation icons shared by the save/load/system/sound headers. The source images were downscaled to 128×128 PNG for compact packaging.
- `icons/menu-{back,next,auto,skip,log,close,hold}.png`: individually generated, alpha-transparent pause-menu operation icons. Existing save/load/system/favorite/tips assets are reused in the menu so corresponding actions keep the same visual identity.

画面設定（`setting/screens/*.html` / `*.css`）や再生画面UIで使う画像を、用途別にここへ置きます。既存の `asset/ui/*.png` はそのまま利用できます。新しい画像は次の分類を目安にしてください。

```text
asset/ui/
├─ backgrounds/       タイトル・メニュー・設定画面の背景
├─ buttons/           通常／選択中／押下中のボタン画像
├─ panels/            会話欄、名前欄、カード、枠
├─ controls/
│  └─ audio/
│     └─ volume/      音量バーのレール・塗り・つまみ等の素材
├─ icons/             セーブ、ロード、音量などの小さなアイコン
└─ ornaments/         飾り罫、コーナー、汎用の装飾
```

素材参照は作品ルートからの相対パスです。例：

```html
<img src="asset/ui/icons/sound.png" alt="音量">
```

```css
.title-button { background-image: url("asset/ui/buttons/start.png"); }
.title-button:hover { background-image: url("asset/ui/buttons/start-hover.png"); }
```

透過が必要な部品にはPNGを使い、通常／hover画像は同じ寸法で作ると切り替え時にずれません。画像は画面テンプレートや `player-ui.json` から参照できます。

## 音量バー素材について

`controls/audio/volume/` は音量バーのデザイン素材をまとめる置き場です。`game-screens.json` の `controlSkins` に部品画像を登録し、画面HTMLの入力に `data-skin="ID"` を付けると、Browser/Native共通の画像スキンを適用できます。詳細は [`setting/screens/CONTROLS.md`](../../setting/screens/CONTROLS.md) を参照してください。スキンは入力の見た目だけを置き換え、設定値・保存・キーボード操作は従来の共通コントロールを使います。

現状は横・縦rangeとcheckboxに対応し、画像は部品の描画領域へ伸縮されます。9-slice、atlas切り出し、disabled状態は未対応です。レール両端でつまみがはみ出さないよう `inset` を指定してください。

`*.svg` が編集用のベクター原稿で、対応するPNGが実行用の透過素材です。通常・hoverのつまみと消音チェックも別画像にしています。変更後は `node tools/render-ui-control-skins.cjs` でPNGを再生成します。`volume-controls-concept-v1.png` は生成した検討シートで、未分割・色ハローがあるためゲーム内では使っていません。画像は外部URLではなく `asset/` 以下を参照します。
