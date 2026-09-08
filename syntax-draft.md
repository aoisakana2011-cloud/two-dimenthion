# Novel Script DSL 現行仕様

この文書は、現在のパーサー、型検査器、静的解析器、コンパイラ、ブラウザーランタイム、ネイティブランタイム、およびプロジェクトビルドの実装を基準にした仕様である。

## 1. 基本規則

- 原則として1行に1命令を書く。
- 文末のセミコロンは使用しない。
- インデントは可読性のための慣習であり、構文上の意味を持たない。標準は半角スペース2個。
- ブロックは `{` と `}` で囲む。
- ブロック開始の `{` は、条件や宣言と同じ行にも次の行にも書ける。
- 空行は無視される。
- 改行は通常、命令の終端になる。辞書リテラル内では改行できる。
- 整数は符号付き64 bitで扱う。
- 保存可能な基本型は `int` と `str`。複合型として `dict[int]`、`dict[str]`、名前付き `struct`、キャラクターオブジェクトがある。
- 内部的な真偽値は条件式にだけ存在し、`bool` 型の変数は宣言できない。
- `let` は廃止済みであり、使用すると構文エラーになる。

## 2. コメント、文字列、識別子

### 2.1 コメント

文字列の外側では、`#` または `//` から行末までがコメントになる。

```tds
# コメント
// これもコメント
say narrator "# と // は文字列内では本文"
```

### 2.2 文字列

文字列は `"` で囲む。改行を文字列へ直接含めることはできない。

使用できる主なエスケープは次のとおり。

- `\\`: バックスラッシュ
- `\"`: ダブルクォート
- `\n`: 改行文字

### 2.3 識別子

変数名、関数名、ローカルシーン名、キャラクター名、ポーズ名などは次の形式を使う。

```text
[A-Za-z_][A-Za-z0-9_]*
```

大文字と小文字は区別される。予約語は識別子として使用できない。

## 3. ファイル構成と実行開始

シナリオファイルの拡張子は `.tds` または `.txt`。

作品フォルダー名は任意。作品直下の `asset/` に素材、`senario/` にシナリオを置く（`senario` が正式なディレクトリ名）。エディター本体は作品フォルダーの外に置く。生成される変数・素材の索引とbuild成果物は作品内の `.novel/` に保存される。includeと外部gotoは `senario/` を基準とする。

1ファイルには次の要素を記述できる。

- `include`
- `asset`
- `character`
- `struct`
- グローバル変数
- 関数
- シーン
- トップレベル命令

`scene` がある場合、グローバル命令を実行した後、そのファイルで最初に宣言されたシーンから実行する。`scene` がないファイルは、トップレベル命令をそのまま順番に実行する。

パーサーはトップレベル要素を種類ごとのAST配列へ分ける。グローバル命令同士、関数同士、シーン同士の順序は保持されるが、異なる種類を交ぜたソース順がそのまま実行順になるわけではない。読みやすさと初期化順を明確にするため、記述順は次を推奨する。

1. `include`
2. `asset`、`character`、`struct`
3. グローバル変数
4. 関数
5. シーン

## 4. includeと複数ファイル

```tds
include functions.tds
include "chapter/common.tds"
```

- 引用符あり・なしの両形式を使用できる。
- 拡張子を省略した参照には `.tds` が補われる。
- 絶対パスと `..` によるプロジェクト外参照は禁止される。
- includeの循環はエラーになる。
- include先のアセット、キャラクター、グローバル、関数、シーンは、include元へ統合される。
- include先のグローバル命令は、includeの記述順に、include元のグローバル命令より先に実行される。入れ子のincludeは依存先から実行する。シーンの開始位置はinclude元の最初のシーンを優先する。
- 現在のプロジェクト統合処理はinclude先の `struct` を取り込まない。共有する `struct` はエントリーファイル側で宣言する。

別ファイルへの遷移は `goto` で行う。

```tds
goto chapter2.tds
goto chapter/chapter2.tds
```

include先と外部goto先のパスに使用できる文字は、英数字、`_`、`.`、`/`、`-`。引用符で囲んでも空白は使用できない。

ファイルをまたいでも既存のグローバル変数とキャラクター状態は維持される。同名グローバルの再宣言はせず、既存値の変更には `set` を使う。

## 5. アセット

```tds
asset bg school = "asset/bg/school.jpg"
asset bgm peaceful = "asset/bgm/peaceful.ogg"
asset se door = "asset/se/door.wav"
asset voice greeting = "asset/voice/greeting.ogg"
asset video opening = "asset/video/opening.mp4"
asset image logo = "asset/image/logo.png"
```

