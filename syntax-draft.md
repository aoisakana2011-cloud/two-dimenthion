# Novel Script DSL リファレンス

この文書は過去に作成したDSLの構文例・解説です。現行の受理構文と型契約は [`docs/syntax-reference.md`](docs/syntax-reference.md)、実行時の命令意味は [`docs/runtime-semantics.md`](docs/runtime-semantics.md) を参照してください。記述に差がある場合は、現行Parser/Checkerと対応テストが根拠になります。この文書だけを現行契約の根拠として使用しないでください。

## はじめに：最小の作品

まず `setting.txt` を置き、開始ファイルに次のように書く。これだけで背景、立ち絵、会話、選択肢を含む作品になる。

```text
# setting.txt
scenario_dir = senario
asset_dir = asset
start_file = main.tds
title = はじめての作品
```

```tds
# senario/main.tds
asset bg room = "asset/bg/room.jpg"

character hero {
  name = "主人公"
  pose normal = "asset/char/hero/normal.png"
}

scene main {
  # 初期画面を開き、「開始」後にこのsceneの続きへ進む。
  start()
  bg room
  show hero.normal center
  say hero "こんにちは。"

  choice "どうする？" {
    "あいさつを返す" { say narrator "会話が始まった。" }
    "立ち去る" { hide hero }
  }
  # この例では物語の区切りで初期画面へ戻る。
  start()
}
```

`asset` のパスは作品ルートから、`setting.txt` の各パスは作品ルートから指定する。`include` と外部ファイルへの `goto` は `scenario_dir` を基準にする。

表記の約束は次のとおり。

- `<...>` は置き換える部分、`[...]` は省略可能な部分、`|` は選択肢を表す。
- `int`、`str` などの型名と、`left`、`fade` などの固定語は半角・小文字で書く。
- 「構文エラー」は解析時、「型エラー」はコンパイル時、「実行時エラー」は再生中に検出される。

## 1. 基本規則

- 原則として1行に1命令を書く。
- 文末のセミコロンは使用しない。
- インデントは可読性のための慣習であり、構文上の意味を持たない。標準は半角スペース2個。
- ブロックは `{` と `}` で囲む。
- ブロック開始の `{` は、条件や宣言と同じ行にも次の行にも書ける。
- 空行は無視される。
- 改行は通常、命令の終端になる。辞書リテラル内では改行できる。
- 整数は符号付き64 bitで扱う。
- 基本型は `int`、`float`、`str`、`bool`。複合型として `dict[T]`、`list[T]`（`T` は基本型）、名前付き `struct`、キャラクターオブジェクトがある。`none` は関数の戻り値型に使えるが、値や変数の型には使えない。
- `true` と `false` は `bool` リテラル。`bool` の既定値は `false`。
- list は同じ基本型の値だけを保持する値型で、代入・引数・戻り値ではコピーされる。添字は0始まり。

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

シナリオファイルの拡張子は `.tds`。

作品フォルダーの直下には必ず `setting.txt` を置く。`scenario_dir`、`asset_dir`、`start_file` は必須項目。

```text
# すべて作品フォルダーからの相対パス。/ を使用する。
scenario_dir = senario
asset_dir = asset
start_file = main.tds
title = 作品名
```

- `scenario_dir`: `.tds` の場所。includeと外部 `goto` の基準になる。
- `asset_dir`: `asset` 宣言が参照する素材のルート。
- `start_file`: パッケージングとプレイヤーが最初に開くシナリオファイル。`.tds` を指定する。
- `title`: エディター上の作品名。省略時は作品フォルダー名。

値は作品フォルダー内の相対パスに限る。絶対パス、空要素、`.`、`..` は使えない。開始ファイルの最初の `scene` が開始sceneになる。別のsceneから始めたい場合は、そのsceneを開始ファイルの先頭に置くか、開始ファイルの先頭sceneから `goto` する。

生成される索引とbuild成果物は `.novel/` に保存される。`.novel/variables.json` と `.novel/assets.json` はIDEが更新するメタデータであり、シナリオや素材の正本ではない。`build/` 以下のパッケージは削除して再生成できる。

推奨する作品フォルダーの配置は次のとおり。

```text
Project/
  setting.txt
  senario/                 # scenario_dir
    main.tds               # start_file
    common.tds             # include対象
    chapter/first.tds
  asset/                   # asset_dir
    bg/ char/ image/ bgm/ se/ voice/ video/
  .novel/                  # IDE生成物。正本ではない
    variables.json assets.json
    *.schema.json
    build/
```

`include` と外部 `goto` は `scenario_dir` を基準にし、素材パスは作品の `asset_dir` を基準にする。作品フォルダーの外にあるファイル、シンボリックリンクやハードリンク経由のファイルは使用しない。エディター本体の `Edit/` やコンパイラの `src/`、生成済みの `dist/` を作品フォルダー内へ配置する必要はない。

