# Novel Script DSL 仕様案

## 1. 目的と方針

Novel Script は、ノベルゲームの本文、分岐、画面演出を記述するための型付きスクリプト言語である。C++ のような明示的なブロックと型を持ち、Python のように余計な記号を減らす。

- 1 行は 1 命令またはブロック境界
- セミコロンは使わない
- インデントは表示上の慣習であり、構文ではない
- ブロックは `{` と `}` で表す
- `<>` は構文に使わない
- 型は初期仕様では `int`、`str`、`dict` のみ
- 素材は通常変数と分離した変更不能な `asset` として宣言する
- 本文中の変数補間だけ `{name}` を使う
- 画面・音声・選択肢は専用命令で表す

## 2. 字句規則

### 2.1 コメントと行

空行は無視する。文字列の外側にある `#` から行末まではコメントである。

```text
# コメント
say heroine "こんにちは" # 行末コメント
say narrator "# は本文"
```

文字列内の `#`、`{`、`}` は構文として扱わない。

### 2.2 識別子

変数名、関数名、シーン名、アセット ID は次の識別子で表す。

```text
[A-Za-z_][A-Za-z0-9_]*
```

背景や立ち絵などのアセット ID、話者 ID、位置・表情などの列挙値は裸の識別子で書く。実行時の文字列値は引用符で囲む。

```text
bg school
char heroine center smile
say heroine "学校へ行く"
```

### 2.3 改行

通常、改行は命令の終端である。ただし、辞書リテラルの `{}` の内部では改行を無視し、辞書の終端 `}` まで同じ式として扱う。ブロックの `{}` と辞書リテラルの `{}` は、出現する文脈によって区別する。

## 3. アセット

アセットはファイルパスを持つ変更不能な専用参照である。`str` 変数には代入できず、`set` で変更することもできない。

```text
asset bg school = "assets/bg/school.jpg"
asset bgm peaceful = "assets/bgm/peaceful.ogg"
asset se door = "assets/se/door.wav"
asset voice heroine_greeting = "assets/voice/heroine_greeting.wav"
asset video opening = "assets/video/opening.mp4"
asset image logo = "assets/image/logo.png"
```

アセットの内部型は種類ごとに異なる。

```text
AssetRef<bg>
AssetRef<bgm>
AssetRef<se>
AssetRef<voice>
AssetRef<video>
AssetRef<image>
```

アセットの種類と命令は一致しなければならない。

```text
bg school                 # OK
bg peaceful               # 静的エラー: bgm は背景に使えない
bgm peaceful              # OK
play se door              # OK
play bgm door             # 静的エラー: se はBGMに使えない
show image logo center    # OK
```

パスはプロジェクトのアセットルートからの相対パスに限定する。`..` によるルート外への移動は禁止する。アセットの宣言時またはコンパイル時に、ファイルの存在と拡張子を検証する。

- `bg`、`char`、`image`: `.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`
- `bgm`、`se`、`voice`: `.wav`、`.ogg`、`.mp3`、`.flac`
- `video`: `.mp4`、`.webm`

### 3.1 キャラクター

キャラクターは、表情名と `char` 型アセットをまとめた定義である。シナリオ側ではファイルパスを意識しない。

```text
character heroine {
    normal = "assets/chara/heroine/normal.png"
    smile = "assets/chara/heroine/smile.png"
    sad = "assets/chara/heroine/sad.png"
}
```

各表情の値は `AssetRef<char>` として扱う。同じキャラクターの定義内で表情名を重複させることはできない。

```text
char heroine center normal
char heroine center smile
```

未定義のキャラクターや表情は静的エラーにする。

### 3.2 アセット命令

```text
bg school
bgm peaceful
show image logo center
show char heroine center normal
hide char heroine
play se door
play voice heroine_greeting
play video opening blocking
clear bg
clear bgm
clear image logo
clear char heroine
```

`show image` は画像を指定位置に表示する。`show char` は未登場のキャラクターを指定位置・表情で登場させる。`char` は登場中のキャラクターの位置・表情を更新する。`hide char` は退場演出を伴う削除、`clear char` は演出なしの即時削除とする。`clear image` は指定画像を解除する。`bg`、`bgm`、`char`、`show image`、`show char`、`play` の引数は対応する型のアセット参照でなければならない。

