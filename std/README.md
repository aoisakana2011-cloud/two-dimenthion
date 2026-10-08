# 標準ライブラリ

`std/` はエディタに同梱される read-only module です。シナリオから通常の `include` と別名で読み込みます。

## 組み込みのリスト・文字列関数

次の名前空間関数は Compiler と Browser / Native runtime に組み込まれているため、`include` は不要です。標準TDSファイルの関数とは異なり、シナリオから直接 `list.length(items)`、`text.split(value, ",")` の形で呼び出します。

| 関数 | 型 | 意味 |
|---|---|---|
| `list.length(items)` | `list[T] -> int` | 要素数（O(1)） |
| `list.append(items, item)` | `list[T], T -> list[T]` | 元listを変えず、末尾へ追加したコピーを返す（O(n)） |
| `list.contains(items, item)` | `list[T], T -> bool` | 同じ値の要素があるか（O(n)、一致位置で早期終了。要素数上限なし） |
| `list.remove_all(items, item)` | `list[T], T -> list[T]`（primitive T） | itemと一致する要素を除いた新しいlistを返す（O(n)、最大100,000要素） |
| `text.trim(value)` | `str -> str` | 対応空白のうち端にあるものだけ除去 |
| `text.normalize_space(value)` | `str -> str` | 対応空白の連続をASCIIスペース1つにまとめ、端も除去 |
| `text.split(value, separator)` | `str, str -> list[str]` | 区切りで分割し、空要素を保持 |
| `text.replace(value, search, replacement)` | `str, str, str -> str` | 全ての一致箇所をリテラル置換 |
| `text.join(items, separator)` | `list[str], str -> str` | listをseparatorで結合する（O(n)、最大100,000要素） |

空白APIが扱うのはASCIIのspace、tab、line feed、carriage return、form feed、vertical tab、no-break space (U+00A0)、ideographic space (U+3000) です。Unicode全体のWhite_Space propertyを対象にするものではありません。`list.length([])` は0、空リストに対する `list.contains` はfalseです。`text.split` の区切り文字と `text.replace` の検索文字には空文字を指定できません。値が実行時に決まる場合も、空文字はBrowser/Native両方で実行時エラーになります。splitは区切り文字列の完全一致を左から非重複で処理し、先頭・末尾・連続区切りの空要素を保持します（空入力は `[""]`）。replaceも完全一致を左から非重複で置換し、挿入したreplacementを再検索しません。どちらもUnicode正規化や大文字小文字変換はしません。`list[T]` の `T` は `int`、`float`、`str`、`bool` のいずれかです。リスト添字は0始まりで、範囲外参照は実行時エラーになります。

## TDSで書かれたデータ処理ヘルパー

低水準の `text.*` / `list.*` は組み込みAPIです。繰り返し使う高水準処理は、通常のTDS関数として同梱しています。

### `std/text.tds`

`include "std/text.tds" as strings` で読み込みます。

- `strings.split_words(value)` — 空白を正規化して単語リストにする。空白だけの入力は空リスト。
- `strings.join_words(items, separator)` — 文字列リストを区切り文字で結合する。

### `std/collections.tds`

`include "std/collections.tds" as collections` で読み込みます。

- `collections.index_of_str(items, target)` — 最初に一致した0始まり位置。ループ上限内で末尾まで検索して見つからない場合は `-1`。
- `collections.append_unique_str(items, item)` — 既存要素を重複させず追加したリストを返す。
- `collections.remove_all_str(items, item)` — 一致する要素をすべて除いたリストを返す。

`index_of_str` と `append_unique_str` は組み込みlist APIを使うTDS関数です。`remove_all_str` は `list.remove_all`、`join_words` は `text.join` に処理を委譲します。remove関数は入力listを変更せず、新しい値を返します。
`index_of_str` はTDS loopでlistを走査し、Runtimeのloopごとの100,000回上限に従います。一致すればその位置で終了するため、先頭付近の検索では100,000要素より長いlistも扱えます。`remove_all_str` と `join_words` はintrinsicで最大100,000要素を処理し、超過すると同じloop上限エラーを返します。上限は [runtime-semantics.md](../docs/runtime-semantics.md) に記載しています。