1ファイルには次の要素を記述できる。

- `include`
- `asset`
- `character`
- `struct`
- グローバル変数
- 関数
- シーン
- トップレベル命令

`scene` がある場合、トップレベル命令を実行した後、そのファイルで最初に宣言されたシーンから実行する。`scene` がないファイルは、トップレベル命令をそのまま順番に実行する。

トップレベルの `asset`、`character`、`struct`、`fn`、`scene`、`include` は宣言であり、通常命令と同じ順序では実行されない。トップレベルの変数宣言・命令だけが初期化列として実行される。混在時の誤解を避けるため、記述順は次を推奨する。

1. `include`
2. `asset`、`character`、`struct`
3. グローバル変数
4. 関数
5. シーン

## 4. includeと複数ファイル

```tds
include "functions.tds" as funcs
include "chapter/common.tds" as common
include "std/math.tds" as math
include "std/motion/walk.tds" as walk
```

- importには必ず一意な別名を指定し、関数は `funcs.add(1)` のように修飾して呼び出す。
- 引用符あり・なしの両形式を使用できる。
- 拡張子を省略した参照には `.tds` が補われる。
- 絶対パスと `..` によるプロジェクト外参照は禁止される。
- includeの循環はエラーになる。
- include先は再利用宣言用モジュールで、シーンや実行命令は書けない。関数名は別名で修飾される。アセット、キャラクター、struct、global宣言は互換性のためプロジェクト共通カタログに統合される。
- モジュールのglobal宣言は依存先から初期化される。シナリオファイルへの遷移は `goto` のみで行う。
- include先の `struct` はプロジェクト統合時に型宣言として取り込まれ、include元のグローバル宣言・関数シグネチャ・関数本体から参照できる。循環includeや同名structはエラーになる。
- `std/` はエディター同梱の読み取り専用標準ライブラリ用予約パスで、作品内の `scenario_dir/std/` より優先される。`std/math.tds`、`std/motion/walk.tds`、`std/motion/effects.tds`、`std/text.tds`、`std/collections.tds` をincludeできる。

例: `include "std/math.tds" as math` の後に `math.sin(angle)`、`include "std/motion/walk.tds" as walk` の後に `walk.character("ayase", 120.0, 3, 2.0, 6.0)` または `walk.walk_x(120.0, progress)` と書く。`walk.character` の引数はキャラクター名、最終横移動量(px)、歩行周期数、時間(秒)、上下揺れ幅(px)。表示中のキャラクターだけを動かし、静的解析で存在を証明できない呼び出しにはIDE警告を出す。`std/motion/effects.tds` は `shake`、`breathe`、`hop`、`drift`、`std/text.tds` は単語分割と結合、`std/collections.tds` は文字列リストの検索・重複除去・要素除去を提供する。引数と単位の詳細は [`std/README.md`](std/README.md) を参照。

別ファイルへの遷移は `goto` で行う。

```tds
goto "chapter2.tds"
goto "chapter/chapter2.tds"
```

外部ファイルは引用符で囲んで指定する。パスに使用できる文字は、英数字、`_`、`.`、`/`、`-`。引用符で囲んでも空白は使用できない。

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

GIF は Browser ではブラウザーの標準再生、Native ではフレーム更新で表示する。両方とも埋め込みのループ回数を尊重し、ループ指定がなければ一度だけ、0 回なら無限、正数なら初回の後に指定回数だけ繰り返す。

音声の音量は `0.0`（無音）〜`1.0`（元の音量）で指定する。`bgm` / `se` / `voice` のアセット宣言には任意で基準音量を付けられる。

```tds
asset bgm peaceful = "asset/bgm/peaceful.ogg" volume 0.8
asset voice greeting = "asset/voice/greeting.ogg" volume 0.5
```

基準の優先順位は、再生命令の `volume`、シナリオ内の持続設定、アセット宣言の音量、`setting/player-ui.json` のチャンネル既定値。値は乗算ではなく、より優先度の高い指定で置き換える。再生命令だけの音量はその再生に限り、以降の基準を変更しない。

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

```text
pose smile = "asset/char/ayase/smile.png" y_offset = -20
```

構文は `pose <pose-name> = "<asset-path>" [y_offset = <signed-int-px>]`。`y_offset` は省略可能で、画像ごとの基本Y位置を整数pxで指定する。指定範囲は `-1000000`〜`1000000` で、既定値は0。正の値は下、負の値は上へ動く。`show` のY指定はこの値に加算する。

