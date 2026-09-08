# ネイティブプレイヤー

ネイティブプレイヤーはエディターから分離されています。入力として、
検証済みの `.nsp.json` パッケージを使用します。

```powershell
npm.cmd run pack -- Title/senario/main.tds build/main.nsp.json
```

使用する主なライブラリ：

- SDL3：ウィンドウ、入力、タイミング、描画
- SDL_ttf / FreeType：セリフとUIの文字
- SDL_image：背景、立ち絵、画像オーバーレイ
- SDL3_mixer：BGM、SE、ボイス
- FFmpeg：動画のデコードと音声・映像連携

ネイティブランタイムはパッケージとアセットだけを読み込みます。
編集用のシナリオソースを直接解析・実行しません。

## ビルド

```powershell
# プロジェクトのルートで実行
$toolchain = (Resolve-Path native/.vcpkg/scripts/buildsystems/vcpkg.cmake).Path
cmake -S native -B native/build-local "-DCMAKE_TOOLCHAIN_FILE=$toolchain" -DVCPKG_TARGET_TRIPLET=x64-windows
cmake --build native/build-local --config Release
npm.cmd run native
```

別のパッケージを起動する場合は、パスを指定します。

```powershell
npm.cmd run native -- build/other.nsp.json
```

画像のPNG・JPEG・WebP、音声のFLAC・Vorbis・MP3対応は
`vcpkg.json` の明示的なfeaturesで有効にしています。
古いビルドのDLLを新しい実行ファイルと混在させないでください。

パッケージには遷移先ファイルのコンパイル結果も含まれます。
素材はパッケージ横の `asset/` へコピーされます。
整数は実行中も64bitで保持し、JSONで安全に表せない整数は
`{"kind":"integer","value":"9007199254740993"}` の形式で渡します。
既存パッケージは変更後の `npm.cmd run pack` で作り直してください。

`--headless` は画面を開かず制御処理を実行し、変数と命令をJSON出力します。
`--smoke` はSDLの描画・音声・動画も実行し、会話と選択肢を自動で進めます。
通常のプレイでは、会話はクリックかキー入力、選択肢はクリックで進みます。
