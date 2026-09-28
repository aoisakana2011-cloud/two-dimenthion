# 標準ライブラリ

`std/` はエディタに同梱される読み取り専用モジュールです。シナリオから通常の `include` と別名で読み込みます。

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