登場・退場演出を指定する場合は、末尾に演出名と時間を追加できる。

```text
show char heroine center normal fade 300
hide char heroine fade 300
```

初期仕様で使用できる演出名は `fade` とする。演出を省略した場合は即時に状態を変更する。

## 4. リテラルと補間

```text
123             # int
-20             # int
"文字列"        # str
```

文字列では `\\`、`\"`、`\n` を使用できる。文字列内の `{name}` は、単純な変数名の値を文字列化して補間する。補間の内部に辞書参照、関数呼び出し、演算式は書けない。

```text
say narrator "現在の得点は {score} 点です"
```

## 5. 型と変数

型は変数名の後ろに `:` で指定する。変数は宣言してから使用する。

```text
int score = 0
str player_name = "主人公"
int route = 0
```

変更しない値は `const` で宣言する。`const` は型と初期値が必須で、以後 `set` や辞書要素の更新はできない。

```text
const int max_score = 100
const str title = "Prologue"
```

初期値を省略した場合、`int` は `0`、`str` は空文字列になる。

`bool`、`float`、配列は初期仕様では提供しない。条件式の結果は内部的な真偽値であり、変数型としての `bool` は持たない。

### 5.1 辞書

辞書は常に文字列キーを持ち、型引数は値の型だけを指定する。初期仕様では辞書のネストと `any` 型を禁止する。

```text
dict[int] stats = {
    "hp": 100,
    "affection": 0
}

dict[str] labels = {
    "heroine": "ミサキ"
}

名前付きフィールドを持つ値は `struct` で定義する。
```tds
struct User {
  name: str
  age: int
}
User user = { "name": "太郎", "age": 20 }
set user.age = 21
say "{user.name}"
```
```

辞書要素は `[]` で参照・更新する。

```text
set stats["hp"] = stats["hp"] - 10
set stats["affection"] = stats["affection"] + 1
set heroine_name = labels["heroine"]
say narrator "{heroine_name}"
```

存在しないキーの参照、キー型の不一致、値型の不一致はエラーにする。要素削除は `unset` を使う。

```text
unset stats["hp"]
```

### 5.2 スコープ

変数スコープはグローバル、関数ローカル、選択肢（choice）ブロックローカル、ループ変数の4層とする。

- `scene` の外側に書いた型付き宣言はグローバル変数で、`goto` 後も維持する
- `scene` 直下での変数宣言は禁止する
- 関数の引数と関数内の型付き宣言は関数ローカル
- `choice` の各選択肢ブロック内の型付き宣言はその選択肢ブロック内だけで有効なローカル変数
- `for` のループ変数はループ内だけ有効
- `if`、`elif`、`else`、`while` は新しい変数スコープを作らない
- 同じスコープでの再宣言は禁止
- 名前解決は、ループ変数、選択肢ローカル、関数ローカル、グローバル変数、組み込みの順に行う
- `set` は名前解決で見つかった既存の変更可能な変数へ代入する。`const` 変数は変更できない

グローバル変数と関数は、最初の `scene` より前に宣言する。

```text
int score = 0
int route = 0
int next_score = 0

fn add_score(value: int) -> none {
    set score = score + value
}

scene prologue {
    add_score(1)
}
```

## 6. 式と代入

代入は必ず `set <assignable> = <expression>` と書く。代入先は通常の変数、または辞書要素である。

```text
assignable := identifier
            | identifier "[" str_expression "]"
```

```text
set score = 10
set stats["hp"] = stats["hp"] - 10
```

式は通常の中置記法を使い、演算子の優先順位も一般的な算術規則に従う。

```text
set score = 10
set score = score + 1
set total = a + b * 2
set x = -x
set message = "こんにちは、" + player_name
```

利用できる算術演算子は `+`、`-`、`*`、`/`、`%`。`+` は数値の加算、または文字列連結に使う。

変換は関数形式で書く。

```text
set score_text = str(score)
set score = int(score_text)
```

