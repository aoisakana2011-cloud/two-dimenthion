# ネイティブプレイヤー

ネイティブプレイヤーはエディターから分離されています。入力として、
検証済みの `.nsp.json` パッケージを使用します。

```powershell
npm.cmd run pack -- Edit/scenes/main.novel build/main.nsp.json
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
cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=N:/native/.vcpkg/scripts/buildsystems/vcpkg.cmake -DVCPKG_TARGET_TRIPLET=x64-windows
cmake --build build --config Release
```
