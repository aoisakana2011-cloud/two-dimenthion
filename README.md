# Novel Script パーサー・コンパイラー

## GUIエディター

```powershell
npm.cmd run editor
```

4173番ポートが使用中の場合は、4174～4183番ポートを自動的に試します。
コマンドに表示されたURLをブラウザーで開いてください。

`Edit/catalog.txt` にはアセットカタログの文法だけを記述します。
実際の画像や音声は、シナリオ内で `asset` または `character` として宣言します。
`narrator` は組み込みの `say` 話者であり、キャラクターアセットではありません。

シナリオは `Edit/scenes/` に保存されます。エディターでは直接入力のほか、
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
npm.cmd run pack -- Edit/scenes/main.novel build/main.nsp.json
```

生成された `.nsp.json` をネイティブプレイヤーへ渡して実行します。
# two-dimenthion
