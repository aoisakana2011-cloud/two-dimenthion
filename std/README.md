# 標準ライブラリ

`std/` はエディタに同梱される読み取り専用モジュールです。シナリオから通常の `include` と別名で読み込みます。

## 組み込みのリスト・文字列関数

次の名前空間関数はコンパイラとBrowser/Nativeランタイムに組み込まれているため、`include` は不要です。標準TDSファイルの関数とは異なり、シナリオから直接 `list.length(items)`、`text.split(value, ",")` の形で呼び出します。

| 関数 | 型 | 意味 |
|---|---|---|
| `list.length(items)` | `list[T] -> int` | 要素数 |
| `list.append(items, item)` | `list[T], T -> list[T]` | 元listを変えず、末尾へ追加したコピーを返す |
| `list.contains(items, item)` | `list[T], T -> bool` | 同じ値の要素があるか |
| `text.trim(value)` | `str -> str` | 端の空白だけを除去 |
| `text.normalize_space(value)` | `str -> str` | 対応空白の連続をASCIIスペース1つにまとめ、端も除去 |
| `text.split(value, separator)` | `str, str -> list[str]` | 区切りで分割し、空要素を保持 |
| `text.replace(value, search, replacement)` | `str, str, str -> str` | 全ての一致箇所をリテラル置換 |

分割文字と検索文字には空文字を指定できません。`list[T]` の `T` は `int`、`float`、`str`、`bool` のいずれかです。リスト添字は0始まりで、範囲外参照は実行時エラーになります。

## TDSで書かれたデータ処理ヘルパー

低水準の `text.*` / `list.*` は組み込みAPIです。繰り返し使う高水準処理は、通常のTDS関数として同梱しています。

### `std/text.tds`

`include "std/text.tds" as strings` で読み込みます。

- `strings.split_words(value)` — 空白を正規化して単語リストにする。空白だけの入力は空リスト。
- `strings.join_words(items, separator)` — 文字列リストを区切り文字で結合する。

### `std/collections.tds`

`include "std/collections.tds" as collections` で読み込みます。

- `collections.index_of_str(items, target)` — 最初に一致した0始まり位置。見つからない場合は `-1`。
- `collections.append_unique_str(items, item)` — 既存要素を重複させず追加したリストを返す。
- `collections.remove_all_str(items, item)` — 一致する要素をすべて除いたリストを返す。

これらは組み込みのリストAPIと `for item in items` を使ったTDS実装です。元のリストを変更せず、新しい値を返します。

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
- 基本: `abs`, `min`, `max`, `clamp`, `sign`
- 丸め: `floor`, `ceil`, `round`。`round` はちょうど `.5` の場合、0から遠ざかる方向に丸めます。
- 平方根: `sqrt`。負数と0には `0` を返します。演出・アニメーション向けの近似実装です。
- 補間: `lerp(a, b, amount)`。`amount` は自動で制限しません。範囲制限が必要なら `clamp` を組み合わせます。`map_range` は範囲間の線形変換、`distance` は2点間距離、`approach` は最大変化量を指定した追従に使えます。
- イージング: `smoothstep`, `smootherstep`, `ease_in_quad`, `ease_out_quad`, `ease_in_out_quad`, `ease_in_cubic`, `ease_out_cubic`, `ease_in_out_cubic`。イージング入力は `[0, 1]` に制限されます。
- 三角関数: `sin`, `cos`。範囲縮小とTaylor近似を使った、シナリオ演出向け実装です。

関数はプロジェクトのシナリオへコンパイル時に取り込まれます。標準ライブラリのファイルを作品内へコピーする必要はありません。科学計算向けの精度保証はありません。

## モーション

### `std/motion/walk.tds`

歩行用の関数は2つだけです。`walk_x(distance, progress)` は歩行中の横位置、`walk_bob(amplitude, progress)` は上下位置を返します。`progress` は歩行全体の進み具合（`0.0`〜`1.0`）です。範囲外の値は自動で制限されます。

```tds
include "std/motion/walk.tds" as walk

float progress = 0.5
float x = walk.walk_x(120.0, progress)
float y = walk.walk_bob(6.0, progress)
```

### `std/motion/effects.tds`

- `shake(amplitude, progress, cycles)`: 徐々に弱まる揺れ
- `breathe(amplitude, progress)`: 1周期分の呼吸揺れ
- `hop(height, progress)`: 放物線状のジャンプ量。上方向は負のY
- `drift(amplitude, progress, cycles)`: 周期的な背景・前景のずれ

これらも `progress` は `[0, 1]` に制限されます。値はpx単位の演出用オフセットで、実際の移動指令はシナリオ側で `move` に渡します。