アセット種別は次の7種類。

| 種別 | 用途 | 許可拡張子 |
|---|---|---|
| `bg` | 背景 | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` |
| `char` | キャラクター画像 | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` |
| `image` | 一般画像 | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` |
| `bgm` | BGM | `.wav`, `.ogg`, `.mp3`, `.flac` |
| `se` | 効果音 | `.wav`, `.ogg`, `.mp3`, `.flac` |
| `voice` | ボイス | `.wav`, `.ogg`, `.mp3`, `.flac` |
| `video` | 動画 | `.mp4`, `.webm` |

パスは相対パスに限る。ドライブ名から始まるパス、先頭が `/` または `\\` のパス、`..` を含むパスは禁止される。型検査では拡張子を、プロジェクト検証ではファイルの存在とアセットルート内に収まることを確認する。

アセットIDは変更不能な専用参照であり、通常の `str` 変数として参照・代入しない。

## 6. キャラクター

キャラクターは、状態フィールドとポーズ画像をまとめた専用オブジェクトとして宣言する。

```tds
character ayase {
  name = "綾瀬"
  affection = 0
  route = "common"

  pose normal = "asset/char/ayase/normal.png"
  pose smile = "asset/char/ayase/smile.png"
  pose sad = "asset/char/ayase/sad.png"
}
```

### 6.1 状態フィールド

- `name` は必須で、`str` 定数でなければならない。
- そのほかのフィールドも `int` または `str` の定数で初期化する。
- フィールドの初期値に変数参照、関数呼び出し、辞書は使用できない。
- 同じキャラクター内でフィールド名を重複できない。
- キャラクターは暗黙の変更可能なグローバルオブジェクトになる。
- 状態は `goto` によるファイル遷移後も維持される。

```tds
set ayase.affection = ayase.affection + 1
say narrator "好感度: {ayase.affection}"
say ayase "私の表示名は name フィールドから取得されます"
```

`say ayase ...` の画面上の話者名には `ayase.name` が使われる。

### 6.2 ポーズ

ポーズは必ず `pose` を付けて宣言する。

```tds
pose smile = "asset/char/ayase/smile.png"
```

ポーズ名は同じキャラクター内で重複できない。パスには `char` と同じ画像拡張子制約が適用される。ポーズは通常の状態フィールドではないため、`ayase.smile` を一般式として読み書きすることはできない。`show` の中ではキャラクターとポーズを表す専用参照として解釈される。

## 7. 型、変数、const

すべての変数宣言には型と初期値が必要である。

```tds
int score = 0
str player_name = "主人公"
const int max_score = 100
const str title = "Twilight Letter"
```

構文は次のとおり。

```text
int <name> = <int-expression>
str <name> = <str-expression>
dict[int] <name> = <dictionary-expression>
dict[str] <name> = <dictionary-expression>
const <type> <name> = <expression>
```

`const` は宣言後に変更できない。辞書やstructを `const` にした場合、その要素やフィールドも `set`、`unset` で変更できない。

constの制約はファイル遷移後も維持される。分岐後に共有される変数が到達可能な分岐のいずれかでconstなら、その変数への変更は静的エラーになる。関数引数や関数ローカルが同名のグローバルを隠す場合、ローカル側の宣言に従う。

同じスコープでの再宣言、およびシナリオ変数と衝突する再宣言は禁止される。

## 8. 辞書とstruct

### 8.1 辞書

辞書のキーは常に `str`。型引数は値の型を表す。

```tds
dict[int] stats = {
  "hp": 100,
  "affection": 0
}

dict[str] labels = {
  "heroine": "綾瀬",
  "narrator": "語り手"
}
```

辞書の値はすべて宣言した型に一致させる。辞書のネスト、struct値、`any` は使用できない。

空の辞書 `{}` は、宣言・代入先・関数引数・戻り値で指定された辞書型を使う。`dict[str] labels = {}` も有効。

辞書・struct・キャラクター状態は値としてコピーされる。変数への代入、関数引数、戻り値で元のオブジェクトとの参照共有は行わない。コピーを変更しても元の値は変わらず、constの値から作った変更可能なコピーも元のconstを変更しない。

```tds
set stats["hp"] = stats["hp"] - 10
unset stats["hp"]
```

- 参照・更新・削除時のキーは `str` でなければならない。
- 存在しないキーの参照と削除は実行時エラーになる。
- `set` は新しい辞書キーの追加にも使用できる。

### 8.2 struct

```tds
struct User {
  name: str
  age: int
}

