# Novel Script パーサー・コンパイラー

## GUIエディター

```powershell
npm.cmd run editor
```

作品データはエディター本体の外に置きます。標準の作品フォルダーは `Title` です。

```text
Title/                  # 名前は自由
  asset/                # 画像・音声・動画
  senario/              # .tds / .txt と config.txt
  .novel/               # 生成メタデータとbuild成果物
Edit/                   # エディター本体
```

別名・別の場所の作品を開く場合（日本語や空白を含む名前も可）:

```powershell
npm.cmd run editor -- --project "D:\作品\夕暮れの手紙"
npm.cmd run pack -- --project "D:\作品\夕暮れの手紙"
npm.cmd run native -- --project "D:\作品\夕暮れの手紙"
```

`NOVEL_PROJECT_ROOT` 環境変数でも作品フォルダーを指定できます。素材宣言は `asset/bg/mori.jpg` のように記述します。includeと外部gotoは作品の `senario/` が基準です。packは `senario/config.txt` の `start_scene` を使い、標準では `.novel/build/<開始ファイル名>.nsp.json` と、その横の `asset/` に出力します。

4173番ポートが使用中の場合は、4174～4183番ポートを自動的に試します。
コマンドに表示されたURLをブラウザーで開いてください。

`Edit/catalog.txt` にはアセットカタログの文法だけを記述します。
実際の画像や音声は、シナリオ内で `asset` または `character` として宣言します。
`narrator` は組み込みの `say` 話者であり、キャラクターアセットではありません。

シナリオは `Title/senario/` に保存されます。エディターでは直接入力のほか、
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
npm.cmd run pack -- Title/senario/main.tds build/main.nsp.json
```

生成された `.nsp.json` をネイティブプレイヤーへ渡して実行します。

`goto ending` は同一ファイル内のsceneへ、`goto next.tds` または
`goto first/next.tds` はプロジェクトの `Title/senario/` を基準とする別ファイルへ移動します。
packは遷移先も収集し、素材の存在とパスを検証して出力先へコピーします。
ファイルをまたいでも同名のグローバル変数の値は維持されます。

回帰テストは `npm.cmd test` で実行します。ネイティブの比較テストも実行する場合は、
`NOVEL_NATIVE_EXE` 環境変数にビルドした `novel_player.exe` の絶対パスを指定します。
実ブラウザー検証は `test/browser-check.cjs`、SDLとFFmpegを含む検証は
`test/native-smoke.cjs` です。後者ではFFmpegの実行ファイルもPATHに必要です。
# two-dimenthion