ポーズ名は同じキャラクター内で重複できない。パスには `char` と同じ画像拡張子制約が適用される。ポーズは通常の状態フィールドではないため、`ayase.smile` を一般式として読み書きすることはできない。`show` の中ではキャラクターとポーズを表す専用参照として解釈される。

## 7. 型、変数、const

すべての変数宣言には型と初期値が必要である。

```tds
int score = 0
str player_name = "主人公"
const int max_score = 100
const str title = "Twilight Letter"
global int shared_score = 0
```

構文は次のとおり。

```text
int <name> = <int-expression>
str <name> = <str-expression>
dict[int] <name> = <dictionary-expression>
dict[str] <name> = <dictionary-expression>
bool <name> = true | false
list[int|float|str|bool] <name> = <list-expression>
const <type> <name> = <expression>
global <type> <name> = <expression>
global const <type> <name> = <expression>
```

`main.tds` のトップレベル変数は、`global` を省略してもプロジェクト全体から参照できる。`main.tds` 以外の通常のトップレベル変数は、そのファイル内でのみ参照できる。別ファイルから参照する変数は `global` を付けて宣言する。`global` 宣言はファイルのトップレベルでのみ使用できる。

別ファイルの `global` 変数は、その宣言を含むファイルが実行された後に使用できる。実行前に参照できるのは型情報だけであり、build時の変数フロー検証は初期化前の参照をエラーにする。

`const` は宣言後に変更できない。辞書やstructを `const` にした場合、その要素やフィールドも `set`、`unset` で変更できない。`const` は予約語一覧には含まれない実装上の特別語なので、識別子には使わない。

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

### 型付きリスト

list は要素型を固定した順序付きの値型。要素には `int`、`float`、`str`、`bool` を使える。型を推論できない空リストは、`list[int] values = []` のように宣言側で要素型を指定する。

```tds
list[str] names = ["綾瀬", "美緒"]
global list[int] scores = [2, 4, 6]
set scores[0] = 3
for score in scores {
  say narrator "score={score}"
}
```

添字は0始まりで、範囲外の参照・更新は実行時エラー。`for name in names { ... }` は反復開始時のリスト値を順番に走査し、ループ変数は本体内だけで有効。listの代入・引数・戻り値はコピーであり、参照共有しない。

組み込み関数は `list.length(items) -> int`、`list.append(items, item) -> list[T]`、`list.contains(items, item) -> bool`。`append` は元のlistを変更せず、新しいlistを返す。

文字列処理は `text.trim(value) -> str`、`text.normalize_space(value) -> str`、`text.split(value, separator) -> list[str]`、`text.replace(value, search, replacement) -> str`。`split` は先頭・末尾・連続区切りの空要素を保持する。空の区切り文字と空の検索文字列はコンパイルエラー。

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

- structフィールド型は `int`、`float` または `str`。
- `struct` はファイルのトップレベルで宣言する。scene、関数、choice、条件ブロックの内部には書けない。同一ファイル内では前方参照も解決される。
- 未宣言の型名を変数宣言に書いてもstructとして推測しない。`User user = ...` を使うファイル自身、またはinclude依存先に必ず `struct User { ... }` を置く。
- 初期値は辞書形式で指定する。
- 宣言されたすべてのフィールドが必要。
- 余分なフィールド、欠けたフィールド、型の違うフィールドは静的エラー。
- フィールドは `.` で参照・更新する。
- `unset` でstructフィールドを削除することはできない。

### 8.3 structを使うときの考え方

`struct` は「同じまとまりとして扱う、名前付きの値の設計図」である。`struct Player` は値を作らず、`Player player = { ... }` が実際の値を作る。struct変数の宣言時は必ずこの辞書リテラル形式で初期化する。

```text
struct Player { ... }     # 型（設計図）を宣言する
Player player = { ... }   # Player 型の値を1つ作る（宣言時は必須）
```

フィールドは定義時の名前と型が固定される。辞書と違い、実行中にフィールドを追加・削除したり、別の型の値に置き換えたりはできない。その代わり `player.name` のように安全にアクセスできる。

### 8.4 宣言から更新までの完全例

型宣言は利用箇所より前、かつトップレベルに置く。初期化の `{ ... }` には全フィールドをちょうど1回ずつ書く。

```tds
struct Player {
  name: str
  level: int
  coins: int
}

Player player = {
  "name": "ユイ",
  "level": 1,
  "coins": 50
}

set player.coins = player.coins + 10
set player.level = player.level + 1
say narrator "{player.name} は Lv.{player.level}、所持金 {player.coins}"
```

読み取りは式として使える。代入先にできるのは既存フィールドだけで、`set player.rank = 1` のように新しいフィールドを追加することはできない。

```tds
if player.coins >= 100 {
  say narrator "買い物できます"
}

str display_name = player.name + "さん"
```