User user = {
  "name": "太郎",
  "age": 20
}

set user.age = user.age + 1
say narrator "{user.name}: {user.age}"
```

- structフィールド型は `int` または `str`。
- 初期値は辞書形式で指定する。
- 宣言されたすべてのフィールドが必要。
- 余分なフィールド、欠けたフィールド、型の違うフィールドは静的エラー。
- フィールドは `.` で参照・更新する。
- `unset` でstructフィールドを削除することはできない。

## 9. スコープ

### 9.1 グローバル

`scene` と関数の外側にある型付き宣言、およびキャラクター状態はグローバル。ファイル遷移後も保持される。

### 9.2 関数

関数引数と関数内の宣言は、その関数呼び出し内だけで有効。呼び出された関数から呼び出し元のローカル変数は見えない。グローバル変数は参照・更新できる。

### 9.3 sceneとブロック

- `scene` 直下、およびscene内の通常の `if`、`for`、`while` ブロックでは変数を宣言できない。
- `choice` の各選択肢ブロック内では型付き変数を宣言できる。
- 選択肢内の変数は、その選択肢内だけで有効。
- `for` のループ変数はループ本体内だけで有効。
- 関数内の `if`、`elif`、`else` は独立した字句スコープを作らない。ただし分岐後に新しい変数を使用するには、すべての到達可能な分岐で同じ型として宣言されている必要がある。

名前解決は内側のローカルからグローバルへ行われる。`set` は既に存在する変更可能な値だけを更新する。

## 10. 式

### 10.1 リテラルと参照

```tds
123
-20
"文字列"
score
stats["hp"]
user.name
ayase.affection
```

### 10.2 演算子

優先順位は高い順に次のとおり。

1. 関数呼び出し、`[]`、`.`
2. 単項 `+`、単項 `-`
3. `*`、`/`、`%`
4. `+`、`-`
5. `==`、`!=`、`>`、`>=`、`<`、`<=`
6. `not`
7. `and`
8. `or`

`+` は `int + int` または `str + str`。`-`、`*`、`/`、`%` は `int` 専用。`>`、`>=`、`<`、`<=` は `int` 専用。`==` と `!=` は左右が同じ型でなければならない。

論理演算は短絡評価される。条件全体の型は内部的な `bool` でなければならない。

```tds
if score >= 10 and route == 1 {
  say narrator "特別ルート"
}

if not score == 0 {
  say narrator "得点があります"
}
```

`if score` のような暗黙の真偽値化は認めない。

### 10.3 変換

```tds
str text = str(score)
int value = int("123")
```

- `str()` は `int` を1個受け取り `str` を返す。
- `int()` は `str` を1個受け取り `int` を返す。
- 変換不能な文字列は実行時エラー。

### 10.4 整数

範囲は `-9223372036854775808` から `9223372036854775807`。除算は整数除算。0除算、0による剰余、範囲外の値、算術オーバーフローはエラーになり、ラップアラウンドしない。

## 11. 代入と削除

代入は必ず `set` を使う。

```tds
set score = score + 1
set stats["hp"] = 100
set user.age = 21
set ayase.affection = ayase.affection + 1
```

代入先は変数、辞書要素、structフィールド、キャラクター状態フィールド。代入値の型は対象の型と一致しなければならない。

`unset` は辞書要素の削除専用。

`set` は右辺を評価し、辞書要素の場合は次にキーを評価してから、その時点の対象へ書き込む。右辺やキーの関数が同じ辞書の別要素を変更しても、その変更は保持される。

```tds
unset stats["hp"]
```

## 12. 会話と文字列補間

```tds
say ayase "こんにちは"
say narrator "その日の朝。"
say none "話者欄を空にする"
say "話者省略は narrator"
say message
```

- 第1引数は宣言済みキャラクター、`narrator`、`none` のいずれか。
- 本文は `str` 式。
- 話者を省略した文字列または式は `narrator` として扱う。
- キャラクターを指定すると、画面にはそのキャラクターの `name` フィールドが表示される。

連続するセリフはブロック形式で書ける。空ブロックは禁止。

```tds
say ayase {
  "こんにちは"
  "今日もよろしくね"
}