```tds
include "std/text.tds" as strings
include "std/collections.tds" as collections

list[str] names = strings.split_words("  rain　 and   roses  ")
int choice_index = collections.index_of_str(names, "and")
list[str] tags = collections.append_unique_str(names, "mystery")
str heading = strings.join_words(tags, " / ")
```

```tds
include "std/math.tds" as math

scene main {
  float bob = math.sin(math.radians(30.0)) * 12.0
  float fade = math.smoothstep(0.0, 1.0, 0.5)
  float zoom = math.lerp(1.0, 1.2, math.ease_in_out_quad(0.5))
}
```

## `std/math.tds`

- 定数関数: `pi()`, `tau()`
- 角度: `radians(degrees)`, `degrees(radians)`。`sin` / `cos` の引数はラジアンです。
- 基本: `abs`, `min`, `max`, `clamp`, `sign`。`clamp(value, lower, upper)` は `lower > upper` の場合に端点を入れ替えてから値を制限します。
- 丸め: `floor`, `ceil`, `round`。`round` はちょうど `.5` の場合、0から遠ざかる方向に丸めます。
- 平方根: `sqrt`。負数と0には `0` を返します。演出・アニメーション向けの近似実装です。
- 補間: `lerp(a, b, amount)`。`amount` は自動で制限しません。範囲制限が必要なら `clamp` を組み合わせます。端点が異符号の場合は、外挿結果が有限でも差分 `b - a` がオーバーフローするケースを避けます。`map_range` は範囲間の線形変換、`distance` は2点間距離、`approach` は最大変化量を指定した追従に使えます。
- `distance` は差分と二乗を計算する前に座標をスケーリングし、中間値のオーバーフローやアンダーフローを避けます。有限座標間の実距離がfloatの範囲を超える場合は、Runtimeのfloat値を有限に保つため最大有限値に飽和します。
- `lerp` は、符号が異なる端点と `[0, 1]` 内の `amount` に対して有限の補間結果を保ちます。範囲外への外挿では直接式を使い、値を制限しません。
- `map_range` は入力端点が0をまたぐ場合や、同符号の入力端点に対して反対符号の値を外挿する場合に値をスケーリングし、正規化量の計算でオーバーフローしないようにします。入力範囲外の値も外挿し、端点が同じ場合は `output_min` を返します。
- `smoothstep` と `smootherstep` は0をまたぐ有限端点を、端点間差のオーバーフローなしで扱います。範囲外の値は補間前に端点へ制限します。両端点が同じ場合は `value < edge0` なら0、それ以外（端点と等しい場合を含む）は1です。
- `sin` と `cos` は有限な `float` 値の引数縮小を適切に行うため、Browser/Nativeの標準数学ライブラリへ処理を委譲します。非有限の角度はそれらのAPIを呼ぶ前に `0` を返します。
- イージング: `smoothstep`, `smootherstep`, `ease_in_quad`, `ease_out_quad`, `ease_in_out_quad`, `ease_in_cubic`, `ease_out_cubic`, `ease_in_out_cubic`。イージング入力は `[0, 1]` に制限されます。
- 三角関数: `sin`, `cos`。Browser/Nativeの標準数学関数で範囲縮小します。高精度な科学計算用途の精度保証ではありません。

関数はプロジェクトのシナリオへコンパイル時に取り込まれます。標準ライブラリのファイルを作品内へコピーする必要はありません。科学計算向けの精度保証はありません。

## モーション

### `std/motion/walk.tds`

歩行用の関数は `character` と `walk_x` の2つです。`character` は現在表示中のキャラクターを、指定した距離・周期・秒数・揺れ幅で歩かせます。`walk_x` は進行率から横方向の位置を計算する補助関数です。

```tds
include "std/motion/walk.tds" as walk

scene main {
  show ayase.smile left
  walk.character("ayase", 120.0, 3, 2.0, 6.0)
}

float x = walk.walk_x(120.0, 0.5)
```

