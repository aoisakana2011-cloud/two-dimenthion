# TDS 構文仕様

この文書は現在の `src/parser` と `src/checker` が受理する構文、および静的解析で課す条件を記録する。実装が受理することと、実行時に意味を持つことは別である。コマンドの引数やアセットの実在性は Checker/Runtime の責務も含むため、該当箇所に境界を明記した。旧案との相違を確認するときは [`syntax-draft.md`](../syntax-draft.md) ではなく、まず現行ソースと対応テストを基準にする。

## 1. 仕様の範囲と根拠

構文の入口は `parse(source, knownStructs?)` (`src/parser/parser.ts`) である。`Lexer` がトークンを逐次生成し、`Parser` が AST (`src/parser/ast.ts`) を作る。Parser は文法違反を `ParseError` として停止する。Checker は AST に対して型、名前解決、値域、フロー、アセットなどを追加検証する。したがって「構文上受理される」だけではコンパイル可能とは限らない。

主要な確認テストは `test/parser.test.js`（Lexer/Parser と Parser→Compiler を含む）、`test/language-reference.test.js`（解析・言語統合）、`test/global-scope.test.js`、`test/scene-graph-include-scope.test.cjs`、`test/audit-regression.test.js` である。節末にテーマごとのテスト名を挙げた。実装上の主要箇所は `src/parser/lexer.ts`、`src/parser/parser.ts`、`src/parser/ast.ts`、`src/checker/type-checker.ts`、`src/checker/analyzer.ts`。

## 2. 字句規則

### 2.1 文字、識別子、トークン

識別子は ASCII のみで、正規表現相当は `[A-Za-z_][A-Za-z0-9_]*`。大文字と小文字は区別される。日本語は文字列リテラルには書けるが識別子にはできない。予約語は宣言名、変数名、フィールド名などの識別子位置では拒否される。予約語集合は `parser.ts` の `KEYWORDS` が唯一の実装基準であり、次を含む。

```text
scene asset character struct pose include int float str bool list dict none
global const let true false set unset say bg bgm char show at hide image clear
play se effect wait camera if elif else and or not choice for from to step while
fn return goto async blocking parallel voice video
```

ここにある `let`、`pose`、`char`、`at` などは予約語であっても、同名のトップレベル文/式を必ず 지원することを意味しない。`let` は通常の宣言構文ではなく、宣言は `int x = ...`、`const int x = ...` などである。`character` は宣言名として予約されるが、修飾関数呼び出し `walk.character()` のセグメントに限り例外として許される。修飾呼び出しの `list` も `runtime.state.characters.list()` 等のセグメントに限り許可される。

トークン種別は `word`, `string`, `number`, `symbol`, `newline`, `eof`。記号は `{ } [ ] = ( ) : , + - * / % < > ! . \\` と、複合記号 `== != >= <= -> => ..`。ただし複合記号であっても全ての文法位置で利用できるわけではない。たとえば `=>` と `..` は Lexer が認識するが、通常の式演算子ではない。

### 2.2 空白、改行、コメント

空白として読み飛ばすのは半角スペースとタブ。改行は LF、CR、CRLF、Unicode LS (`U+2028`)、Unicode PS (`U+2029`) を認識する。CRLF は改行トークン1個として扱う。ファイル先頭の UTF-8 BOM は無視し、先頭トークンの列番号をずらさない。BOM がファイル途中にあれば通常の不正文字となる。

`#` または `//` は文字列の外側で行末までのコメント。文は原則として1行に1つで、セミコロンによる文区切りはない。式の一部では改行を許す場所がある（丸括弧ではなく辞書リテラル、choice の項目、ブロック境界など）。インデントは構文上の意味を持たず、ブロック境界は `{` と `}` で決まる。

### 2.3 数値と文字列

数値は10進整数または小数/指数表記。整数は数字列、float は小数点の後に数字がある形式か指数部を持つ形式。例: `12`, `0.25`, `1e3`, `2.5E-2`。`.5` は数値トークンにならず、`5.` もfloatとして完成しない。符号は数値字句の一部ではなく単項 `+` / `-`。

整数 AST 値は安全整数範囲内なら JavaScript number、範囲外なら bigint として保持される。Parser は64-bit整数値を扱うテストを持つ。float リテラルは有限値であることを検査し、`Infinity` 相当を拒否する。