say {
  "ナレーターの1行目"
  "ナレーターの2行目"
}
```

文字列補間は単純変数またはドット区切りのフィールド参照に対応する。

```tds
say narrator "得点は {score}"
say narrator "{user.name}: {user.age}"
say narrator "好感度は {ayase.affection}"
```

補間内に `[]`、関数呼び出し、演算式は書けない。補間対象は静的に存在確認・型検査される。辞書全体を補間した場合はJSON形式の文字列になる。

## 13. 画像、音声、動画、演出

配置位置は `left`、`center`、`right`。

### 13.1 背景とBGM

```tds
bg school
bgm peaceful
clear bg
clear bgm
```

`bg` と `bgm` は、それぞれ一致する種類のアセットIDを1個取る。

### 13.2 キャラクター表示

現在の標準構文は次の形式。

```tds
show ayase.normal center
show ayase.smile left fade 300
hide ayase
hide ayase fade 300
clear char ayase
```

- `show <character>.<pose> <position>` はキャラクターを表示する。
- 既に表示中なら、同じ命令で位置とポーズを更新する。
- `fade <int>` を付けるとフェードインする。
- `hide` は必要ならフェードアウトしてから表示を解除する。
- `clear char` はフェードせず即時に表示を解除する。

次の旧形式も互換性のため受理されるが、新規コードでは使用しない。

```tds
show ayase at center pose normal
show char ayase center normal
char ayase center smile
hide char ayase
```

旧 `char` は表示中キャラクターの更新用で、未表示の場合は実行時エラーになる。

### 13.3 一般画像

```tds
show image logo center
clear image logo
```

一般画像の `show image` は画像IDと位置を必須とし、現在は `fade` を受け付けない。

### 13.4 音声と動画

```tds
play se door
play voice greeting
play bgm peaceful
play video opening blocking
play video opening async
play video opening
```

- `se`、`voice`、`bgm` は種別と一致するアセットIDを取る。
- 動画のモードは `blocking` または `async`。
- `blocking` は終了まで待つ。
- `async` またはモード省略は、動画と並行して次の命令へ進む。

### 13.5 待機と画面効果

```tds
wait 1000
wait wait_time
effect fade black 500
effect fade white
```

- 時間はミリ秒単位の `int`。
- `effect` の色は `black` または `white`。
- `effect fade` の時間を省略した場合は500 ms。

## 14. 条件分岐

```tds
if score >= 10 {
  say narrator "合格"
} elif score >= 5 {
  say narrator "あと少し"
} else {
  say narrator "不合格"
}
```

条件には比較式または比較式を組み合わせた論理式が必要。`elif` と `else` は直前の `if` ブロックに続けて書く。

静的解析は、定数条件、前の分岐に含まれる条件、重複条件、常に到達不能な分岐を検出する。

## 15. 選択肢

```tds
choice "どうしますか？" {
  "話す" {
    say ayase "こんにちは"
    int local_score = 1
    set score = score + local_score
  }
  "帰る" {
    goto ending
  }
}
```

- 質問文は省略可能で、指定する場合は `str` 式。
- 選択肢を1個以上必要とする。
- ラベルは `str` 式。
- 選択肢ブロックでは通常命令、変数宣言、関数呼び出し、`goto` を使用できる。
- 選択肢内で宣言した変数は、その選択肢内だけで有効。
- `choice` は関数内では使用できない。

## 16. ループ

### 16.1 for

```tds
for i from 0 to 10 {
  say narrator "{i}"
}

for i from 10 to 0 step -1 {
  say narrator "{i}"
}
```

- 開始値、終了値、`step` は `int`。
- 開始値と終了値の両端を含む。
- `step` 省略時は `1`。
- `step == 0`、または終了値へ進めない符号の `step` は実行時エラー。
- 反復上限は100,000回。

### 16.2 while

```tds
while score < 100 {
  set score = score + 1
}
```

条件は比較式または論理式。反復上限は100,000回。常に真で後続へ進まないループや、常に偽のループ本体は静的解析の対象になる。

## 17. 関数

```tds
fn add_affection(value: int) -> none {
  set ayase.affection = ayase.affection + value
}

fn calculate(a: int, b: int) -> int {
  return a + b
}

add_affection(1)
int result = calculate(3, 4)
```

- 引数は `<name>: <type>` の順。
- 戻り値型は `-> <type>` で指定する。
- 戻り値型には `none` も指定できる。
- 引数と戻り値には `int`、`str`、辞書型、名前付きstruct型を使用できる。
- 関数呼び出しは式にも単独文にもできる。
- 引数の個数と型は静的検査される。
- `none` 関数は値を返せない。
- 非 `none` 関数はすべての経路で値を返す必要がある。
- 直接再帰と間接再帰は禁止。
- 関数内では `choice` と `goto` を使用できない。
- `return` は関数内だけで使用できる。

## 18. シーンとgoto

```tds
scene prologue {
  say narrator "物語が始まる"
  goto chapter1
  say narrator "ここには到達しない"
}

