# TDS 実行時意味論（Browser）

本書はコンパイル済み TDS v2 を `Edit/runtime.js` の `Runtime` が実行し、`Edit/player.js` が Browser 上で表示する時の契約を記す。構文・型検査ではなく、命令実行、変数、SceneState、非同期表示の挙動が対象。実装根拠は `Runtime.run`、`Runtime.exec`、`sceneStateCommand` と player host callback / `command` / `playBgm` / `media` / `playVideo`。

## 1. 実行アーキテクチャ

実行系は二層である。`Runtime` は AST 命令を評価し、変数・制御フロー・canonical `SceneState` を管理する。Host は外部作用を引き受け、Player の host は DOM、音声、動画、入力を操作する。`sceneStateCommand(state,name,args,program,defaults)` は表示命令の状態遷移を先に計算し、operation として host へ渡す。Host の失敗時、通常の presentation command は自分の変更だけを巻き戻す。同時に届いた別 action の完了/進捗イベントは event journal から復元後 state に適用する。

Runtime は Node では `module.exports`、Browser では `globalThis.NovelRuntime` に公開される。Native も共通 runtime state の形を実装するが、Browser DOM/CSS/WebAudio と native renderer/device の動作まで同一という意味ではない。

## 2. Load、start、scene transfer

`player.js:loadScene(name)` は `/api/scene?name=...` から source を取り、`POST /api/compile` で program を得る。debug 中は compile に `debug:true` を渡す。HTTP/compile error は throw。`launchGame()` は二重起動を抑止し、globals を空 object に初期化して `runtime.run(await loadScene(source), debug)` を呼ぶ。終了時は `gameStarted=false`。正常終了した通常プレイだけ BGM、dialogue、character、image、background を掃除し初期 screen を表示する。

`Runtime.run` は debug line/file の形式を検査し、SceneState を新規作成するか `debug.sceneState` から clone する。defaults を反映した後、各 program について version 2 を要求し、program/function map を設定して `p.globals` を実行する。初回のみ debug variables と locals を投入する。scene は debug 指定 scene、または `p.scenes[0]` を選択する。scene がない program は globals 実行後に正常終了する。指定 scene/line が不正なら失敗する。

`goto` は `exec()` の戻り値 `{kind:'goto',scene}` として伝播する。同一 program に scene があれば同じ run 内で遷移し、なければ `host.load(target)` で別 program を取得する。遷移ごとに `transfers` に `{target,external,at}` を記録し、host に通知する。外部遷移でも Runtime、globals、SceneState は維持される。次 program の globals は preserve mode で再宣言され、既存値は型が合えば維持される。frames は globals のみへ戻り、新 program の function map に差し替わる。

## 3. Opcode dispatcher

`Runtime.exec(list)` は命令ごとに source file/line を設定し、`host.beforeInstruction(instruction,rt)` を await してから opcode を実行する。

| opcode | 動作 |
|---|---|
| `declare` | 最も内側の非 loop lexical frame に値を作る。初期値なしは型別 default（int 0n、float 0、str 空、bool false、list 空、object 空）。preserve global は既存値を残し型を照合。const は readonly metadata に登録。 |
| `set` | 右辺を先に評価。const を検査後、変数または index を更新。dict/list は copy-on-write。 |
| `unset` | 添字対象のみ。key が無ければ失敗。const を検査して複製後に削除。 |
| `command` | 引数を左から評価し、SceneState draft を作り host command を await。 |
| `call` | 関数を実行し結果を捨てる。 |
| `return` | return result を上位まで伝播。 |
| `goto` | scene transfer result を伝播。 |
| `if` | if / else-if を順に評価し、最初の真分岐か otherwise 一つを実行。 |
| `choice` | 選択肢表示・選択を待ち、選ばれた branch のみ実行。 |
| `for`, `forEach`, `while` | 各 loop 規則で実行。return/goto は伝播。 |
| `parallel` | 表示命令を state に仮適用し、host で同時に開始。 |

未対応 opcode、host が無い command、無効値や存在しない名前は例外となる。command failure は通常、`launchGame` の実行失敗へ伝播する。