`int` は符号付き64bit整数で、範囲は `-2^63` から `2^63 - 1` までとする。`/` は整数除算とする。0 除算、型不一致、変換不能な `int` 化、算術オーバーフローは実行時エラーにする。オーバーフロー時にラップアラウンドは行わない。

## 7. 条件分岐

```text
if score >= 10 {
    say narrator "合格です"
} elif score >= 5 {
    say narrator "あと少しです"
} else {
    say narrator "不合格です"
}
```

比較演算子は `==`、`!=`、`>`、`>=`、`<`、`<=`。比較する値の型は一致しなければならない。

論理演算子として `not`、`and`、`or` を使用できる。優先順位は高い順に `not`、`and`、`or` とする。評価は短絡評価で行う。

```text
if score >= 10 and route == 1 {
    say narrator "特別ルート"
}

if (score < 5 or route == 2) and not finished == 1 {
    say narrator "イベント発生"
}
```

条件式の左右には比較式が必要であり、`if score` のような暗黙の真偽値化は認めない。`and`、`or`、`not` は値の式では使用できない。

```text
condition := comparison
           | "not" condition
           | condition "and" condition
           | condition "or" condition
           | "(" condition ")"

comparison := expression comparison_operator expression
```

括弧を使って優先順位を明示できる。

```text
if score >= 10 {
    if route == 1 {
        say narrator "特別ルート"
    }
}
```

## 8. シーン

スクリプトは 1 つ以上の `scene` で構成する。シーン名は識別子である。

```text
scene prologue {
    say narrator "物語が始まる。"
    goto chapter1
}

scene chapter1 {
    say narrator "第一章。"
}
```

`goto` は指定シーンの先頭から実行を開始し、現在シーンの残りの命令は実行しない。存在しないシーンへの `goto` は実行前エラーにする。

命令は次のカテゴリに分ける。

- 制御命令: `if`、`elif`、`else`、`for`、`while`、`fn`、関数呼び出し、`return`
- ゲーム状態命令: `say`、`bg`、`bgm`、`show`、`char`、`hide`、`clear`、`play`、`effect`、`wait`
- シーン制御命令: `choice`、`goto`
- データ命令: 型付き宣言、`const`、`set`、`unset`

ゲーム状態命令は `scene` と関数の両方で使用できる。シーン制御命令は `scene` 本体でのみ使用できる。

## 9. 会話

```text
say heroine "こんにちは、{player_name}さん"
say narrator "その日の朝。"
say none "画面に文字だけ表示する"
```

`say` は話者と発言本文を指定する。第 1 引数は話者 ID、または話者なしを表す `none`。第 2 引数は `str` 式である。話者を省略して `say "本文"` と書いた場合は、ナレーター（`say narrator "本文"`）として扱う。

連続して表示する場合はブロック形式を使える。各行が 1 回ずつ表示される。
```tds
say heroine {
  "こんにちは"
  "今日もよろしくね"
}
say {
  "これはナレーター"
  "話者を省略したブロック"
}
```

## 10. 画面状態と演出

```text
bg school
bgm peaceful
char heroine center normal
char heroine center smile

clear bg
clear bgm
clear char heroine
```

`char` を同じキャラクターに再実行した場合は、位置と表情を更新する。`clear` は画面状態だけを解除し、変数には使わない。

```text
play se Door_open
play video opening blocking
play video opening async
wait 1000
wait wait_time
effect fade black 500
effect fade white
```

- `play se` は再生を開始して次へ進む
- `blocking` は動画終了まで待機する
- `async` は動画と並行して次へ進む
- `effect fade` の時間省略時はエンジンの既定値を使う

## 11. 選択肢

選択肢は `scene` 本体の命令としてのみ使用できる。最初に表示文を指定し、その中に選択肢ごとの処理ブロックを書く。選択肢のラベルは `str` 式でなければならない。選択肢ブロック内では通常の命令を実行できる。

```text
scene choice_example {
    choice "どちらへ進みますか？" {
        "学校へ行く" {
            goto school
        }
        "家へ帰る" {
            goto home
        }
    }
}
```

質問文は省略できる。

```text
scene yes_no {
    choice "どうしますか？" {
        "はい" {
            say "はいを選びました"
            set score = score + 1
        }
        "いいえ" {
            say "いいえを選びました"
        }
    }
}
```