scene chapter1 {
  say narrator "第一章"
}
```

- 同じファイル内の `goto chapter1` は宣言済みシーンを参照する。
- `.tds`、`.txt`、`/` を含む対象は外部ファイル遷移として扱われる。
- `goto` が実行されると現在の命令列を終了し、遷移先へ移る。
- `goto` より後ろの同じ経路にある命令は到達不能。
- `goto` は関数内では使用できない。
- sceneを持つファイルでは、トップレベルの `choice` と `goto` は使用できない。

## 19. 静的検査と診断

### 19.1 エラー

主に次を実行前エラーとして検出する。

- 構文エラー
- 未定義変数、関数、ローカルシーン、キャラクター、ポーズ、アセット
- 再宣言と重複定義
- 型不一致
- 不正な命令引数
- 不正なアセットパスと拡張子
- 64 bit範囲外の定数式
- 関数の再帰
- 戻り値不足
- ファイル間でのグローバル変数の初期化順違反

型検査と構文検査は、回復可能な場合は最初の問題で停止せず、下の行にある独立した問題も左下の問題一覧へ列挙する。

### 19.2 警告・情報

静的解析は次を報告する。

- 定数条件
- 重複条件、包含済み条件、到達不能分岐
- `goto`、`return`、確定終了する分岐やループ後の到達不能コード
- 開始シーンから到達できないシーン
- 常に真または常に偽のループ
- 0による除算・剰余が確定する式
- 自己代入
- 未使用の関数引数・関数ローカル変数

到達不能な連続行は、問題一覧と左下の到達不能表示で `a-b line` にまとめる。到達不能部分は灰色表示にし、波線は引かない。

## 20. プロジェクトのコンパイル

エディターの「コンパイル」は、現在のファイルだけでなくプロジェクト内の全 `.tds` / `.txt` ファイルを精査する。

1. 全ファイルの構文を検査する。
2. 型、参照、到達可能性、命令引数を検査する。
3. 全アセットの存在と安全なパスを検証する。
4. グローバル変数とキャラクター定義のファイル間契約を検証する。
5. 到達不能ファイルを含む全シナリオをパッケージへ収録する。
6. ブラウザーとネイティブで共通利用できる `.nsp.json` を生成する。

アセットエラーを含む問題一覧の項目はクリックでき、該当ファイル・行へ移動する。

## 21. 標準構文の完成例

```tds
asset bg school = "asset/bg/school.jpg"
asset bgm peaceful = "asset/bgm/peaceful.ogg"
asset se door = "asset/se/door.wav"

character ayase {
  name = "綾瀬"
  affection = 0

  pose normal = "asset/char/ayase/normal.png"
  pose smile = "asset/char/ayase/smile.png"
}

int day = 1
int flags = 0
const str version = "1.0"

fn add_affection(value: int) -> none {
  set ayase.affection = ayase.affection + value
}

scene main {
  bg school
  bgm peaceful
  show ayase.normal center
  play se door

  say ayase {
    "おはよう。"
    "今日も来てくれたんだね。"
  }

  choice "どう答える？" {
    "もちろん" {
      set flags = flags + 1
      add_affection(1)
      show ayase.smile center
    }
    "今日は帰る" {
      say ayase "また明日ね。"
    }
  }

  if flags == 1 and ayase.affection > 0 {
    say narrator "好感度は {ayase.affection}"
  } else {
    say narrator "別のルートです"
  }

  hide ayase fade 300
  goto ending
}

scene ending {
  say narrator "完"
  clear bg
  clear bgm
}
```

## 22. 識別子禁止語、宣言語、固定語

次の語は識別子として使用できない。

```text
scene asset character struct pose include
int str dict none
set unset
say bg bgm char show at hide image clear play effect wait
if elif else and or not
choice for from to step while
fn return goto
async blocking voice video
```

`const` も宣言の先頭で特別な意味を持つ構文語である。ただし現在のパーサーでは識別子禁止語の集合には含まれていないため、宣言先頭以外では識別子として解析され得る。混乱を避けるため、名前には使用しない。

命令内で意味が固定される語には次がある。

```text
narrator left center right fade black white se
```

標準の新規コードでは、キャラクター表示に `show <character>.<pose> <position>`、退場に `hide <character>` を使用する。