文字列は二重引用符のみ。実改行を含めることはできず、改行前に閉じていない場合は `Unterminated string`。対応エスケープは `\\`, `\"`, `\n`。未知のエスケープは Lexer が元の位置情報を保持し、式、asset path、include path、goto path、dictionary key などの意味ある文字列位置で Parser が拒否する。文字列 AST は展開前の値を保持し、補間は Checker/Runtime が別途扱う。

## 3. ファイルトップレベル文法

以下は意図を示す EBNF。ブロック本文は改行区切り。Parser が実装する順序自由度や例外は各節に記す。

```ebnf
script       = { newline }, { top-item, { newline } }, EOF ;
top-item     = asset-decl | character-decl | struct-decl | function-decl
             | scene-decl | include-decl | statement ;
asset-decl   = "asset", asset-kind, identifier, "=", string, [ volume-option ] ;
volume-option= "volume", float-number ;
asset-kind   = "bg" | "char" | "bgm" | "se" | "voice" | "video" | "image" ;
include-decl = "include", path, "as", identifier ;
character-decl = "character", identifier, "{", { character-member }, "}" ;
character-member = identifier, "=", expression, newline
                 | "pose", identifier, "=", string, [ "y_offset", "=", signed-integer ], newline ;
struct-decl  = "struct", identifier, "{", { identifier, ":", primitive, newline }, "}" ;
function-decl= "fn", identifier, "(", [ parameters ], ")", "->", type, block ;
parameters   = parameter, { ",", parameter } ;
parameter    = identifier, ":", type ;
scene-decl   = "scene", identifier, block ;
block        = "{", { newline }, { statement, { newline } }, "}" ;
```

トップレベル宣言は同じファイルの途中に混在できる。AST 上では種類別配列に分類されるため、ソースでの並び順と実行順を同一視しないこと。トップレベルで許される宣言は asset/character/struct/fn/scene/include。実行可能なトップレベル文も構文上は許可され、AST の `globals` に入る。これらトップレベル宣言を scene/function/block 内に書くと、その宣言自体の位置で拒否される。

Parser はファイル全体を軽く走査して struct 名を先に収集する。このため構造体型を定義前に参照できる。include 先の struct 名は単一ファイル Parser の先読みとは別であり、複数ファイルでの名前可視性は Analyzer の module 解決規則に従う。

## 4. 型、宣言、値

### 4.1 型の集合

```ebnf
primitive = "int" | "float" | "str" | "bool" ;
type      = primitive | "none" | "list", "[", primitive, "]"
          | "dict", "[", primitive, "]" | struct-name ;
```

`none` は関数の戻り値型として選べるが、引数型/変数の明示型としては `parseType(false)` によって拒否される。list/dict 要素型はプリミティブに限定され、ネストした list/dict、struct 要素は型文法にない。struct のフィールドも `int/float/str/bool` のみ。

### 4.2 変数宣言

```ebnf
declaration = [ "global" ], ( primitive | "list" "[" primitive "]"
             | "dict" "[" primitive "]" | "const" type | struct-name ),
             identifier, "=", expression ;
```

`global` は後続が変数宣言である必要がある。`const` は明示型と初期値を必須とし、再代入不可。`int/float/str/bool` と `list[T]` / `dict[T]` は型明示宣言。struct 型名を使う場合は `Position p = {...}` の形式。初期値は全宣言で必須。Parser が AST を作った後に Checker が初期値との型整合、重複、スコープ、const 再代入を検査する。

初期値からの型推論は解析層に存在するが、構文上の無型 `let x =` はサポートされない。空 list は要素型を推論できないため `list[str] xs = []` のように型を与える。空 dictionary も単独では値型を推論できない。list は同一プリミティブ型のみを保持し、添字は0始まり int。dict のキーは文字列リテラルで、値は一種類のプリミティブ型で揃える。Dictionary の重複キーは Checker エラー。

### 4.3 struct、character、asset

```tds
struct Position {
  x: float
  y: float
}

character hero {
  name = "主人公"
  pose normal = "char/hero.png" y_offset = -12
}

asset bg room = "bg/room.png"
asset bgm theme = "audio/theme.ogg" volume 0.7
```

struct は名前付きフィールド型表で、同じフィールドの重複は拒否される。初期値は文字列キーの辞書リテラルで表現し、Checker が宣言フィールドと照合する。character の一般プロパティ値は式 AST だが、Checker は定数かつプリミティブ値を要求する。pose は画像 path と任意の整数 `y_offset`。範囲は -1,000,000〜1,000,000 px、重複pose/過剰値は拒否対象。

