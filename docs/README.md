# Novel Script Editor 技術仕様書

このディレクトリは、作品データ形式、言語処理系、IDE、Playerまでを機能単位で参照するための技術仕様書です。各文書は個別の責務、入力と出力、データ形式、状態遷移、制約、異常時、関連コード、根拠となるテストを扱います。複数分野にまたがる仕様は相互リンクし、同じ概説の重複を避けます。

## 分野別仕様

| 分野 | 文書 | 主な範囲 |
|---|---|---|
| 構文・言語 | [syntax-reference.md](syntax-reference.md) | 文字からtoken、AST、型、スコープ、asset、control flowに至るTDS言語契約 |
| コンパイラ | [compiler-pipeline.md](compiler-pipeline.md) | 単体構文解析からproject graph、診断、NSP命令、最適化、pack成果物まで |
| UI・Player | [ui-runtime-spec.md](ui-runtime-spec.md) | UI設定、screen-document中間表現、論理layout、操作・状態、Browser/Native描画と永続化 |
| IDE | [ide-spec.md](ide-spec.md) | Editor画面、project I/O、解析API、候補・定義参照、Scene Flow、実行ツール連携 |
| 静的解析 | [analysis-and-diagnostics.md](analysis-and-diagnostics.md) | 型検査、診断契約、定数/effect、値域解析、分岐合流、IDE/Flow連携 |
| 実行時 | [runtime-semantics.md](runtime-semantics.md) | NSP命令評価、変数frame、scene/goto、SceneState、action/音声/動画 |
| Project/Build | [project-format-and-packaging.md](project-format-and-packaging.md) | root選択、layout、新旧形式、setting、index、include/asset解決、package生成 |
| 保存データ | [save-data-and-migration.md](save-data-and-migration.md) | snapshot v1、Browser store、Native保存先、slot移行、thumbnail、失敗境界 |
| 検証/配布 | [testing-and-distribution.md](testing-and-distribution.md) | npm/CMake/Electron command、テスト階層、作品packageとEditor配布の区別 |
| 整形器 | [formatter-contract.md](formatter-contract.md) | tolerant lexer、brace分類、indent、caret保持、CLIとIDEで共有するAST保存契約 |

## 既存の詳説

- [プロジェクト全体の現行仕様](editor-project-overview.md): プロジェクト構成、実行、保存、解析、既知の差分を横断して説明します。
- [言語とエディタのガイド](tds-language-and-editor-guide.md): 作品作成者向けの実践ガイドです。
- [UI設計リファレンス](ui-design-reference.md): UIスキーマ、画面文書、描画・編集工程の詳説です。
- [標準ライブラリ](../std/README.md): `std/` の関数一覧と利用例です。
- [Native Player](../native/README.md): C++エンジンのビルドと実行上の注意です。
- [DSL構文リファレンス](../syntax-draft.md): 構文・型・例の詳細なリファレンスです。

## 読み方と仕様の優先順位

1. ソースコードとテストが実装の根拠です。資料とコードが食い違う場合、差を記録して資料を更新してください。
2. 構文の例は実際にParser/Checkerを通ることを前提にします。例示だけの擬似構文はそのように明記します。
3. BrowserとNativeは同じコンパイル済み命令と画面モデルを共有する箇所がありますが、DOMとSDLの描画・入力は別実装です。共通データ形式だけで画素単位の一致を意味しません。
4. 設計案、未実装事項、既知の差は現行仕様と分けて記載します。

## 代表的なデータの流れ

```text
作品フォルダー
  setting/setting.txt (legacy: root setting.txt) ──> scenario_dir / asset_dir / start_file
  *.tds ──> Lexer ──> Parser(AST) ──> Checker/Analyzer
            └─ include resolver ──> project symbol/scene graph
  AST + project context ──> Compiler ──> NSP v2 ──> Browser Runtime / Native Player
  asset declarations ──> path validation/copy ──> build asset tree
  runtime globals/frames/scene state ──> snapshot v1 ──> Browser DB / Native save root

Editor UI ──HTTP──> Edit/server.js ──> project APIs / parser / checker / pack / player
  ├─ text editing + diagnostics + symbol navigation
  ├─ Scene Flow + static value domains
  └─ screen settings ──> screen-document compiler ──> shared screen tree
                                                   ├─ Browser DOM renderer
                                                   └─ Native SDL renderer
```

この図は責務境界を表します。たとえばAST生成成功は全projectのinclude解決成功を意味せず、同じNSPを読むことは同じ画素・保存先を保証しません。実行中データのcheckpoint形式は [`save-data-and-migration.md`](save-data-and-migration.md)、命令の逐次意味は [`runtime-semantics.md`](runtime-semantics.md) で独立して説明します。

## 仕様変更を調査する順序

1. 変更する外部契約を特定します（`.tds`文法、JSON schema、HTTP route、NSP version、保存形式など）。
2. その契約を作る側と読む側のコードを両方追います。命令追加ならcompilerだけでなくBrowser/Native runtime、画面要素ならschema・compiler・二つのrendererを確認します。
3. 関連するunit、contract、Browser操作、Native実行テストを特定します。各種テストは異なる境界を検証するので代替可能とは限りません。
4. 仕様書には具体的なfield名、既定値、位置情報、失敗条件、制限、テスト名を記録します。ソースから確定できない点は「未確認」とします。
5. 実装と資料の差を見つけたら、どちらが現行仕様かをコードとテストで確かめてから同期します。

## 更新時に確認する入口

- DSL: `src/parser/lexer.ts`, `src/parser/parser.ts`, `src/parser/ast.ts`
- 静的解析: `src/checker/type-checker.ts`, `src/checker/analyzer.ts`, `src/language/builtins.ts`
- コンパイル: `src/compiler/compiler.ts`, `tools/pack.js`
- IDE: `Edit/editor.js`, `Edit/server.js`, `Edit/flow.js`, `Edit/flow-domains.js`
- UI: `Edit/screen-document.js`, `Edit/game-screens.js`, `Edit/player.js`, `Edit/runtime.js`, `native/player.cpp`
- 回帰テスト: `test/parser.test.js`, `test/compiler-differential.test.js`, `test/editor-*.browser.cjs`, `test/game-screens*`, `test/ui-controls.browser.cjs`
