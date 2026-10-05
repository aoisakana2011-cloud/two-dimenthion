# UI画像素材の調査・生成検討

## 調査した既存UIの設計

- [Ren'Py GUI customization guide](https://www.renpy.org/doc/html/gui.html) は、メインメニュー背景、ゲームメニュー背景、ボタン状態別背景に加え、水平スライダーのidle/hover画像を別素材として扱っています。つまり画像差し替えだけでなく、操作状態・伸縮領域・ノブをエンジン側の部品モデルと結び付けています。
- [NITRO PLUS『Dolls Nest』公式オンラインマニュアル](https://support.nitroplus.co.jp/manual/nitroplus/Dolls_Nest/en/basic-info) は、Master、Voice、BGM、環境音、SE、Systemを個別音量項目として説明しています。音源を役割別に分けるのは市販ゲームでも一般的な選択肢です。
- [Action-based UI customization guide](https://steamcommunity.com/sharedfiles/filedetails/?id=1331463993) は、画像ベースの画面でidle/hover用画像とクリック領域を合わせて管理し、スライダー画像と操作領域の両方を調整する必要を説明しています。画像だけを取り替えても操作範囲が自動では追従しない、という注意点の例です。

## この作品向けに生成した案

`Title/asset/ui/controls/audio/volume/volume-controls-concept-v1.png` に、春の恋愛ノベルに合わせたアイボリー・くすみローズ・スレートブルー・細い金縁の音量バー、つまみ、ミュート、チェックボックスをまとめた透明PNG案を置きました。既存作品のロゴ・画面・固有素材をコピーせず、画像式UIの構成要素だけを参考にした新規生成物です。

生成指示の要点：

> Visual-novel sound settings sprite sheet; isolated horizontal empty/progress rails, round thumb, speaker/mute icons and checkbox states; warm ivory, muted rose, slate blue and restrained antique-gold trim; transparent background; no text, logos, or named-game artwork.

これは**デザイン検討用**です。全パーツが一枚のシートに入っており、独立画像へ切り出されていません。また、透明境界に色付きハローが残っています。現在のゲーム画面には適用しておらず、実用素材として出荷すべき状態ではありません。

## 現行エンジンで確認できた制限

1. 画面HTMLは制限付きの共通UIツリーへ変換されます。任意JavaScriptや任意イベント処理を含む一般的なWebページではありません。
2. 音量入力は許可済みキーに結び付いた `input type="range"` です。Browser/Native共通の `controlSkins` を追加し、track/fill/thumb画像、hover thumb、checkboxのon/off/hover画像を割り当てられるようになりました。
3. Browserは意味上のinputと描画画像を分離したDOM部品を使い、Nativeは同じUIツリーとスキン定義からSDL画像を描画します。クリック位置・値域・設定保存は従来の入力モデルを維持します。パッケージャーはスキン画像を自動同梱します。
4. 横・縦rangeとcheckboxに対応します。画像の伸縮方式は単純なstretchで、9-slice、atlas切り出し、skin専用disabled画像は未対応です。
5. 画像に「BGM」「声」などの文字を焼き込むと、翻訳・フォント変更・アクセシビリティ・値の読み上げ・動的状態表示が難しくなります。今回の案ではラベルを画像に含めず、テキストをHTML側に残す設計を推奨します。
6. 生成画像はシート分割・透明縁・縮小時の判読性を人が検品する必要があります。今回の試作には色ハローが残るため、そのままUIに使えません。

## 残っている拡張点

- 現在のレールはstretch方式です。可変幅で角や線幅を保つ9-slice/左右端＋中央反復は未対応です。
- keyboard focusはhover用画像を共有します。focus専用・disabled用素材の個別指定は未対応です。
- Browser画面のスクリーンショットとポインター／キーボード操作、Nativeのパッケージ・描画・保存スモークは確認済みです。異なるDPIのNative実ウィンドウでの目視確認は今後の確認項目です。

## 判定

画像式のrange/checkbox部品とBrowser/Native共通経路、パッケージ同梱、入力値の実操作テストまで実装済みです。Title作品の音量・会話欄スライダーと消音チェックには、生成シートを使わず、透過SVG原稿から作ったPNGスキンを適用しました。次の拡張境界は9-sliceとフォーカス/無効状態です。