### 8.5 関数へ渡す・関数から返す

名前付きstructは関数の引数と戻り値にも指定できる。struct値は値渡しなので、関数内で引数を変更しても呼び出し元の値は変化しない。変更結果を使いたい場合は、戻り値を受け取って明示的に代入する。struct変数の宣言時には辞書リテラルが必要なため、戻り値を受ける変数もまず初期値を作ってから `set` する。

```tds
struct Player {
  name: str
  coins: int
}

fn add_coins(target: Player, amount: int) -> Player {
  set target.coins = target.coins + amount
  return target
}

Player player = { "name": "ユイ", "coins": 50 }
Player rewarded = { "name": "", "coins": 0 }
set rewarded = add_coins(player, 10)

say narrator "元の所持金: {player.coins}"
say narrator "報酬後の所持金: {rewarded.coins}"
```

上の例では `player.coins` は `50` のまま、`rewarded.coins` は `60` になる。元の変数を更新したいなら `set player = add_coins(player, 10)` と書ける。

### 8.6 代入とconst

struct同士の `set` による代入もコピーになる。`copy` を更新しても `original` は変わらない。`Settings copy = original` のような宣言時の代入は使えないため、コピー先を辞書リテラルで初期化してから `set copy = original` と書く。

```tds
struct Settings {
  title: str
  volume: int
}

Settings original = { "title": "本編", "volume": 80 }
Settings copy = { "title": "", "volume": 0 }
set copy = original
set copy.volume = 20

say narrator "{original.volume}"  # 80
say narrator "{copy.volume}"      # 20
```

`const Settings settings = ...` はフィールドを含めて変更不可である。`set settings.volume = 20` はエラーになる。const値を変更可能な変数へ代入した場合は、コピー先だけを変更できる。

### 8.7 許可されない形とよくあるエラー

| 書き方 | 結果 | 正しい考え方 |
|---|---|---|
| `Player p = { "name": "ユイ" }` | `coins` が不足してエラー | 全フィールドを指定する |
| `Player p = { "name": "ユイ", "coins": 1, "rank": 1 }` | 未定義フィールドでエラー | 定義にないキーは書かない |
| `Player p = { "name": 1, "coins": 1 }` | `name` の型不一致 | `str` / `int` を定義どおりにする |
| `Player copy = player` | 宣言時のstruct初期化エラー | `{ ... }` で初期化してから `set copy = player` |
| `set p.rank = 1` | 未定義フィールドでエラー | フィールド追加は不可 |
| `unset p.name` | エラー | `unset` は辞書要素専用 |
| `struct Party { leader: Player }` | 構文エラー | フィールド型は `int`、`float`、`str`、`bool` のみ |
| `dict[Player] members = ...` | 型として使用不可 | 辞書の値型は基本型のいずれか |
| `Player p = ...` を `struct Player` より前に書く | 同一ファイル内またはinclude依存先にstructがあれば有効 | structはトップレベルで宣言する |

structの入れ子、structフィールドへの辞書、辞書の値としてのstructは使用できない。structフィールド、辞書値、リスト要素には `bool` を含む基本型を使える。

### 8.8 複数ファイルで使うstruct

includeは一つのプログラムとして統合され、include先のstruct型も依存先から順に収集される。include先だけにstructを置いてinclude元から参照する書き方も使用できる。外部 `goto` 先は別プログラムなので、遷移先ファイル自身の宣言・include構成で型を解決できるようにする。

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

```text
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

`+` は `int + int`、`float + float`、または `str + str`。`-`、`*`、`/` は左右が同じ数値型（`int` 同士または `float` 同士）で使用できる。`%` は `int` 同士のみ。`>`、`>=`、`<`、`<=` は同じ数値型同士で使用できる。暗黙の `int` / `float` 変換はない。`==` と `!=` は左右が同じ型でなければならない。

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
float ratio = 0.5
float shifted = float(score) + 1e-3
int truncated = int(-shifted)
```

- `str()` は `int` または `float` を1個受け取り `str` を返す。
- `int()` は `str` または `float` を1個受け取り `int` を返す。小数は0方向へ切り捨てる。
- `float()` は `int`、`str`、`float` を1個受け取り `float` を返す。
- 変換不能な文字列は実行時エラー。

### 10.4 整数

範囲は `-9223372036854775808` から `9223372036854775807`。除算は整数除算。0除算、0による剰余、範囲外の値、算術オーバーフローはエラーになり、ラップアラウンドしない。

### 10.5 小数

`float` は有限の倍精度浮動小数点数。`0.5`、`5.0`、`1e-3` と書ける。`int` と `float` の混合演算は不可。`float(i)` で明示変換する。0除算、NaN、Infinity、範囲外の `int()` 変換は実行時エラー。大きな `int` を `float` に変換すると精度が失われる場合がある。