## 4. 値、変数、関数

`value()` は integer/float/literal/load/dict/list/index/unary/binary/call node を評価する。load は copy を返す。整数は符号付き64bit BigInt、float は有限 Number（負のゼロは 0）。int division は BigInt の切り捨て。ゼロ除算、整数範囲超過、無効 list index、欠落 dict key は runtime error。存在しないkeyの実行時エラーは Browser/Native 共通で `dict key 'name' が見つかりません`。`and` / `or` は短絡評価。dict は prototype を持たない object として生成する。 関数呼び出しの引数式は左から右へ評価する。`list.append`は第一引数のlist copyを受け取り、新しいlistを返す。後続引数の評価中に元のglobalが再束縛されても、先に評価した引数の値は変わらない。Nativeがpackage JSONの正の整数を内部でunsigned値として読んでも、TDSのprimitive type照合ではsigned計算値と同じ`int`として扱う。

`frames` は外側から内側の配列。`get` は末尾から own property を探し、`set` は最も内側の既宣言名だけを書き換える。暗黙変数作成はない。`declare` は loop frame を飛ばして最内側 lexical frame に入る。`if` は新 frame を作らない。choice branch は独立 frame を push/pop し、その local は外へ漏れない。

関数呼び出しは caller frames を退避し、一時的に `[globals, localParameters]` へ切り替える。caller local の lexical capture はしない。finally で caller frame を戻す。non-none return type の関数で return が無い、または null を返すと失敗する。再帰の静的禁止は compiler/checker 側の責務。

組み込み関数: `str`、`int`、`float`、`__intrinsic_sin`、`__intrinsic_cos`、`list.length`、`list.append`、`list.contains`、`list.remove_all`、`text.trim`、`text.normalize_space`、`text.split`、`text.replace`、`text.join`。`__intrinsic_sin/cos` は標準数学モジュール専用の予約intrinsicで、角度をラジアンで受け取る。`split` / `replace` の検索文字列が空の場合はエラーになる。`runtime.state.*` 組み込み関数は character/background/BGM/volume/dialog opacity、visible variable names、current scene/file/line を読み取る。引数の数または型が合わない場合もエラーになる。

組み込み呼び出しの契約を以下に示す。pure はSceneState・変数・hostを変更しない。`list.append` と `list.remove_all` は入力listを変更せず、新しいlistを返す。`text.join` は受け取ったlistを変更しない。`list.remove_all` と `text.join` は最大100,000要素を処理し、それを超える入力にはloopと同じ上限エラーを返す。`start()` は画面hostへ制御を渡すため、pureではなく非同期である。

| 名前 | signature → return | 副作用 | 実行時エラー |
|---|---|---|---|
| `str` | `int or float -> str` | pure | なし（有効な型付き引数） |
| `int` | `str or float -> int` | pure | 数字でない文字列、有限値でないfloat、signed 64-bit範囲外 |
| `float` | `int, str, or float -> float` | pure | 数字でない文字列、有限値でない値 |
| `__intrinsic_sin` / `__intrinsic_cos` | `float -> float` | pure | 結果が有限floatでない場合 |
| `list.length` | `list[T] -> int` | pure | 引数の型違反 |
| `list.append` | `list[T], T -> list[T]`（primitive T） | pure | 個数・要素型違反 |
| `list.contains` | `list[T], T -> bool`（primitive T） | pure | 個数・要素型違反 |
| `list.remove_all` | `list[T], T -> list[T]`（primitive T） | pure | 個数・要素型違反、100,000要素超過 |
| `text.trim` | `str -> str` | pure | 引数の型違反 |
| `text.normalize_space` | `str -> str` | pure | 引数の型違反 |
| `text.split` | `str, str -> list[str]` | pure | 個数・型違反、区切り文字が空 |
| `text.replace` | `str, str, str -> str` | pure | 個数・型違反、検索文字列が空 |
| `text.join` | `list[str], str -> str` | pure | 個数・型違反、100,000要素超過 |
| `start` | `() -> none` | screen hostを呼び出し、実行を中断 | 引数あり、対応するscreen hostがない |