選択肢内では `say`、`set`、型付き宣言、関数呼び出しなどの命令を使用できる。`goto` は scene 本体と同じ制約に従う。選択肢ブロックの変数は、そのブロック内だけで有効とする。

## 12. ループ

`for` の開始値と終了値は両端を含む。`step` を省略した場合は `1`。

```text
for i from 0 to 10 step 1 {
    say narrator "{i} 回目です"
}

for i from 10 to 0 step -1 {
    say narrator "{i}"
}
```

`step` が 0、または終了値へ進めない方向の場合はエラーにする。

```text
while score < 100 {
    set score = score + 1
}
```

全ループには最大反復回数を設け、超過時は実行時エラーにする。

## 13. 関数

関数は引数名の後ろに型、戻り値の前に `->` を書く。

```text
fn add_score(value: int) -> none {
    set score = score + value
}

fn calculate(a: int, b: int) -> int {
    return a + b
}
```

関数呼び出しは式として扱う。戻り値を使わない関数呼び出しは単独行に書ける。

```text
add_score(10)
set result = calculate(3, 4)
```

`none` 関数が値を返すこと、値を返す関数が値を返さず終了することはエラーにする。

関数はサブルーチンとして扱う。関数内では `say`、`bg`、`bgm`、`char`、`clear`、`play`、`effect`、`wait`、`set`、`unset`、および再帰でない関数呼び出しを使用できる。

`goto` と `choice` は `scene` 本体でのみ使用でき、関数内では禁止する。`return` は関数内でのみ使用でき、`scene` 本体では禁止する。

関数の直接再帰・間接再帰は禁止する。パーサは関数の呼び出しグラフを作り、閉路があれば静的エラーにする。

## 14. 完成例

```text
asset bg school = "assets/bg/school.jpg"
asset bgm peaceful = "assets/bgm/peaceful.ogg"
asset se door = "assets/se/door.wav"

character heroine {
    normal = "assets/chara/heroine/normal.png"
    smile = "assets/chara/heroine/smile.png"
    sad = "assets/chara/heroine/sad.png"
}

str player_name = "主人公"
int score = 0
int route = 0

scene prologue {
    bg school
    bgm peaceful
    show char heroine center normal

    say heroine "こんにちは、{player_name}さん"
    say narrator "どう答えますか？"

    choice "どう答えますか？" {
        "挨拶を返す" {
            say "よろしくお願いします"
        }
        "黙っている" {
            say "..."
        }
    }

    if score >= 1 {
        char heroine center smile
        say heroine "今日はいい天気ですね"
        set score = score + 1
    } else {
        char heroine center sad
        say narrator "気まずい沈黙が流れた。"
    }

    say narrator "現在の得点は {score} 点です。"
    wait 1000
    hide char heroine
    effect fade black 500
    goto chapter1
}

scene chapter1 {
    say narrator "第一章が始まる。"
}
```

## 15. 予約語

`scene`、`asset`、`character`、`const`、`set`、`unset`、`say`、`bg`、`bgm`、`char`、`show`、`hide`、`image`、`clear`、`play`、`effect`、`wait`、`if`、`elif`、`else`、`and`、`or`、`not`、`choice`、`for`、`from`、`to`、`step`、`while`、`fn`、`return`、`goto`、`none`、`int`、`str`、`dict`、`async`、`blocking`、`voice`、`video`。

## 16. パーサと検証

パーサは次の順に処理する。

1. 文字列リテラルを保持したまま、文字列外のコメントを除去する
2. 文字列、整数、識別子、変数補間、演算子、ブロック境界をトークン化する
3. `scene`、`character`、分岐、ループ、関数、選択肢を共通のブロックスタックで解析する
4. アセットのパス、種類、拡張子、変数、辞書のキー型、関数、シーン、命令引数を実行前に検証する
5. 実行時エラーにはシーン名、行番号、命令名を含める

未定義変数、再宣言、型不一致、存在しない関数・シーンは静的エラーとする。0 除算、変換失敗、キー不在、アセット読み込み失敗、ループ上限超過は実行時エラーとする。