立ち絵と背景の位置には `x+5`、`y-20` に加えて `x+(式)`、`y-(式)` を指定できる。式は `int` または `float` で、px 単位。例: `show hero.normal left x+(float(3) * 1.5)`、`move character hero by x+(delta) over 16`。各軸は1回、絶対値は1000000 px以下。

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
say narrator message
```

- 第1引数は、指定する場合のみ、宣言済みキャラクター、`narrator`、`none` のいずれか。
- 本文は必須の `str` 式。文字列、`str` 型変数、文字列連結、`str()`、`str` を返す関数を使用できる。
- 話者を省略できるのは本文の式が文字列リテラルから始まるときだけで、その場合は `narrator` として扱う。たとえば `say "合計: " + str(score)` は有効。変数や関数呼び出しから始まる本文では `say narrator message` のように話者を明示する。
- キャラクターを指定すると、画面にはそのキャラクターの `name` フィールドが表示される。

`say` は `say <文字列リテラルで始まるstr式>` または `say <speaker> <str式>` の形で書く。複数行を表示する場合は、行ごとに `say` を書く。

文字列補間は単純変数、ドット区切りのstruct／キャラクターフィールド参照、または引数なし関数呼び出しに対応する。

```tds
say narrator "得点は {score}"
say narrator "{user.name}: {user.age}"
say narrator "好感度は {ayase.affection}"
say narrator "結果は {ending_text()}"
```

補間内に `[]`、引数付き関数呼び出し、演算式は書けない。補間関数は引数を取らず、`none` を返してはならない。補間対象は静的に存在確認・型検査される。辞書全体を補間した場合はJSON形式の文字列になる。

## 13. 画像、音声、動画、演出

配置位置は `far_left`、`left`、`center`、`right`、`far_right` の5種類。

### 13.1 背景とBGM

```tds
bg school
bgm peaceful
clear bg
clear bgm
volume bgm 0.4
dialog opacity 0.85
```

`bg` と `bgm` は、それぞれ一致する種類のアセットIDを1個取る。`volume <bgm|se|voice> <float>` は以後の同チャンネルの基準音量を変更し、`dialog opacity <float>` は以後の会話欄の背景面の不透明度を変更する。どちらも値域は `0.0`〜`1.0`。

### 13.2 キャラクター表示

現在の標準構文は次の形式。

```tds
show ayase.normal center
show ayase.smile left fade 300
show ayase.smile left y+50
show ayase.smile center x+30
show ayase.smile right x-10 y+40 fade 300
move character ayase by x+5 y+5 over 300
move bg by x-8 y+4 over 500
hide ayase
hide ayase fade 300
```

- `show <character>.<pose> <position>` はキャラクターを表示する。
- `x+30` / `x-20` / `y+50` / `y-10` でslotの基準位置からpx単位でずらす。x+は右、y+は下。x/y各1回、±1,000,000 pxまで。
- `move character <id> by [x±<px>] [y±<px>] [over <ms>]` は表示中のキャラクターを現在位置から移動する。`move bg by ...` は設定済み背景を移動する。x/yのどちらか少なくとも一方は必須で、各軸は1回まで。移動量はpx、x+は右、y+は下。指定した時間の移動は完了まで待ち、時間省略時は即時。累積位置は±1,000,000 pxまで。
- 既に表示中なら、同じ命令で位置とポーズを更新する。
- `fade <int>` を付けるとフェードインする。
- `hide` は必要ならフェードアウトしてから表示を解除する。
- キャラクターを即時に消す場合も `hide ayase` を使う。

### 13.3 一般画像

```tds
show image logo center
show image logo center --only
clear image logo
```

一般画像の `show image` は画像IDと位置を必須とし、現在は `fade` を受け付けない。`--only` を付けると、その画像だけをシーン素材として表示する（会話UIは維持）。通常の表示命令、hide、clearで解除される。画像IDの代わりに、アセット登録された画像のファイル名も指定できる。

### 13.4 音声と動画

```tds
play se door
play voice greeting
play bgm peaceful
play voice greeting volume 0.5 blocking
play bgm peaceful volume 0.8 crossfade 300
play se door volume 0.25
play video opening blocking
play video opening async
play video opening
play video opening --only
play video opening async --only
play video "op.mp4" --only
```

- `se`、`voice`、`bgm` は種別と一致するアセットIDを取る。動画はアセットIDまたは登録済み動画のファイル名を指定できる（例: `play video "op.mp4" --only`）。
- 音声再生命令には `volume <float>` を付けられる。この指定はその再生だけに適用し、`crossfade <int>` はBGMだけに指定できる。
- `say narrator "一時的に薄い会話欄" opacity 0.6` はその台詞の表示中だけ会話欄の背景面を変更し、次の台詞で通常の設定へ戻す。文字自体の透明度は変更しない。
- `voice` は `blocking` または `async` を指定でき、省略時 `async`。動画は省略時 `blocking` で、`async` を明記した場合だけ物語と並行して再生する。
- `blocking` は終了まで待つ。
- 動画の `--only` は再生中、背景・立ち絵・一般画像・会話UI・プレイヤー操作UIを隠し、動画だけを表示する。動画終了時に自動解除される。asyncでも描画は動画専有となり、次の表示命令で解除される。
- `bg <id> --only` は背景だけ、`show <character>.<pose> <position> --only` はその立ち絵だけをシーン素材として表示する。背景／キャラクター／一般画像の `--only` は後続の通常表示命令、hide、clearで解除される。
- `async` はメディアと並行して次の命令へ進む。動画がblocking中は物語の入力を受け付けず、終了後に次の命令へ進む。

再生機の `setting/player-ui.json` では `dialog.opacity` と `audio.bgm` / `audio.se` / `audio.voice` を既定値として設定する。どれも `0.0`〜`1.0`。未指定のチャンネルは1.0、voiceのみ0.5。音量の優先順位は「play行の一時指定 → シナリオのvolume設定 → アセット宣言のvolume → settingのチャンネル既定値」。`dialog.opacity` のsetting値が会話欄の初期値で、TDSの `dialog opacity` が再生中の基準を上書きする。

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

list[str] names = ["A", "B"]
for name in names {
  say narrator name
}
```