これらとruntime-state APIはBrowser `Runtime.value/call` とNative `Runtime::value/runtimeStateCall` が実行する。compiler/type checkerが有効プログラムの個数・型を先に検査するが、実行時にも空区切り、変換範囲、state APIの許可channelなどの値制約を検証する。

実行位置APIは現在評価している命令のfile/lineを返す。ユーザー関数の実行中は関数内の命令位置に移り、正常復帰すると呼び出し元の位置に戻る。`parallel` 内では各command argumentの評価時に、その子commandのfile/lineを返す。実行時エラーは例外なので、関数内の失敗位置が保持される。
Browser/Nativeで共通に返すruntime errorは、補間先fieldがない場合 `補間対象のfield '{name.field}' が見つかりません`、未対応のrender layer categoryの場合 `layer は既知の分類に対して0〜8未満の範囲で0.001刻みに指定してください`。Native Playerのasset resolutionでIDがない場合は `asset が見つかりません: {id}`、同じfile nameに複数assetが一致する場合は `同じfile nameのassetが複数あります: {reference}`と表示する。`test/runtime.test.js`でBrowser/Nativeの実行を確認する。SDL_GetErrorが返すplatform固有の詳細文字列はそのまま保持する。

### 4.1 Runtime State API

以下は読み取り専用 host API で、値は呼び出した時点の runtime state から返す。ここでいう character の表示状態は slot に割り当てられた ID、background/BGM は現在の asset ID。未設定の ID・position・scene/file は空文字列、未設定状態の `exists()` は false。`characters.list()` は現在の slot ID を重複なし・昇順で返す。`variables.exists/name(s)` は現在の global/local frame にある名前を対象とし、`names()` は重複なし・昇順。変数の値は返さない。

| API | signature | 意味 |
|---|---|---|
| `runtime.state.characters.exists(id)` | `str -> bool` | ID が表示中か |
| `runtime.state.characters.list()` | `() -> list[str]` | 表示中 ID 一覧 |
| `runtime.state.characters.position(id)` | `str -> str` | 表示中 character の slot。非表示なら空文字列 |
| `runtime.state.background.exists()` / `current()` | `() -> bool` / `str` | 背景の有無と asset ID |
| `runtime.state.audio.bgm_exists()` / `current_bgm()` | `() -> bool` / `str` | BGM の有無と asset ID |
| `runtime.state.audio.volume(channel)` | `str -> float` | `bgm` / `se` / `voice` の作品側チャンネル音量 |
| `runtime.state.ui.dialog_opacity()` | `() -> float` | 現在の通常 dialogue opacity |
| `runtime.state.execution.current_scene/file/line()` | `() -> str` / `str` / `int` | 現在実行中の scene とソース位置。scene 外では空文字列 / 空文字列 / 0 |
| `runtime.state.variables.exists(name)` / `names()` | `str -> bool` / `() -> list[str]` | 現在参照できる名前の有無・一覧 |

音量APIは実際の出力音量を返さない。Browser は channel override、SceneState channel volume、presentation default の順、Native Player は channel override、作品設定値、既定値の順で返す。標準値は BGM=1、SE=1、voice=0.5。ユーザー設定の master volume、mute、channel gain、voice character gain は出力段の mix なので含まれない。dialogue opacity API も通常値を返し、一行だけの opacity やユーザー側倍率は含まない。Native `--headless` は Engine を使わず、Runtime の既定SceneState値で実行する。`--smoke` はPlayer providerを通るため作品設定値を読む。引数の数・型・channel 名が不正なら両Runtimeで error。

Browser/Nativeで共通に返すruntime errorは、補間先fieldがない場合 `補間対象のfield '{name.field}' が見つかりません`、未対応のrender layer categoryの場合 `layer は既知の分類に対して0〜8未満の範囲で0.001刻みに指定してください`。Native Playerのasset resolutionでIDがない場合は `asset が見つかりません: {id}`、同じfile nameに複数assetが一致する場合は `同じfile nameのassetが複数あります: {reference}`と表示する。`test/runtime.test.js`でBrowser/Nativeの実行を確認する。SDL_GetErrorが返すplatform固有の詳細文字列はそのまま保持する。

