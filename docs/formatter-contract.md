# TDS Formatter の仕様

この文書はIDE整形と `tools/format.js` が共有する `shared/formatter.js` の動作を説明する。整形は構文解析器やCompilerではなく、編集中の不完全ソースでも利用できるtolerant lexer/CST整形である。TDS言語全体は[構文仕様](syntax-reference.md)、IDE操作は[IDE仕様](ide-spec.md)を参照。

## 1. 公開APIと呼び出し経路

`shared/formatter.js` はCommonJSで `{ format, lex }` をexportし、Browserでは `globalThis.NovelFormatter` として公開する。

| 呼び出し元 | 関数 | 対象 |
|---|---|---|
| IDE current file | `formatCode()` → `format(source)` | textarea本文と選択範囲 |
| IDE project action | `formatProjectScenes()` | project内TDS scene文書 |
| Node CLI | `formatFiles(inputs)` → `format(source)` | 指定file/directory内の`.tds`と`.txt` |

IDEとCLIが同じ `format()` を使うため、token spacingとblock整形規則は共通です。IDEの保存やcompile、Checker実行はFormatter APIの一部ではありません。

## 2. Tolerant lexer

`lex(source)` はtokenに `kind`, `value`, `start`, `end` を付けます。対応種別は`word`, `number`, `string`, `comment`, `operator`, `punctuation`, `marker`, `plain`です。未完成の文字列、開き括弧、半端なblockもsyntax errorにせずtokenizeを続けることが意図されています。

- Identifier文字はASCII `[A-Za-z_][A-Za-z0-9_]*`。
- 複合記号は `== != >= <= -> => ..`、単記号はbrace/bracket/paren、comma、colon等。
- `#`と`//`から後ろはcomment token。format時には本文を保持し、code直後なら2 spacesで区切る。
- stringはquoteとescapeを走査し、閉じquoteがなくても残りをstringとして返す。
- `--only` と `--layer` はmodifierを分割しないよう一つのword tokenとして特別扱いする。
- IDE selection/caret用 private-use marker (`NOVEL_EDITOR_CURSOR`等)はmarker tokenとなり、format後に位置を再構成できる。
- Unicode/unknown characterは`plain`として保ち、formatter自身はParserの字句エラーを出さない。formatterが構文空白として読み飛ばすのはASCII spaceとtabだけで、全角空白・NBSP・form feed・vertical tabなどを消して有効なDSLへ変えてはならない。

これはCompilerの `src/parser/lexer.ts` と同じLexerではありません。Formatter lexerは誤入力中でも構造を保ってレイアウトするための別契約です。

## 3. Space、operator、literal

`formatTokens(line)` はtoken境界と前の実tokenを見てspaceを決めます。function/member callの`(`、member `.`、bracket index、閉じpunctuation、comma/colon、unary/binary operatorを個別扱いします。

- Binary operatorの前後にはspaceを入れる。
- unary `+`, `-`, `!` は文頭や演算子/開括弧/comma/colon、`from`/`to`/`step`/`return`の後で判定し、不要な空白を避ける。
- `foo(...)`、`object.field`、`list[index]`の連結を保持する。
- unquoted `include` pathはParserが隣接token値を連結する形式のため、path内部のtoken間に空白を入れない。
- `{`/`}`の空白とcomment境界はblock/dictの周辺文脈と併せて処理する。
- 数字tokenは小数・指数の形を保つ。signは別operatorとして扱う。
- string/comment token内部を書き換えず、literal本文の記号や空白を維持する。

Formatterは意味の知らないwordの並びもspacingするため、すべての正当・不正文に対しcompiler lexerの正規化を保証するものではありません。

## 4. Brace classification と行展開

`expandStructuralLine()` はparen/bracket depth、block stack、line中のprevious structural braceを持ち、braceを`block`か`literal`へ分類します。

Block判定に使うkeyword familyは `scene`, `fn`, `if`, `elif`, `else`, `for`, `while`, `parallel`, `choice`, `character`, `struct`。Command prefix群は `return`, `set`, `unset`, `say`, `show`, `hide`, `clear`, `bg`, `bgm`, `play`, `wait`, `effect`, `goto`, `include`, `global`, `const`, `int`, `str`, `dict`。加えて引用label直後のchoice body、choice内のoption expression等を特殊判定します。`parallel` は有効なstatement blockであり、本文を独立行に展開してindentします。

braceがblockであれば `{`前、`}`後で一行ずつ分割し、literal dictionary/object bracesは内部を分割しません。文字列中のbraceとcomment中のbraceは構造とは扱いません。隣接closing braceだけの行は個数分に分割し、`else`/`elif`は直前の単独`}`行へ連結します。

この分類はformatting heuristicであり、AST作成ではありません。パーサーが受理しない文も整形され得ます。逆に不正・曖昧なblockがParserと同じように分類される保証はありません。