- 開始値、終了値、`step` は `int`。
- 開始値と終了値の両端を含む。
- `step` 省略時は `1`。
- `step == 0`、または終了値へ進めない符号の `step` は実行時エラー。
- 反復上限は100,000回。
- `for item in list { ... }` はlist要素型のループ変数で反復する。listが空なら本体は実行されない。

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
- 引数と戻り値には `int`、`float`、`str`、`bool`、`dict[T]`、`list[T]`、名前付きstruct型を使用できる。`T` は `int`、`float`、`str`、`bool` のいずれか。`none` は戻り値に限り使用できる。
- 関数呼び出しは式にも単独文にもできる。
- 引数の個数と型は静的検査される。
- `none` 関数は値を返せない。
- 非 `none` 関数はすべての経路で値を返す必要がある。
- 直接再帰と間接再帰は禁止。
- 関数内では `choice` と `goto` を使用できない。
- `return` は関数内だけで使用できる。

### 17.1 再生中の状態問い合わせ

`runtime.*` は、シナリオの静的な宣言ではなく、現在の再生状態を読む組み込みAPIの名前空間。
現在使用できるのはキャラクター表示状態の問い合わせだけ。

```tds
character ayase {
  name = "Ayase"
  pose normal = "asset/ayase.png"
}

scene main {
  if runtime.state.characters.exists("ayase") {
    move character "ayase" by x+8
  }
  list[str] visible = runtime.state.characters.list()
  say narrator str(list.length(visible))
}
```

- `runtime.state.characters.exists(id: str) -> bool` は、キャラクター `id` が現在いずれかの配置枠に表示中なら `true`。
- `runtime.state.characters.list() -> list[str]` は、表示中のキャラクターIDを重複なし・ID昇順で返す。返すlistは呼び出しごとの値で、実行状態そのものを変更しない。
- `runtime.state.characters.position(id: str) -> str` は、表示中の配置枠（`far_left` / `left` / `center` / `right` / `far_right`）を返す。非表示なら空文字列を返す。戻り値は呼び出し時点の状態のスナップショット。
- `runtime.state.background.exists() -> bool` / `runtime.state.background.current() -> str` は、現在の背景の有無とasset IDを返す。背景がない場合、`current()`は空文字列。
- `runtime.state.audio.bgm_exists() -> bool` / `runtime.state.audio.current_bgm() -> str` は、現在のBGM状態とasset IDを返す。BGMがない場合、`current_bgm()`は空文字列。いずれも呼び出し時点の状態を読むだけで、状態を変更しない。
- `runtime.state.execution.current_scene() -> str` / `current_file() -> str` / `current_line() -> int` は、現在実行中のシーン名・ソースファイル・行番号を返す。シーン外の初期化中は空文字列・空文字列・0。値は呼び出しを含む命令の位置である。
- `runtime.state.audio.volume(channel: str) -> float` は `bgm` / `se` / `voice` のシナリオ側チャンネル音量を返す。`volume` 命令のoverrideがあればそれを、なければ作品の初期値を返す。ユーザーのマスター音量・ミュート、個別素材のvolumeは含めない。
- `runtime.state.ui.dialog_opacity() -> float` は `dialog opacity` が設定する通常の文字欄不透明度を返す。一行限定の `say ... opacity` とユーザー側UI倍率は含めない。
- `runtime.state.variables.exists(name: str) -> bool` は現在の実行フレームから参照可能な変数かを返す。`names() -> list[str]` はその時点で参照可能なglobal/local名を重複なし・昇順で返す。後続の未実行declareは含まず、値の型や値本体を動的に取り出すAPIではない。
- キャラクター宣言済みかどうかではなく、現在表示中かどうかを判定する。未表示の宣言済みキャラクターは `exists` が `false`。
- `show` による同一枠の置換、`hide` 完了、テスト再生時の復元状態を反映する。Browser版とNative版で同じ結果になる。
- 関数内やincludeしたTDSモジュールからも呼び出せる。include aliasによる名前変換の対象ではない。
- APIの値は実行時に評価するため、グローバル初期値や分岐条件で呼び出してもコンパイル時に固定されない。
- キャラクターIDを変数から `move` に渡すときは `move character (id) by ...` のように括弧で式を明示する。従来の `move character ayase by ...` は固定IDを表す既存構文のまま。

