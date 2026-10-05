# .tds 文法とエディタ作法

この文書は Parser、Checker、Browser/Native Player、IDE の現在仕様に合わせたガイドです。

## プロジェクト

推奨構成:

~~~text
Project/
  setting.txt
  senario/main.tds
  asset/{bg,char,bgm,se,voice,video,image}/
  .novel/
~~~

setting.txt:

~~~text
scenario_dir = senario
asset_dir = asset
start_file = main.tds
title = My Novel
~~~

パスはプロジェクトルートからの相対パスです。絶対パス、.. による脱出、プロジェクト外のリンク参照は使えません。シナリオ拡張子は .tds のみです。

### ファイルの置き方

作品の正本は、エディター本体とは別の作品フォルダーに置きます。標準構成は次のとおりです。`scenario_dir` と `asset_dir` は変更できますが、設定値と実際のフォルダー名を一致させてください。

~~~text
Project/
  setting.txt                 # 作品ルートの設定。必須
  senario/                    # scenario_dir。シナリオ本体
    main.tds                  # start_file。最初にパッケージする入口
    common.tds                # include対象
    chapter/
      first.tds
  asset/                      # asset_dir。素材の実体
    bg/                       # 背景画像
    char/                     # 立ち絵
    image/                    # 一般画像
    bgm/                      # BGM
    se/                       # 効果音
    voice/                    # ボイス
    video/                    # 動画
  .novel/                     # エディターが生成する管理領域
    variables.json            # 変数テーブルと解析結果
    assets.json               # 素材索引
    *.schema.json             # メタデータの形式
    build/                    # パッケージ出力
~~~

`Edit/`、`src/`、`dist/`、`native/` はエディター/コンパイラ側のファイルであり、作品フォルダーへコピーして編集しません。`.novel/` は手編集の正本ではなく生成物です。作品を移動・配布するときは、`setting.txt`、シナリオ、素材を保持し、`.novel/build` は再生成できます。

配置と基準ディレクトリは次のように分かれます。

| 対象 | DSLでの指定例 | 実ファイルの基準 |
|---|---|---|
| 宣言モジュール | `include "common.tds" as common` | `scenario_dir` |
| 標準モジュール | `include "std/math.tds" as math` | エディター同梱の予約済み `std/` |
| 外部goto | `goto "chapter/first.tds"` | `scenario_dir` |
| 素材 | `"asset/bg/classroom.png"` | 作品ルートの `asset_dir`。`asset/` を付ける表記を推奨 |
| 開始ファイル | `start_file = main.tds` | 作品ルートの `scenario_dir` |

作品内シナリオの `include` と外部 `goto` は、現在のファイルの場所ではなく `scenario_dir` を基準に解決します。`std/` で始まるincludeはエディター同梱の標準ライブラリから解決され、作品内の同名パスより優先されます。`goto next_scene` のように拡張子もパス区切りもない名前だけを指定した場合は、同じファイル内のscene名です。外部ファイルの名前には空白、空のパス要素、`.`、`..`、Windows予約名を使わないでください。

素材は `asset/` から始まる作品ルート相対パスで指定し、実体は `asset_dir` 配下に配置します。`assets/`、絶対パス、空のディレクトリ要素、`.`、`..`、末尾が空白・ドットの名前、Windows予約名、種別に合わない拡張子は診断対象です。

## 基本規則

- コマンドは原則1行1つ。
- ブロックは { } で囲み、インデントは半角スペース2個。
- セミコロンは使わない。
- # または // から行末までがコメント。
- 文字列は `"..."`。使用できる主なエスケープは `\\`（バックスラッシュ）、`\"`（引用符）、`\n`（改行）です。
- 識別子は [A-Za-z_][A-Za-z0-9_]*。
- 予約語は識別子に使えない。
- 整数は符号付き64-bit。
- say "本文" は say narrator "本文" の短縮形。

## トップレベル

推奨順序は include、asset/character/struct、global変数、fn、scene です。

~~~tds
include "functions.tds" as funcs
asset bg classroom = "asset/bg/classroom.png"
global int score = 0

fn add(a: int) -> int {
  return a + 1
}

fn next_score() -> int {
  return funcs.add(1)
}

