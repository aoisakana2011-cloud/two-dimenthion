# engine_data

ネイティブプレイヤーの表示設定を保存するフォルダーです。
シナリオや素材とは分離して管理します。

- `engine.txt`：ウィンドウ、フォント、セリフ欄の位置・サイズ・色
- `fonts/`：プロジェクト専用フォントを置く場所
- `ui/`：UI画像やスキンを置く場所

文字欄の画像パスは `engine.txt` の次の項目です。

```text
dialog.background_image = ui/dialogue_box.png
```

実ファイルは `native/engine_data/ui/dialogue_box.png` に配置します。

`font.path` にはWindowsのシステムフォント、またはこのフォルダーからの
相対パスを指定できます。

配置は `engine.txt` を直接編集します。`dialog.text_color` と
`dialog.background_color` は `R,G,B,A`（各0〜255）で指定します。
`font.size` は基本サイズで、`dialog.speaker_size`・`dialog.text_size` を
指定した場合は、それぞれのサイズを優先します。