`compile.*` は静的解析、`ide.*` はエディタ補助の領域であり、ゲーム再生中に呼ぶTDS関数ではない。現時点ではこの2つの名前空間の実行APIは定義されていない。コンパイラの警告やIDE操作を再生用スクリプトから呼び出す構文として扱わない。

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
- 外部ファイルには `goto "chapter/next.tds"` のように、引用符付きの相対パスを使う。`.tds`、`/` を含む対象は外部ファイル遷移として扱われる。
- `goto` が実行されると現在の命令列を終了し、遷移先へ移る。
- `goto` より後ろの同じ経路にある命令は到達不能。
- `goto` は関数内では使用できない。
- sceneを持つファイルでは、トップレベルの `choice` と `goto` は使用できない。

## 19. 静的検査と診断

### JSONで固定するグローバル変数

作品の `.novel/variables.json` では、シナリオ中で型が変わらないグローバル値を
`staticVariables` に宣言できる。これらは各シーンで同じグローバル変数として扱われ、
通常の `int` / `str` 変数と同じ静的型検査を受ける。`int` の64 bit境界値はJSONの丸めを
避けるため文字列で記述する。

```json
{
  "staticVariables": [
    { "name": "clear_threshold", "type": "int", "value": 10, "constant": true },
    { "name": "route_name", "type": "str", "value": "common" }
  ]
}
```

`constant: true` を指定した値は `const` と同様に `set` できない。シナリオ側で同名の
グローバルを再宣言することはできない。`variables` はエディタが生成する参照情報なので、
手で編集する対象は `staticVariables` のみとする。

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

エディターの「コンパイル」は、現在のファイルだけでなくプロジェクト内の全 `.tds` ファイルを精査する。

1. 全ファイルの構文を検査する。
2. 型、参照、到達可能性、命令引数を検査する。
3. 全アセットの存在と安全なパスを検証する。
4. グローバル変数とキャラクター定義のファイル間契約を検証する。
5. 到達不能ファイルを含む全シナリオをパッケージへ収録する。
6. ブラウザーとネイティブで共通利用できる `.nsp.json` を生成する。

アセットエラーを含む問題一覧の項目はクリックでき、該当ファイル・行へ移動する。

## 21. 命令一覧

以下は受理される命令形の一覧である。`<expr>` は式、`<str-expr>` は `str` 式、`<int-expr>` は `int` 式を表す。