`walk.character(character, distance_px, cycles, seconds, bob_px)` の距離と揺れ幅はpx、時間は秒です。距離は開始位置からの最終的な横移動量、周期数は移動中の上下揺れ回数です。`bob_px`が正なら各周期は開始位置から下へ動いて戻り、最初の区間も下方向から始まります。負の`bob_px`は上下方向を反転し、最初の区間が上方向になります。0なら上下移動しません。関数は1周期8区間の時間付き `move` を発行し、区間時間の合計が指定秒数（ミリ秒に丸めた値）になるよう配分します。`seconds * 1000` の結果は最近接ミリ秒へ丸めてから符号付き64bit整数へ変換するため、変換範囲を超える値や乗算で有限値を保てない値はRuntimeエラーになります。丸めた実行時間が0msの場合は移動しません。Runtimeのループ上限により、実行できる周期数は1〜12,500です（キャラクターが表示中で、丸めた実行時間が1ms以上の場合）。0以下の周期数、秒数が正でない場合、またはキャラクターが実行時に表示されていない場合も移動しません。12,501以上で `cycles * 8` がint64範囲内かつ実行時間が1ms以上の場合はRuntimeのループ上限エラーになります。周期数を8倍した値がint64範囲を超える場合は、step計算時の整数オーバーフローエラーになります。

各`move`区間の時間はRuntime上限の2,147,483,647ms以下である必要があります。そのため、指定時間を`cycles * 8`区間に分けたとき、いずれかの区間が上限を超える組み合わせは「移動時間は0から2147483647ミリ秒の範囲で指定してください」という実行時エラーになります。

静的解析で呼び出し地点までに `show` 済み、または `runtime.state.characters.exists(...)` の真分岐内と証明できれば警告は出ません。証明できない場合はIDEが警告します。実行時にも存在確認を行うため、静的に証明できないだけで実行時に未表示のキャラクターへ移動命令を出すことはありません。`walk_x(distance_px, progress)` は `progress` を `[0, 1]` に制限し、指定距離に対する線形位置を返します。

### `std/motion/effects.tds`

- `shake(amplitude: float, progress: float, cycles: float) -> float`
- `breathe(amplitude: float, progress: float) -> float`
- `hop(height: float, progress: float) -> float`
- `drift(amplitude: float, progress: float, cycles: float) -> float`

`include "std/motion/effects.tds" as motion` で読み込み、`motion.shake(...)` のように別名経由で呼び出します。例えば:

```tds
include "std/motion/effects.tds" as motion

scene main {
  float shake_x = motion.shake(4.0, 0.5, 3.0)
  float breathing_y = motion.breathe(2.0, 0.25)
  float hop_y = motion.hop(12.0, 0.5)
  float drift_x = motion.drift(3.0, 0.5, 2.0)
}
```

- `shake(amplitude, progress, cycles)`: 徐々に弱まる揺れ
- `breathe(amplitude, progress)`: 1周期分の呼吸揺れ
- `hop(height, progress)`: 放物線状のジャンプ量。上方向は負のY
- `drift(amplitude, progress, cycles)`: 周期的な背景・前景のずれ

これらも `progress` は `[0, 1]` に制限されます。`shake`と`drift`は周期数×進行率を1回転未満へ縮小してから角度へ変換するため、有限巨大値の`cycles`でも`tau * cycles`の中間オーバーフローを避けます。`hop`は高さ係数を先に計算してからheightを掛けるため、有限最大付近のheightでも中間値のオーバーフローを避けます。値はpx単位の演出用オフセットで、実際の移動指令はシナリオ側で `move` に渡します。

### 数値関数の境界

`floor`、`ceil`、`round` は `float` を返します。`round` はちょうど .5 の値をゼロから遠ざかる方向へ丸めます。±2^52 以上では、表現可能な有限 double はすでに整数なので入力値をそのまま返します。これにより、言語の符号付き64bit整数の範囲外も扱えます。`sqrt` は0以下の入力に0を返します。三角関数はBrowser/Nativeの標準数学関数を使い、非常に大きな有限角度も直接扱います。高精度な科学計算を保証するものではありません。

- `approach` は有限な追従値の加減算が目標値を越えてfloat範囲を溢れうる場合、先に距離を比較して目標値を返します。