`text()` は `{name}` / `{name.field}` を補間し、dict/list は JSON 表記で再帰的に直列化する（list は `[...]`、dict は `{...}`）。dict のキーは Unicode code point の昇順で出力するため、挿入順に依存しない。float は整数値でも `.0` を保ち、絶対値が `1e-4` 未満または `1e15` 以上なら指数表記にする。例えば `1.0`、`1e-6`、`1e15` は `1.0`、`1e-06`、`1e+15` と表示し、Browser/Nativeで一致する。`textAsync()` は通常補間後、結果内の `{function()}` を順次呼び出す。補間関数の副作用は維持される。存在しない field は error。

`for` は start/stop/step を一度評価し、両端を含む。step=0、方向不一致は error。`forEach` は list 必須。loop frame は反復値を持ち、body は最大100,000回。while も最大100,000回で、上限超過時はBrowser/Nativeともに `loop の実行回数が上限の100,000回を超えました` を報告する。`for-in` の実行時値がlistでない場合は `for-in には list を指定してください`、list添字がint以外の場合は `list の添字は int で指定してください`、範囲外の場合は `list の添字が範囲外です: N` をBrowser/Native共通で報告する。debugBody がある loop は最初の反復だけ指定 suffix を使い、次から通常 body に戻る。

## 5. SceneState schema

`createSceneState()` は renderer 非依存 state を作る。

| field | 内容 |
|---|---|
| `revision`, `logicalTimeMs` | state revision と story clock。 |
| `nextVisualOrder` | character/image 表示順 counter。 |
| `background` | asset、layer、offset、transition、previousAsset、action provenance。 |
| `characters` | character id ごとの pose/slot/offset/visible/opacity/layer/order/transition。 |
| `slots` | far_left/left/center/right/far_right から character id または null への map。 |
| `images` | image instance 名ごとの asset/slot/layer/order/transition。 |
| `video`, `visualOnly` | current video と `--only` presentation selector。 |
| `layers` | background/video/character/image/fog/dialogue/controls/menu の値 0..7.999。default 0..7。 |
| `audio` | bgm、se[]、voices[]、persistent volumes、volumeOverrides。 |
| `ui`, `camera` | dialogue opacity/visibility、zoom/focus。 |
| `effects`, `choices`, `transfers`, `actions`, `diagnostics` | active/terminal action と実行履歴・診断。 |

Command による state change は revision を進め、`host.sceneState(state,operation,rt)` を通知する。restore event では Player の `restorePlayerState` が背景、character、image、camera、layers、dialogue、BGM を DOM に再構成する。

### 5.1 Character / slot / image

`show Character.pose slot` は slot の既存 character を非表示にし `slot-replaced` info diagnostic を残す。同じ character を別 slot に移す場合、以前の slot がその id を指していれば解除する。表示済み character の pose 更新は visualOrder を維持し、非表示から戻る場合は新 order。pose yOffset と command の x/y offset が合算される。

`hide` instant は visible=false と slot 解放。fade hide は現在 opacity から0へ遷移し、完了時に不可視化して slot 解放する。image は instance name ごとに置換され、`clear image name` はその instance のみ削除。`move` は visible target の現 offset に delta を累積し、対象不在/character不可視なら失敗。position は ±1,000,000 px 制約。

### 5.2 Transition / clock / actions

Transition は type/durationMs/startedAt/endsAt/progress/status を持ち、必要に応じ id と interpolation を含む。linear sample は opacity/offset/gain/camera を更新し、SceneState には中間値が格納される。`advanceSceneTime` は非負安全整数 ms で `logicalTimeMs` と story-clock transition を進める。これは実媒体を待つ処理ではない。Player animation promise と action completion が実表示を同期する。

Action は `actions[id]` に running/complete/stopped を履歴として持つ。complete/stop 時に endedAt と progress を確定し、SE/voice を active 配列から除き、該当 video state を消す。stop reason には replaced/cleared/failed 等がある。各操作は action id で対応づき、遅延した旧 action event が置換後 action を誤って完了させない。