scene main {
  say narrator "開始"
}
~~~

include は `include "functions.tds" as funcs` の形式で、必ず別名を指定します。関数は `funcs.add(1)` のように別名経由で呼び出します。引用符は省略できます。拡張子省略時は .tds が補われ、循環includeは禁止です。include先は宣言モジュールであり、シーンや実行命令は置けません。シナリオファイルへの移動には `goto "chapter/next.tds"` を使います。

`std/` は同梱標準ライブラリの予約パスです。`include "std/math.tds" as math`、`include "std/motion/walk.tds" as walk`、`include "std/text.tds" as strings`、`include "std/collections.tds" as collections` のように読み込み、別名経由で関数を呼び出します。関数一覧と引数の意味は [標準ライブラリガイド](../std/README.md) を参照してください。

## 素材

~~~tds
asset bg classroom = "asset/bg/classroom.png"
asset char hero_asset = "asset/char/hero.png"
asset image logo = "asset/image/logo.png"
asset bgm morning = "asset/bgm/morning.ogg"
asset se door = "asset/se/door.wav"
asset voice greeting = "asset/voice/greeting.ogg"
asset video opening = "asset/video/opening.mp4"
~~~

種別は bg、char、image、bgm、se、voice、video。画像は png/jpg/jpeg/webp/gif、音声は wav/ogg/mp3/flac、動画は mp4/webm を使います。

Browser は GIF の再生をブラウザーに任せます。Native は GIF の各フレームを更新し、埋め込みのループ回数を尊重します。ループ指定がない GIF は一度だけ再生され、0 回指定は無限、正数は初回の後に指定回数だけ繰り返します。

## キャラクター

~~~tds
character hero {
  name = "主人公"
  affection = 0
  route = "common"
  pose normal = "asset/char/hero/normal.png"
  pose smile = "asset/char/hero/smile.png" y_offset = -20
}
~~~

name は表示名です。その他のフィールドは `int`、`float`、`str`、`bool` の初期値、pose は立ち絵宣言です。

`pose` 宣言の画像パスの後ろに `y_offset = -20` のように書くと、その画像だけの基本Y位置を整数pxで設定できます。指定できる範囲は `-1000000`〜`1000000` です。正の値は下、負の値は上で、省略時は0です。`show` の `y+` / `y-` 指定はこの画像設定に加算されます。

## 型と変数

~~~tds
int score = 0
str route = "common"
const int max_score = 100
global int shared_score = 0
global const str title = "Novel"
~~~

変数の基本型は `int`、`float`、`str`、`bool`。複合型に `dict[T]`、`list[T]`（`T` は基本型）、宣言済みstructを使えます。`none` は関数の戻り値型専用です。変数は初期値必須で、constは変更不可です。`int` と `float` の間に暗黙変換はありません。main.tds のトップレベル変数は暗黙に共有され、それ以外のファイルから共有するには global を付けます。

~~~tds
dict[int] status = { "hp": 100, "affection": 0 }
dict[float] offsets = { "x": 0.0, "y": 0.0 }
bool route_open = false
list[str] names = ["綾瀬", "美緒"]
list[int] scores = [2, 4, 6]
for score in scores { say narrator "{score}" }
set scores = list.append(scores, 8)
list[str] fragments = text.split("a,,b", ",")
str normalized = text.normalize_space("  雨　 の  日  ")
set status["hp"] = status["hp"] - 10
unset status["affection"]

if score >= 10 and route == "common" {
  say narrator "条件成立"
}
~~~

演算子は not、単項+/-、*/%、+-、比較、and、or の順に強く結合します。floatでは `+`、`-`、`*`、`/` と数値比較を同じ型同士で使えます。`%` はint同士のみです。`true` / `false` はboolリテラルで、`null` はありません。listは同じ基本型の要素だけを保持し、添字は0始まり、`for item in list { ... }` で順に走査します。`text.split` は空要素も保持し、`text.normalize_space` は連続する対応空白をASCIIスペース1つにします。

## struct

~~~tds
struct Player {
  name: str
  coins: int
}

Player player = { "name": "ユイ", "coins": 0 }
set player.coins = player.coins + 1
say narrator "{player.name}: {player.coins}"
~~~

