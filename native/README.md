# ネイティブプレイヤー

ネイティブプレイヤーはエディターから分離されています。入力として、
検証済みの `.nsp.json` パッケージを使用します。

```powershell
npm.cmd run pack -- --project Title
npm.cmd run native -- --project Title
```

使用する主なライブラリ：

- SDL3：ウィンドウ、入力、タイミング、描画
- SDL_ttf / FreeType：セリフとUIの文字
- SDL_image：背景、立ち絵、画像オーバーレイ
- SDL3_mixer：BGM、SE、ボイス
- FFmpeg：動画のデコードと音声・映像連携

ネイティブランタイムはパッケージとアセットだけを読み込みます。
編集用のシナリオソースを直接解析・実行しません。

## DSLとの契約

native player は browser player と同じコンパイル済み命令を実行します。立ち絵の正式構文は以下だけです。

```tds
show hero.normal center
show hero.smile left fade 300
hide hero
hide hero fade 300
show image logo center
clear image logo
```

現行のソース構文・型は [docs/syntax-reference.md](../docs/syntax-reference.md)、実行時の命令意味は [docs/runtime-semantics.md](../docs/runtime-semantics.md)、プロジェクト構成とpackage形式は [docs/project-format-and-packaging.md](../docs/project-format-and-packaging.md) を参照してください。旧構文解説の [syntax-draft.md](../syntax-draft.md) は現行契約の根拠ではありません。

## ビルド

```powershell
# プロジェクトのルートで実行
npm.cmd run native:build
npm.cmd run native
```

`native:build` は `native/build/Release/novel_player.exe` を生成します。別のbuild directoryを使って手動buildした場合、その実行ファイルは `tools/native.js` の標準検索先ではないため、直接起動してください。

別のパッケージを起動する場合は、パスを指定します。

```powershell
npm.cmd run native -- build/other.nsp.json
```

`tools/native.js` accepts a package path as the first positional argument and forwards Player options. When no package path is supplied, it uses the configured entry package under `.novel/build/`, so options can be used without being mistaken for a package name.

The wrapper resolves a relative package argument from the caller's current working directory, then starts the Player with the resolved package path and the repository as its process working directory. Package assets and legacy `saves/` migration are resolved beside the package, independent of that working directory. Directly launching `novel_player.exe` uses the Player process working directory for a relative package argument. On Windows, the Player accepts UTF-8 package paths through `wmain`; paths containing spaces or Japanese characters are supported. A missing-package startup error reports that path in UTF-8.

`NOVEL_SAVE_ROOT` must be an absolute path. On Windows it can contain non-ASCII characters; the Player reads it as a wide environment value. If unset, the normal Native runtime uses `SDL_GetPrefPath("NovelScript", saveId)`. `--debug-state` accepts only a filename and writes it beside the package.

```powershell
npm.cmd run native -- --project Title --headless
npm.cmd run native -- --project Title --debug-start main.tds main 12 '{}'
```

The Player accepts `--headless`, `--smoke`, `--load-slot <1-120>`,
`--debug-start <file> <scene> <line-or-0> <variables-json>`, and
`--debug-state <filename>`. `--debug-state` writes the current source cursor to
a file beside the package; it accepts only a filename, not a directory path.

The Player requires the complete package envelope (`source`, `program`,
`files`, and `native_ui`; `debug` is optional). Each compiled program must
contain `assets`, `characters`, `globals`, `functions`, `scenes`, and
`variables` arrays. The `source` entry must exist in `files`, and every file
entry must be a compiled program. The pack command emits this complete shape
for distributable packages.

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