通常の timed command は host の表示完了後に duration 分 logical time を進め、blocking action を完了する。`wait` は `setTimeout` を待ってから同量の story time を進める。`say` はユーザー進行待ちなので state transaction を保持しない。BGM crossfade は audio clock で進み、story time では進まない。

## 6. Command state と進行

| command | 意味 |
|---|---|
| `bg` | background asset を state に設定。非 instant transition は blocking。遷移中は旧 asset を previousAsset として保持し、終了時に除く。`clear bg` は背景と visualOnly を消去。 |
| `show character` | pose/slot/state を更新。fade 等は blocking。Browser は画像 decode 後に DOM を差し替える。 |
| `show image` | image instance state を更新し decode 後 DOM 表示。state の transition metadata を host 描画実装が使うかは個別確認が必要。 |
| `hide` | instant または blocking opacity fade。完了後 DOM remove と slot 解放。 |
| `move` | background/visible character offset を加算。`over ms` はblockingで、各commandの時間は0..2,147,483,647 ms。 |

`move` の時間がこの範囲外の場合、Browser/Native ともに「移動時間は0から2147483647ミリ秒の範囲で指定してください」と報告する。
| `camera` | zoom/focus を補間。zoom は 0.1..8、reset は 1 / (640,360)。 |
| `effect fade` | 色付き overlay と blocking effect action。Browser は fade 後 overlay を削除。 |
| `layer`, `volume`, `dialog` | layer/volume/dialog state を即時更新して host へ通知。 |
| `say` | speaker/text を補間し表示。reveal 後、クリック/キーまたは autoplay timer を待つ。履歴は最大500件。一時 opacity は待ちの間だけ適用し finally で復元。 |
| `choice` | 全 label、prompt を選択前に評価。選択後に履歴を記録し、選択 branch を実行。 |
| `wait` | 実時間 ms 待機後に logical time を同量進める。0..2,147,483,647 が有効範囲。 |

`camera` command のdurationが0なら、targetのzoom/focusをSceneStateへ即時に保存する。

## 7. Parallel

`parallel` は空でない command のみ受け付ける。引数を評価し、SceneState に順次仮適用して operations を作る。Player host は DOM/media の準備後、begin function 群を `Promise.all` で同時開始する。parallel 対応不能な command は error。各 timed command の duration は 0 以上で、0 は即時適用を表す（例: `parallel { camera reset over 0 }`）。

開始前に SceneState clone と event journal を作る。いずれかが失敗したら draft を復元し、journal の並行完了/progress/stop を復元 state に反映して throw。成功時はグループ内最大 duration だけ logical time を進める（各 duration の合計ではない）、blocking actions を完了し、fade hide と background previous asset を確定する。

Browser host は parallel command の画像 decode 等をすべて成功させてから DOM を変更し、失敗した preparation がキャラクターや effect overlay を残さない。Native host も処理前の presentation state を保持し、途中の command preparation または描画中断が失敗した場合はキャラクター、背景、camera、overlay と logical time を復元する。キャラクター表示はslotを排他的に使うため、同じ parallel block 内で同じ slot に複数の `show` は指定できない。Native の実再生検査では複数 track の中間進捗と、group duration が各trackの合計ではなく最大値になることを確認する。

## 8. Audio

defaults は BGM=1, SE=1, voice=0.5。音量解決順は play ごとの volume > channel `volume` override > asset volume > state channel volume > presentation default > 1。0..1 の有限値。Player 出力はさらに master、mute/channel setting、voice character gain 等の UI mix を適用する。

### 8.1 BGM

`audio.bgm` は現在曲の asset/action/gain と全 audible `layers[]` を持つ。BGM command は非 blocking。通常置換は現在 action を replaced として止めて新曲に切り替える。crossfade は全既存層を outgoing（gain→0）、新曲を incoming（0→target）として同時に保持する。割込み fade も現時点の全層から補間を始める。