フィールド型は `int`、`float`、`str`、`bool`。structの入れ子、動的フィールド追加、フィールドのunsetはできません。

## 関数

~~~tds
fn add_score(amount: int) -> int {
  return score + amount
}

fn announce() -> none {
  say narrator "開始"
  return
}

set score = add_score(5)
announce()
~~~

引数と戻り値の型を明示し、再帰は使いません。

## 制御構文

~~~tds
if score >= 10 {
  say narrator "成功"
} elif score > 0 {
  say narrator "途中"
} else {
  say narrator "最初から"
}

for index from 0 to 3 step 1 {
  say narrator "{index}"
}

while score < 5 {
  set score = score + 1
}

choice "どうする？" {
  "進む" { goto next_scene }
  "待つ" { wait 500 }
}
~~~

choice はプロンプトを省略して choice { ... } とも書けます。for は from/to/step、whileは条件式を使います。過大なループや停止しない可能性のあるループは診断対象です。

~~~tds
goto "chapter/chapter2.tds"
return
return score
~~~

外部 `goto` のパスは必ず引用符で囲みます。パスは `/` に正規化され、シナリオフォルダー内に限定されます。Windows区切りを使う場合は文字列内で `\\` とエスケープしますが、`/` を推奨します。

## 演出コマンド

背景・BGM:

~~~tds
bg classroom
bgm morning
bgm morning
clear bg
clear bgm
~~~

立ち絵・画像:

~~~tds
show hero.normal center
show hero.smile left fade 250
show hero.smile left y+50
show hero.smile right x-10 y+40 fade 300
move character hero by x+5 y+5 over 300
move bg by x-8 y+4 over 500
show hero.sad far_right
hide hero
hide hero fade 250
show image logo right
clear image logo
~~~

位置は far_left、left、center、right、far_right。同じslotへのshowは置き換えです。`x+30` / `x-20` は基準位置から左右へ、`y+50` / `y-10` は上下へpx単位でずらします（x+は右、y+は下）。x/yは各1回、±1,000,000 pxまで指定でき、`fade <ms>` と併用できます。

表示中の立ち絵や設定済み背景は `move character hero by x+5 y+5 over 300` / `move bg by x-8 y+4 over 500` のように、現在位置からpx単位で移動できます。`over <ms>` を付けるとその時間をかけて動き、完了してから次の命令に進みます。時間を省略すると即時移動です。x/yはそれぞれ1回までで、累積位置は±1,000,000 px以内です。

音声・動画:

~~~tds
play se door
play voice greeting
play voice greeting blocking
play voice greeting async
play video opening
play video opening async
play bgm morning
~~~

voice は blocking なら完了待ち、async または省略時は進行を止めません。動画は省略時blockingで完了まで物語の進行と入力を止めます。動画と物語を並行させる場合だけ `async` を明記します。

待機・効果:

~~~tds
wait 500
effect fade black 300
effect fade white 300
~~~

時間はミリ秒の非負整数。effectの色はblackまたはwhiteです。

背景切替・カメラ・会話欄:

~~~tds
bg classroom fade 500
bg classroom crossfade 500
bg classroom wipe-left 500
play video rain async opacity 0.5
camera zoom 1.25 at 640 360 over 700
camera reset over 400
dialog visible false
dialog visible true
~~~

### Simultaneous timed visuals

Use `parallel { ... }` to start several timed visual commands together. The block completes after the longest animation, then the next script command runs. Supported commands are timed `bg` transitions, character `show`/`hide` fades, `move`, timed `camera` changes, and `effect fade`. Keep each target to one animation of the same property in a block.

~~~tds
parallel {
  bg classroom crossfade 600
  show sister.normal left fade 400
  camera zoom 1.08 at 640 360 over 600
}
say sister "The scene changed together."
~~~

A block accepts visual commands only; dialogue, choices, waits, assignments, and control flow stay outside it. Browser and Native playback use the same start-together, wait-for-all behavior.

### Render layers

The player has eight render categories with defaults: background `0`, video `1`, character `2`, image `3`, bottom fog `4`, dialogue and choices `5`, player controls `6`, and menus/overlays `7`. The UI Settings IDE's Layers page changes these defaults and saves them with the player UI theme. A script can also set a category while it runs:

~~~tds
layer dialogue 5.2
layer menu 7.1
~~~

Use `--layer <number>` on a displayed element to override its category default. It is supported by `bg`, `show <character>.<pose>`, `show image`, and `play video`:

~~~tds
bg classroom --layer 0.3
show sister.normal center --layer 2.2
show image sparkle center --layer 3.5
play video rain async --layer 1.4
~~~

Layer numbers range from `0` through `7.999`, with at most three decimal places. Higher values draw in front of lower values. Items with the same value keep their existing insertion order. `--only` can follow `--layer` when both options are used.

背景切替は `fade` / `crossfade` / `wipe-left` / `wipe-right` / `wipe-up` / `wipe-down` を指定できます。遷移中も次の命令へ進まず、時間はミリ秒です。動画の `opacity` は 0.0〜1.0。動画は背景より上、キャラクターより下に描画され、`async` と組み合わせると背後で物語を進行できます。`camera zoom` の焦点座標はゲーム画面（標準1280×720）のpxで、ズームは背景・動画・キャラクター・画像に適用され、会話欄とメニューUIは画面位置に残ります。`dialog visible` は会話欄と選択肢を一時的に隠し、再表示します。背景揺れなどの反復演出は専用命令を増やさず、`move` と `std/motion/effects.tds` の計算関数を組み合わせて表現します。

## 変数テーブル

`staticVariables` の `type` は `int` / `float` / `str`。`float` の `value`、`min`、`max`、`possibleValues` には有限の小数を指定できます。`min` / `max` は `int` と `float` に指定でき、`str` では使えません。整数は64-bitの正確な値を保つため、安全な整数範囲を超える値は文字列で指定してください。`int` と `float` の演算には暗黙変換がないため `float(i)` を使います。

.novel/variables.json:

~~~json
{
  "staticVariables": [
    {
      "name": "score",
      "type": "int",
      "value": "0",
      "min": "0",
      "max": "100",
      "possibleValues": ["0", "50", "100"]
    },
    {
      "name": "route",
      "type": "str",
      "value": "common",
      "possibleValues": ["common", "heroine", "bad"]
    }
  ]
}
~~~

typeはint/float/str。intは符号付き64-bit、floatは有限値です。min/maxはintまたはfloatに指定でき、strでは使えません。possibleValuesは空配列・重複不可。constant: true は変更不可。valueは制約を満たす必要があります。これらの制約はIDE、プロジェクトコンパイラ、Browser、Nativeで共有されます。

## IDEのお作法

- Ctrl+Sで保存。
- Ctrl+Z/Ctrl+YでUndo/Redo。
- Ctrl+Shift+Fで現在シーンを整形。
- 編集メニューの全シーン整形で全ファイルを整形・保存。
- Tab/Shift+Tabで選択範囲のインデントを変更。
- Enterでscene、if、choice、function等のブロック入力を補助。
- 保存、コンパイル、ページ離脱時に正規化されたソースを使用。
- 外部変更後に古い内容を保存すると競合として拒否。

整形規則は2スペース、演算子周辺の空白、括弧・カンマ・コロンの空白、else/elifの結合、CRLF/CR/Unicode改行/BOMの正規化です。文字列・コメント内の記号や辞書リテラルは保護され、何度整形しても結果は変わりません。IDEとCLIは同じ共有Lexer/CST formatterを使います。

検証の順番は、字句・構文解析、型チェック、変数/制御フロー解析、素材/シーン/プロジェクト検証です。赤い診断を先に直し、警告も意図した演出か確認します。

推奨作業順は、setting確認 → asset/character宣言 → 変数テーブル → scene/goto骨格 → 台詞/choice → 演出 → 整形/診断 → コンパイル → Browser → Native です。

## よくあるミス

~~~tds
# 未宣言asset
bg unknown_background

# 立ち絵はposeと位置が必要
show hero.normal center

# 同じslotを意図せず上書き
show hero.normal left
show heroine.normal right

# 時間は非負
wait 100

# 話者は narrator または宣言済みcharacter
say narrator "本文"
say hero "本文"
~~~