| 分類 | 構文 | 制約 |
|---|---|---|
| 宣言 | `int\|float\|str\|bool <name> = <expr>` | 初期値は必須、型は一致させる |
| 宣言 | `dict[T] <name> = <dict>` / `list[T] <name> = <list>` | `T` は基本型。辞書キーは常に `str` |
| 宣言 | `const <type> <name> = <expr>` | 以後の `set` / `unset` は不可 |
| 宣言 | `global <declaration>` | ファイルのトップレベルだけ |
| キャラクター | `pose <pose-name> = "<asset-path>" [y_offset = <signed-int-px>]` | `character` ブロック内。y_offsetは省略時0、整数pxで -1000000〜1000000。正は下、負は上 |
| 更新 | `set <target> = <expr>` | target は変数、辞書要素／リスト要素、struct／キャラクターフィールド |
| 更新 | `unset <dict>[<str-expr>]` | 辞書要素だけ |
| 会話 | `say [<speaker>] <str-expr> [opacity <float>]` | speaker はキャラクター、`narrator`、`none`。opacityはこの台詞だけ |
| 背景 | `bg <bg-id> [--layer <0..7.999>] [--only]` / `bgm <bgm-id>` | 種別が一致するアセットID |
| 表示 | `show <character>.<pose> <far_left\|left\|center\|right\|far_right> [x±<px>] [y±<px>] [fade <ms>] [--layer <0..7.999>] [--only]` | 5スロットの立ち絵表示。x+は右、y+は下 |
| 表示 | `hide <character> [fade <ms>]` | キャラクターを非表示 |
| 移動 | `move character <id> by [x±<px>] [y±<px>] [over <ms>]` / `move bg by [x±<px>] [y±<px>] [over <ms>]` | x/yのいずれか必須。現在位置からの差分移動。時間付きはblocking |
| 表示 | `show image <image-id> <far_left\|left\|center\|right\|far_right> [--layer <0..7.999>] [--only]` / `clear image <image-id>` | 一般画像。fade不可。--onlyは画像だけを表示 |
| 再生 | `play se <id> [volume <float>]` / `play voice <id> [volume <float>] [character <id>] [blocking\|async]` / `play bgm <id> [volume <float>] [crossfade <int>]` | blocking／asyncはvoiceとvideoのみ。音量0.0〜1.0 |
| 音量 | `volume <bgm\|se\|voice> <float>` | チャンネルの以後の基準音量。0.0〜1.0 |
| UI | `dialog opacity <float>` | 会話欄の背景面の以後の不透明度。0.0〜1.0 |
| UI | `dialog visible <bool>` | 会話欄と選択肢の表示／非表示 |
| カメラ | `camera zoom <float> at <x:int> <y:int> [over <ms>]` / `camera reset [over <ms>]` | ズームは0.1〜8.0。焦点座標は論理画面px |
| Layer | `layer <background|video|character|image|fog|dialogue|controls|menu> <0..7.999>` / `[--layer <0..7.999>]` on `bg`, `show`, and `play video` | Category default or per-element override; 0.001 steps, higher values draw in front.
| 再生 | `play video <id> [blocking\|async] [opacity <float>] [--layer <0..7.999>] [--only]` | 省略時は `blocking`。並行再生は `async` を明記。モードはどちらか一方。--onlyは動画終了まで動画だけを表示 |
| 演出 | `parallel { <timed-visual-command> ... }` | 時間付きの背景切替、立ち絵fade、hide fade、move、camera、effect fadeを同時開始し、最長の完了を待つ |
| 演出 | `wait <int-expr>` / `effect fade <black\|white> [<int-expr>]` | 時間はミリ秒 |
| 分岐 | `if <condition> { ... } [elif <condition> { ... }] [else { ... }]` | condition は `bool` 式 |
| 選択 | `choice [<str-expr>] { <str-expr> { ... } ... }` | 1選択肢以上。関数内では不可 |
| 反復 | `for <name> from <int-expr> to <int-expr> [step <int-expr>] { ... }` | 両端を含む |
| 反復 | `for <name> in <list-expr> { ... }` | list要素型のループ変数。空listでは0回 |
| 反復 | `while <condition> { ... }` | 上限100,000反復 |
| 関数 | `fn <name>([<name>: <type>, ...]) -> <type> { ... }` | 再帰不可 |
| 遷移 | `goto <scene-name>` / `goto "<relative-file-path>"`（外部パスは必ず引用符で囲む） | 関数内では不可 |

## 22. 標準構文の完成例

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

  say ayase "おはよう。"
  say ayase "今日も来てくれたんだね。"

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

## 23. 識別子禁止語、宣言語、固定語

次の語は識別子として使用できない。

```text
scene asset character struct pose include
int float str bool dict list none global true false
set unset
say bg bgm char show at hide image clear play effect wait camera dialog
if elif else and or not
choice for from to step while
fn return goto
async blocking voice video parallel
```

`const` と `let` はこの一覧とは別に、文頭で特別に解釈される。どちらも識別子には使用しない。`let` は常にエラーである。

命令内で意味が固定される語には次がある。

```text
narrator left center right far_left far_right fade black white se
```

標準の新規コードでは、キャラクター表示に `show <character>.<pose> <position>`、退場に `hide <character>` を使用する。

## 24. 書くときのチェックリスト

1. `struct` はトップレベルで宣言したか（同一ファイル内の前方参照とinclude依存先の型公開に対応）。
2. キャラクター表示は `show name.pose far_left|left|center|right|far_right` の5スロットになっているか。
3. 会話はすべて本文付きの `say` か。
4. 外部ファイル遷移は `goto "path/file.tds"` と引用符付きか。
5. `asset` と `pose` のパスは `asset_dir` 内にあり、拡張子が用途に合うか。
6. `const` や外部 `global` を初期化前に変更・参照していないか。
7. 最後にプロジェクト全体をコンパイルして、browser と native の両方で再生を確認したか。
