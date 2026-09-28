# Novel Script パーサー・コンパイラー

ビジュアルノベル用DSL、ブラウザーエディター、browser player、SDLベースnative playerを含むプロジェクトです。言語仕様の正本は [syntax-draft.md](syntax-draft.md) です。旧立ち絵構文や `say` ブロック構文は互換実装を持たず、正式構文だけを受理します。

## 最初に読むもの

- [構文リファレンス](syntax-draft.md): 文法、型、命令、完全例
- [native player](native/README.md): native build・実行・headless検証
- `Title/setting/setting.txt`: 作品レイアウトと開始ファイルの設定

## GUIエディター

```powershell
npm.cmd run editor
```

作品データはエディター本体の外に置きます。標準の作品フォルダーは `Title` です。

```text
Title/                  # 名前は自由
  asset/                # 画像・音声・動画
  senario/              # .tds シナリオ
  setting.txt           # scenario_dir / asset_dir / start_file / title
  .novel/               # 生成メタデータとbuild成果物
Edit/                   # エディター本体
```

別名・別の場所の作品を開く場合（日本語や空白を含む名前も可）:

```powershell
npm.cmd run editor -- --project "D:\作品\夕暮れの手紙"
npm.cmd run pack -- --project "D:\作品\夕暮れの手紙"
npm.cmd run native -- --project "D:\作品\夕暮れの手紙"
```

`NOVEL_PROJECT_ROOT` 環境変数でも作品フォルダーを指定できます。素材宣言は `asset/bg/mori.jpg` のように記述します。includeと外部gotoは `setting.txt` の `scenario_dir` が基準です。packは同ファイルの `start_file` を使い、標準では `.novel/build/<開始ファイル名>.nsp.json` と、その横の `asset/` に出力します。

最小の `setting.txt` は次のとおりです。

```text
scenario_dir = senario
asset_dir = asset
start_file = main.tds
title = 作品名
```

4173番ポートが使用中の場合は、4174～4183番ポートを自動的に試します。
コマンドに表示されたURLをブラウザーで開いてください。

`Edit/catalog.txt` にはアセットカタログの文法だけを記述します。
実際の画像や音声は、シナリオ内で `asset` または `character` として宣言します。
`narrator` は組み込みの `say` 話者であり、キャラクターアセットではありません。

シナリオは選択中の作品の `setting.txt` にある `scenario_dir` のフォルダーに保存されます。エディターでは直接入力のほか、
セリフや選択肢などのテンプレートをカーソル位置へ挿入できます。

## セットアップとテスト

```powershell
npm.cmd install
npm.cmd test
```

## パーサー・コンパイラーAPI

```ts
import { parse, compile } from './src';

const ast = parse('say narrator "こんにちは"');
const program = compile(ast);
```

- `src/parser`: DSLの字句解析、構文解析、AST定義
- `src/compiler`: ASTを実行用の命令形式へ変換
- `dist`: `npm.cmd run build` で生成されるコンパイル済みコード

## ネイティブプレイヤー用パッケージ

```powershell
npm.cmd run pack -- --project Title
```

`Title/.novel/build/main.nsp.json` が生成されます。続けて `npm.cmd run native -- --project Title` でネイティブプレイヤーを起動できます。

`goto ending` は同一ファイル内のsceneへ、`goto "next.tds"` または
`goto "first/next.tds"` は選択中の作品の `setting.txt` にある `scenario_dir` を基準とする別ファイルへ移動します。
packは遷移先も収集し、素材の存在とパスを検証して出力先へコピーします。
ファイルをまたいでも同名のグローバル変数の値は維持されます。

回帰テストは `npm.cmd test` で実行します。ネイティブの比較テストも実行する場合は、
`NOVEL_NATIVE_EXE` 環境変数にビルドした `novel_player.exe` の絶対パスを指定します。
実ブラウザー検証は `test/browser-check.cjs`、SDLとFFmpegを含む検証は
`test/native-smoke.cjs` です。後者ではFFmpegの実行ファイルもPATHに必要です。
# two-dimenthion
# デスクトップ版

Electron を使う場合は、依存関係を入れた後に次で起動します。

```powershell
npm.cmd install
npm.cmd run desktop
```

Electron はローカルの編集サーバーを自動で起動し、ウィンドウを閉じると停止します。環境変数 `ELECTRON_RUN_AS_NODE` が設定されていても、デスクトップ起動時だけは無効化されます。従来どおりブラウザーで起動する場合は `npm.cmd run editor` を使えます。

Windows配布版は次で作成します。

```powershell
npm.cmd run desktop:package:win
```

`release/Novel Script Editor-win32-x64/` に、Editor本体とBrowser/Native再生に必要なNative実行ファイル・DLL・`engine_data` が生成されます。配布版は初回起動時に「フォルダを選ぶか作成してください。」と表示します。既存作品を選ぶか、作品を作成してから編集を始めます。`NOVEL_PROJECT_ROOT` を指定した場合はその作品を直接開きます。