asset 種別は `bg`, `char`, `bgm`, `se`, `voice`, `video`, `image`。path は文字列必須。Parser の volume オプションは bgm/se/voice のみに許可し、0〜1 の小数表記を要求する。Checker は種別ごとの拡張子、パス形状、重複IDや参照先を検証する。asset ID と実ファイル名は別概念であり、コマンドは宣言済みIDまたは許容された参照形式を使う。

## 5. 文 (statement) の文法

```ebnf
statement = declaration | "set", assignable, "=", expression
 | "unset", assignable
 | "if", expression, block, { "elif", expression, block }, [ "else", block ]
 | "for", identifier, "in", expression, block
 | "for", identifier, "from", expression, "to", expression,
       [ "step", expression ], block
 | "while", expression, block | "parallel", block
 | "choice", [ expression ], "{", { expression, block }, "}"
 | "return", [ expression ] | "goto", ( identifier | string )
 | "say", [ identifier ], expression, [ "opacity", expression ]
 | qualified-call | bare-call | engine-command ;
assignable = identifier, { "[", expression, "]" | ".", identifier } ;
```

この文法表は上位形を示し、コマンド固有の語彙引数や追加制約は Checker/runtime が検査する。

### 5.1 制御文

`if` の条件は式で、条件型が bool であることを Checker が要求する。`elif` と `else` は閉じ波括弧の後、改行を挟んで書ける。`for x in expr` は foreach AST、`for i from a to b [step s]` は範囲ループ AST。省略 step は1。int/範囲/step の適正性や実行上限は Checker/Analyzer が検査する。`while expr {}` も bool 条件。`parallel {}` は並列ブロック AST だが、そのコマンドが実行時にどう並ぶかは Runtime/compiler の仕様。

`choice` は prompt を省略できる。波括弧内は `式 { statement... }` の選択肢を連ねる構造。ラベルの型、選択肢数などは Checker が確認する。空選択肢群は診断対象。

### 5.2 呼び出し、return、goto

関数宣言は `fn name(param: type, ...) -> type { ... }`。戻り値型は `none` を含む。式内/単独文の関数呼び出しは `name(args...)`、module や namespace は `alias.name(args...)` のようにピリオドでつないだ修飾名として呼び出す。修飾名は Parser が一つの関数名文字列として保持する。関数の存在、引数数/型、戻り値の利用は Checker が判定する。再帰呼び出しも静的解析の対象。

`return` は値を省略可能。関数外の return、戻り値型との不整合、戻り値経路の不足は解析エラー。`goto SceneName` はローカル scene 名を指す。外部ファイル遷移は `goto "chapter/next.tds"` のように引用符で囲む必要がある。Windows の `\\` は `/` に正規化される。絶対パス、`.`/`..`、禁止記号や不正ファイル名は拒否される。実在scene/外部ファイルの到達性は Parser では確定せず、Analyzer/pack がプロジェクト全体で解決する。

`include "common.tds" as common` はトップレベルのみ。非引用パスは空白を含まない字句列として許容される。alias はファイル内で重複不可。循環 include、欠損、別ファイルシンボルの見え方はプロジェクト解析時に解決する。修飾関数呼び出しのalias有効性もその段階で確認する。

### 5.3 say とエンジンコマンド

`say "本文"` は話者 `narrator` の省略形。`say hero "本文"` は指定話者。本文は文字列リテラルに限らず文字列型式を利用できるが、話者を省いた形では先頭が文字列リテラルである特別な許容条件がテストされている。任意の文字列式を含める場合は `say narrator expression` と明示する。任意の追加引数として `opacity expression` がパーサーにある。

エンジンコマンドはキーワードから始まる1行文で、Parser は引数をコマンド別の式列に変換する。実装上認識される主要コマンド群は `bg`, `bgm`, `char`, `show`, `at`, `hide`, `image`, `clear`, `play`, `se`, `effect`, `wait`, `camera`, `volume`, `layer`, `dialog`, `move` 等。これらの全引数形を一般の式文法から推測してはならない。特別扱いされる語には `fade`, `crossfade`, `wipe-left/right/up/down`, `--only`, `--layer N`, `blocking`, `async`, `opacity`, `volume`, `character`, `over`, `by` 等がある。詳細な有効引数、相互排他、アセット種別、範囲は `src/checker/type-checker.ts` の `checkCommand` と該当 runtime/compiler テストが根拠となる。