BGM transition は `clock:'audio'`。Browser は WebAudio/HTMLAudio の automation progress を `reportTransitionProgress()` へ送り、完了は action id を照合して commit する。logical time を進めても BGM は進まない。新曲の play 失敗時は候補を failed とし、壊れた crossfade の旧層も停止する。stale completion/failure は replacement 曲を消さない。`clear bgm` は action を cleared として止め、`audio.bgm=null` にする。

### 8.2 SE / voice

SE は非 blocking、voice は default async で `blocking` 時だけ ended を await。再生中は `audio.se[]` / `audio.voices[]` に action を保持し、ended/error event で complete/failed として除く。voice の character binding は明示指定時のみ記録される。Browser の再生は HTMLAudio/WebAudio と autoplay/device 可否に依存する。

## 9. Video / visual-only

Video state は asset/action/start/blocking/opacity/status/layer を保持する。default は blocking、`async` の場合のみ後続命令へ進む。Browser は candidate video の `play()` が成功してから前動画を remove する。error 時は candidate を破棄し action failed、前動画とその `--only` presentation mode を維持する。blocking 中は stage dataset で会話操作を抑止し、ended/error で解除する。

`--only` は background/character/image/video の表示対象 selector を state.visualOnly に保持する。Player CSS は他の presentation layers を visibility hidden にする。SceneState の character/background/image は削除されず、通常 command が visualOnly を解除する。これは描画選択であり state reset ではない。

## 10. Save、debug、復元境界

slot/quick save snapshot は version/saveId、file/scene/line、globals、locals (`frames.slice(1)`)、readonly locals、SceneState、表示中 text/speaker、timestamp を保存する。slot は lock 情報、thumbnail PNG は別 blob。encoded data は3,500,000文字超で拒否。Save は命令ポインタや JavaScript await continuation、user function の call stack、loop iterator/condition continuation を保存しない。user function または `for` / `forEach` / `while` の実行中はslot saveとquick saveを拒否する。関数内のfile/lineと呼び出し元sceneの組み合わせ、または実行中loopの反復位置をsnapshotだけから復元できず、lineからの再開では異なる命令経路になるためである。

user function の実行中は`関数の実行中は保存できません`、loopの実行中は`loopの実行中は保存できません`と表示する。Browserのslot errorはSave screen内に、quick saveのerrorはgame stage上のtoastに表示する。Native Playerもsave noticeに同じ理由を表示する。Browser UI、Runtime、Native Playerの実行を`test/runtime.test.js`、`test/save-load.browser.cjs`、`test/native-save-load.cjs`で確認する。

Load時は、保存データの必須fieldに加えて存在する`locals`/`readonlyLocals`のframe構造を検査する。Nativeでは`loopScopes`も配列として検査し、不正な任意編集データがruntime restore中の型変換エラーを起こさないようにする。

Load は page reload 後、snapshot を `Runtime.run` の debug input として渡す。`instructionsFromLine` は指定 file の line 以上にある最初の実行可能 instruction suffix から再開する。if/choice body 内も探索し、loop 内なら loop 命令を残して最初の iteration だけ debugBody suffix を使い、次 iteration から通常 body に戻る。debug variables は globals、locals は frame として再構築し readonlyLocals も復元する。

Player `beforeInstruction` は current file/scene/line と既読 say 行を更新する。debug session は `novel-debug:location` を parent に postMessage し、同origin/source/session の ack が来るまで同期停止する。choice は selectedIndex/label/prompt/time を履歴に残す。

`restorePlayerState` は背景、character、image、camera、layers、dialogue、BGM を描画し直す。SE/voice は音声位置を seek して復元しない。video 再生位置、DOM animation continuation、dialogue 中の await point も復元しない。SceneState に action/transitions があっても媒体の時間位置再開は保証されない。

## 11. Error、replacement、cancel、lifecycle