## 5. Indentation と正規化

`format(source)` は先頭BOMを除去し、CRLF/CR、Unicode LS/PSをLFへ正規化してから行単位に処理します。

1. 各物理行をstructure expansionへ渡す。
2. それぞれの行のtoken spacingを整える。
3. 開きblock brace数−閉じblock brace数でindent depthを更新する。
4. 先頭のclosing brace数だけ、その行のindentを浅くする。
5. indent幅は半角space 2個。
6. 行末space/tabを除去し、結果行をLFでjoinする。

blank lineは空のまま保ちます。ただしParserが同一の `if` statementとして読む `}` と `elif` / `else` の間に空行がある場合は、branchをcanonicalな `} elif` / `} else` に接続するため、その空行を除去します。EOFにnewlineを必ず追加する契約はありません。Unbalanced bracesの負depthは0にclampされます。

## 6. Caret・selection保持

Editorはformat実行時にselection start/end位置へprivate markerを挿入し、formatterに渡します。`formatTokens()` はmarkerを出力へ保持しつつ前後tokenのspacing計算ではmarkerを飛ばし、markerが隣接identifier/number/operatorを誤分割しないよう`embedded`状態を持ちます。整形完了後Editorがmarker位置を探し、caretまたはselectionを元の意味位置へ戻します。

MarkerはFormatter public APIのTDS文法記号ではありません。入力ソースに同じprivate-use patternを含めることをユーザー構文として保証しません。

## 7. CLIファイル選択

`tools/format.js` の `collect(input)` は単一fileなら`.tds`または`.txt`のみ受け付けます。directoryなら再帰的に同じ拡張子の通常fileを収集します。複数inputの重複fileを取り除き、path sortして順番を固定します。処理結果は `{files, changed}`。

CLI usage:

```powershell
npm.cmd run format -- "Title/senario/main.tds"
npm.cmd run format -- "Title/senario"
```

変更のあったfileだけUTF-8で書き戻します。CLI自体はproject config、include graph、syntax validityを検査しません。directory指定により再帰的に多数の`.txt`も対象となるため、実行前にpathと対象を指定します。

引数なしは英語のusage表示とexit code 2、format/read/write failureはexit code 1です。成功時は`Formatted scene files: changed/total changed`を表示します。

## 8. 安定性・意味保存契約

期待する性質は決定性とidempotenceです: `format(format(source)) === format(source)`。未完・不正ソースでも、対応するblockを持たない単独`}`を`else`/`elif`へ結合しないため、行展開heuristicが再整形時に変化しません。TDSとして有効なcontract corpusでは、整形前後にParserから見えるAST構造（source locationを除く）を同一に保つことも検査します。Formatterが一般に意味保存を証明するのではなく、対応 corpusに対して回帰契約を持つという位置づけです。

特別なregression対象にはsigned pixel offset (`x-10`, `y+40`)、expression offsets、float/exponent、`--only` modifier、comment/string brace、Unicode line separators、incomplete sourceがあります。

| 性質 | テスト根拠 |
|---|---|
| deterministic / idempotent / line-ending | `test/formatter-contract.test.js` |
| valid corpus AST preservation | 同 test の `shared formatter preserves compiler CST semantics`; `shared formatter preserves adjacent tokens in unquoted include paths`; `shared formatter expands parallel as a statement block` |
| signed offsetと`--only`保持 | 同 test のpresentation command cases |
| tolerant lexing | 同 test のstring/comment token case |
| Editorの実format shortcutとUnicodeをまたぐselection保持 | `test/editor-typing.browser.cjs`。`Ctrl+Shift+F`でformatし、astral Unicode後の選択範囲が同じ文字列に戻ることをBrowserで確認 |
| CLIとIDEの共通format API / file write | 同 test の `CLI formatter uses the same shared implementation as the IDE` |

Benchmark用 `npm.cmd run benchmark:formatter` はperformance測定専用で、正しさテストの代わりではありません。

## 9. 実装境界と更新時の注意

- Syntax grammar changeがFormatter brace heuristicとcommand keyword setsへ影響するか調べる。
- Compiler lexerとFormatter lexerは独立しているため、token rule変更を自動共有しない。
- 新commandの`--only`等modifierやsigned coordinatesがSpacingを変えるとASTが変化し得る。対象corpusを追加してcontractを更新する。
- Formatted sourceがCompilerに通ることと、Formatterが曖昧な入力をParserのようにdiagnoseすることは別。
- IDE auto-formatはdirty/history/selectionを伴う。CLIはfileを直接書き換える。保存挙動を同一視しない。

実装入口: `shared/formatter.js`、`tools/format.js`、`Edit/editor.js` の `formatCode()` / `formatProjectScenes()`。Parserとの境界は `src/parser/lexer.ts`、`src/parser/parser.ts`。