`--only` / `--layer` は `bg`, `show`, `play` の表示系形式としてトークン化される。Checker は利用できる対象を絞り、`--layer` の値が数値で0以上8未満となることを要求する。音声・非視覚再生に `--only` を付けるのはエラー。`play video ...` の blocking/async 省略時の実行モード等、既定値は Parser 文法ではなく解析/ランタイム仕様。

## 6. 式文法と優先順位

```ebnf
expression = prefix, { binary-op, prefix } ;
prefix     = ("not" | "+" | "-"), prefix | postfix ;
postfix    = primary, { "[", expression, "]" | ".", identifier } ;
primary    = number | string | "true" | "false" | identifier
           | call | "(", expression, ")" | list-literal | dict-literal ;
list-literal = "[", [ expression, { ",", expression }, [ "," ] ], "]" ;
dict-literal = "{", [ string, ":", expression, { ",", string, ":", expression }, [ "," ] ], "}" ;
```

二項演算子の優先順位は高い順に次の通り。同一順位は左結合 (`parseExpression(precedence + 1)`)。

| 優先度 | 演算子 | Checker 上の意味/制約 |
|---:|---|---|
| 70 | 単項 `+`, `-` | 数値型 |
| 60 | `*`, `/`, `%` | 数値型。型変換規則は Checker |
| 50 | `+`, `-` | 数値演算。str + str の連結を `+` に限り許可 |
| 40 | `==`, `!=`, `>`, `>=`, `<`, `<=` | 比較結果 bool。順序比較の型制約あり |
| 30 | 単項 `not` | bool |
| 20 | `and` | bool の短絡論理積 |
| 10 | `or` | bool の短絡論理和 |

括弧で結合順を変えられる。比較演算子同士の連鎖は特別な構文ではなく左結合の式となるため、数学的な `a < b < c` を想定しない。式内の postfix 添字/フィールド参照は演算子より先に結合する。`user.name` は AST 上 index 式（文字列キー）であり、struct 以外のアクセスは Checker が拒否する。list/dict 添字のキー型も Checker が確認する。

`and`/`or` は短絡評価を解析が扱う。関数呼び出し式も書ける。式内で許可される builtin や runtime API は `src/checker/type-checker.ts` と `src/language/builtins.ts` の定義に従い、Parser は未知の名前を一律拒否しない。

## 7. スコープと名前解決

構文・AST 自体はシンボル解決を完了しない。Analyzer はプロジェクト内の include/module、グローバル、関数、scene、character、asset、struct を統合して解決する。関数引数は関数スコープ、関数内宣言はローカルスコープ、scene内の宣言はscene実行コンテキスト、ループ変数はループスコープとして解析される。分岐内宣言の有効性は全制御フロー経路を考慮し、どの経路でも初期化されない変数参照は拒否される。ループが0回実行されうる場合、その内部宣言は外側へ漏れない。

`global` は永続/共有領域を意図する明示指定であり、通常ローカルと別に扱う。IDE 変数テーブルから注入されたグローバルも解決対象になる。const は再代入禁止で、定数伝播や分岐判定に利用され得る。Checker の診断には unused variable/function、到達不能文、未定義名、重複定義、型不整合等がある。正確な可視性や保存形式を構文だけから推定しない。

## 8. 補間とソース位置

文字列補間は `{name}`、struct field を含む `{hero.stats.hp}`、引数なし関数呼び出し形 `{score()}` を解析層が認識する。文字列の `{{` / `}}` は literal brace として扱う経路がある。補間内の識別子は通常式文法ではなく、Checker の補間スキャナーが独自に解釈するため、任意式の埋め込みを仮定しない。定数として分かる文字列連結に含まれる補間は再帰的に検査される場合がある。

各トークンは1始まりの `line`, `column` と0始まりのソース `offset` を持つ。CR/LF等の行区切りで次行の列は1に戻る。ParseError は問題のトークン位置を `at line N, column M` として付与する。AST ノードにも開始位置が付き、ブロック文には閉じ `}` の行列が end location として保存される。文字列のエスケープでは展開後の文字位置をソース列に戻せる `sourceColumns` を保持し、補間エラーの列表示に利用される。Parser エラーと Checker 診断は別レイヤーである。