- 不正な値、未定義変数/function、欠落 key、asset decode、host command、media play failure は例外として伝播する。
- 通常 presentation command は状態 draft を clone する。失敗時は draft を戻し、失敗候補 action は `stopped/failed` の履歴として残す。並行 media event は journal 経由で保持する。
- replacement/clear は actionId と reason を記録する。Browser audio/video の ended/error は actionId を照合し、旧イベントで新 action を止めない。
- `Runtime.stopAction` は canonical state API であり、それだけでは実媒体 pause/remove を行わない。Host 側の停止処理と対で使う。
- 任意命令中断用の一般 cancel token はない。pause screen は auto/skip timer を止めるが、すべての媒体を自動停止する契約ではない。
- user function 実行中のSaveはBrowser/Nativeとも拒否する。user function のcall stackをsnapshotに含めず、resumeはscene命令列のfile/lineから再開するため。
- Runtime/Player の正常終了後処理と error 終了後処理は異なる。外部 goto には `host.load` が必要。

## 12. Browser / Native 差

`test/runtime.test.js` は共通 runtime の関数/loop/choice/scene transfer、bool/list/intrinsics、float、debug start、SceneState、audio action state の parity をテストする。一方、Browser 固有実装は DOM/CSS animation、画像 decode、HTMLAudio/Video、WebAudio、autoplay、keyboard/mouse、thumbnail canvas、save adapter、debug postMessage ack を使う。

`native/runtime.hpp` も common instruction/state semantics と parallel timed visual batch を実装するが、HTML DOM/CSS/WebAudio の詳細を Native に当てはめない。音声開始遅延、decoder、font/layout、input、save backend が同一とはこの仕様では断定しない。Parity の範囲は実際に起動できた runtime test に限る。

関連テスト名は `test/runtime.test.js` の `functions execute statements, preserve lexical scope and return falsy values`、`choice errors reject the run and restore scope`、`scene state tracks blocking transition time and leaves instant actions complete`、`failed presentation commands roll back only their draft and retain concurrent media completion`、BGM crossfade/audio-clock/stale completion/failure 群、`visual-only mode isolates ... without deleting scene state`、`save cursor restoration preserves active choice-local values ...`、`native and browser runtimes agree on functions, loops, choice and scene transitions`、`native and browser preserve ordered choice interpolation effects after optimization` 等。最適化ON/OFFと両Runtimeを同じchoice fixtureで比較するこの検査は、全ての式・命令組合せの同値性を証明するものではない。

本書のテスト名一覧を作成した時点では、test suite、実 Browser player、Native player を実行していなかった。2026-10-07の追補では `node --test test/standard-library.test.js` により標準motion helperのBrowser／Native移動量・時間一致と範囲端を確認した。これは実デバイス再生や物理入力の網羅確認を示すものではない。
## start() screen suspension

Executing start() pauses scenario execution while the Player displays the initial game screen. The Start action resumes the same runtime stack after the call. No screen is drawn at launch or completion unless TDS executes start() again explicitly. Headless Native execution skips the UI wait. See [startup-flow.md](startup-flow.md).

## Standard motion helpers

同梱の`std/motion/effects.tds`にある`shake`、`breathe`、`hop`、`drift`と`walk.walk_x`は、通常のnamespaced TDS functionです。pixel offsetを返し、PlayerやSceneStateへの副作用はありません。正規化されたprogress引数は[0, 1]の範囲に制限します。計算式とnumeric guardは[std/README.md](../std/README.md)に記載しています。

`walk.character`はmotion moduleのcommand-emitting helperです。処理前に`runtime.state.characters.exists`を調べ、targetが表示されていない場合、cycle countまたはdurationが正でない場合、durationが丸め後に0msとなる場合はmoveを出力せずに終了します。それ以外では各cycleで8個のtimed move commandを順に出力します。segment durationは負でない整数で、合計はms単位に丸めた要求durationと一致します。BrowserとNativeには同じdeltaとdurationを渡します。integer overflow、loop limit、move durationのerrorは[std/README.md](../std/README.md)にあるRuntime制限に従います。

### Linear standard-library intrinsics

`list.remove_all` と `text.join` はO(n)で結果を作る。処理開始前に要素数を検査し、100,000を超える入力にはTDS loopと同じloop-limit errorを返す。