## 9. 代表例

```tds
include "shared/items.tds" as items

asset bg room = "bg/room.png"
character hero {
  name = "ミナ"
  pose normal = "char/mina.png" y_offset = -8
}
struct Status {
  hp: int
  label: str
}
global int chapter = 1
const float speed = 1.25

fn greeting(who: str) -> str {
  return "こんにちは、" + who
}

scene opening {
  Status status = {"hp": 10, "label": "開始"}
  list[int] scores = [10, 20, 30]
  say hero greeting("ミナ")
  if status.hp > 0 and chapter == 1 {
    show hero.normal center fade
  } elif status.hp == 0 {
    say "終了"
  } else {
    goto "chapter/next.tds"
  }
  choice "どうする？" {
    "進む" { set chapter = chapter + 1 }
    "戻る" { return }
  }
}
```

この例は記法サンプルであり、各コマンドの実引数や関数戻り値/sceneでのreturn等の実行上妥当性は別途Checkerが確認する。

## 10. 拒否される形式・境界

- 識別子への日本語、予約語、先頭数字、識別子中のハイフン。
- `;` 区切り、インデントブロック、単引用符文字列、複数行文字列、未対応エスケープ。
- `let x = ...` のような型指定なし宣言、初期値なし宣言、`none` 型変数。
- `dict[dict[int]]` / `list[struct]` / struct内structフィールド等の複合要素型。
- `goto chapter/next.tds` の非引用外部パス、絶対パス、`.`/`..` を含むパス。
- ブロック内のトップレベル専用宣言（asset/character/struct/fn/scene/include）。
- コメント開始記号は文字列外で効く。引用符内では通常文字。
- Lexer が `=>` や `..` をtokenizeしても、現行の式文法にラムダ/範囲演算子があるわけではない。
- Parser のコマンド引数は文脈依存であり、任意語をコマンドオプションとして追加できない。

## 11. 対応テスト索引

| 仕様 | 実装・テスト根拠 |
|---|---|
| token位置、改行、BOM、文字列終端、escape | `src/parser/lexer.ts`; `test/parser.test.js`: `reports unterminated strings`, `treats all supported external line separators as DSL newlines`, `accepts a leading UTF-8 BOM without shifting token locations`, `rejects unknown escapes and non-canonical asset paths` |
| 宣言、型、const、global、予約識別子 | `src/parser/parser.ts`, `src/checker/type-checker.ts`; `test/parser.test.js`: `supports typed const declarations and rejects reassignment`, `parses explicit global declarations`, `rejects every DSL keyword documented as unavailable for identifiers`, `parses and validates named structs`, `allows struct types to be referenced before their declaration`; `test/global-scope.test.js` |
| 式、優先順位、辞書/list | `parser.ts` PRECEDENCE/parsePrefix, `type-checker.ts`; `test/parser.test.js`: `parses logical conditions and choice expressions`, `parses arithmetic operators without whitespace dependency`, `precedence of not correctly captures comparison expressions`, `parses multi-line dictionary literal`, `supports 64-bit integer values without loss of precision` |
| 制御文、フロー、補間 | `src/checker/analyzer.ts`; `test/parser.test.js`: `reports malformed dictionary and blocks at exact locations`, `validates interpolation variables and choice cardinality`, `reports the complete source range of unreachable say statements`, `reports complete source ranges for unreachable control-flow blocks`, `validates variables that are not declared on every control-flow path` |
| asset/character/move/media | `src/checker/type-checker.ts`; `test/parser.test.js`: `character declarations require a string name and constant primitive fields`, `validates and preserves non-blocking BGM crossfade options`, `supports explicit blocking and async voice playback modes`, `parses --only as a display modifier for image and video commands`, `rejects --only on non-visual media playback` |
| include/module/goto | `src/checker/analyzer.ts` と project resolver; `test/parser.test.js`: `parses aliased module imports and qualified function calls`, `normalizes Windows separators in goto scene paths`, `requires external goto paths to be quoted while preserving local scene names`; `test/scene-graph-include-scope.test.cjs` |

この索引は代表例であり、テストファイル内には値域、定数伝播、短絡、経路合流、到達性、診断範囲、最適化との契約を扱う追加テストが多数ある。仕様変更時は Parser だけでなく Checker/Analyzer/Compiler とプロジェクト解決のテストも合わせて更新する。
