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

`value()` は integer/float/literal/load/dict/list/index/unary/binary/call node を評価する。load は copy を返す。整数は符号付き64bit BigInt、float は有限 Number（負のゼロは 0）。int division は BigInt の切り捨て。ゼロ除算、整数範囲超過、無効 list index、欠落 dict key は runtime error。`and` / `or` は短絡評価。dict は prototype を持たない object として生成する。

`frames` は外側から内側の配列。`get` は末尾から own property を探し、`set` は最も内側の既宣言名だけを書き換える。暗黙変数作成はない。`declare` は loop frame を飛ばして最内側 lexical frame に入る。`if` は新 frame を作らない。choice branch は独立 frame を push/pop し、その local は外へ漏れない。

関数呼び出しは caller frames を退避し、一時的に `[globals, localParameters]` へ切り替える。caller local の lexical capture はしない。finally で caller frame を戻す。non-none return type の関数で return が無い、または null を返すと失敗する。再帰の静的禁止は compiler/checker 側の責務。

Builtins: `str`, `int`, `float`, `list.length`, `list.append`, `list.contains`, `text.trim`, `text.normalize_space`, `text.split`, `text.replace`。split/replace の検索文字列が空なら error。`runtime.state.*` builtins は character/background/BGM/volume/dialog opacity、visible variable names、current scene/file/line を読む。引数の数・型が合わなければ error。

`text()` は `{name}` / `{name.field}` を補間し、object/list は JSON 風に直列化する。`textAsync()` は通常補間後、結果内の `{function()}` を順次呼び出す。補間関数の副作用は維持される。存在しない field は error。

`for` は start/stop/step を一度評価し、両端を含む。step=0、方向不一致は error。`forEach` は list 必須。loop frame は反復値を持ち、body は最大100,000回。while も最大100,000回。debugBody がある loop は最初の反復だけ指定 suffix を使い、次から通常 body に戻る。

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
| `move` | background/visible character offset を加算。`over ms` は blocking。 |
| `camera` | zoom/focus を補間。zoom は 0.1..8、reset は 1 / (640,360)。 |
| `effect fade` | 色付き overlay と blocking effect action。Browser は fade 後 overlay を削除。 |
| `layer`, `volume`, `dialog` | layer/volume/dialog state を即時更新して host へ通知。 |
| `say` | speaker/text を補間し表示。reveal 後、クリック/キーまたは autoplay timer を待つ。履歴は最大500件。一時 opacity は待ちの間だけ適用し finally で復元。 |
| `choice` | 全 label、prompt を選択前に評価。選択後に履歴を記録し、選択 branch を実行。 |
| `wait` | 実時間 ms 待機後に logical time を同量進める。0..2,147,483,647 が有効範囲。 |

## 7. Parallel

`parallel` は空でない command のみ受け付ける。引数を評価し、SceneState に順次仮適用して operations を作る。Player host は DOM/media の準備後、begin function 群を `Promise.all` で同時開始する。parallel 対応不能な command は error。

開始前に SceneState clone と event journal を作る。いずれかが失敗したら draft を復元し、journal の並行完了/progress/stop を復元 state に反映して throw。成功時はグループ内最大 duration だけ logical time を進める（各 duration の合計ではない）、blocking actions を完了し、fade hide と background previous asset を確定する。

## 8. Audio

defaults は BGM=1, SE=1, voice=0.5。音量解決順は play ごとの volume > channel `volume` override > asset volume > state channel volume > presentation default > 1。0..1 の有限値。Player 出力はさらに master、mute/channel setting、voice character gain 等の UI mix を適用する。

### 8.1 BGM

`audio.bgm` は現在曲の asset/action/gain と全 audible `layers[]` を持つ。BGM command は非 blocking。通常置換は現在 action を replaced として止めて新曲に切り替える。crossfade は全既存層を outgoing（gain→0）、新曲を incoming（0→target）として同時に保持する。割込み fade も現時点の全層から補間を始める。

BGM transition は `clock:'audio'`。Browser は WebAudio/HTMLAudio の automation progress を `reportTransitionProgress()` へ送り、完了は action id を照合して commit する。logical time を進めても BGM は進まない。新曲の play 失敗時は候補を failed とし、壊れた crossfade の旧層も停止する。stale completion/failure は replacement 曲を消さない。`clear bgm` は action を cleared として止め、`audio.bgm=null` にする。

### 8.2 SE / voice

SE は非 blocking、voice は default async で `blocking` 時だけ ended を await。再生中は `audio.se[]` / `audio.voices[]` に action を保持し、ended/error event で complete/failed として除く。voice の character binding は明示指定時のみ記録される。Browser の再生は HTMLAudio/WebAudio と autoplay/device 可否に依存する。

## 9. Video / visual-only

Video state は asset/action/start/blocking/opacity/status/layer を保持する。default は blocking、`async` の場合のみ後続命令へ進む。Browser は candidate video の `play()` が成功してから前動画を remove する。error 時は candidate を破棄し action failed、前動画を維持する。blocking 中は stage dataset で会話操作を抑止し、ended/error で解除する。

`--only` は background/character/image/video の表示対象 selector を state.visualOnly に保持する。Player CSS は他の presentation layers を visibility hidden にする。SceneState の character/background/image は削除されず、通常 command が visualOnly を解除する。これは描画選択であり state reset ではない。

## 10. Save、debug、復元境界

slot/quick save snapshot は version/saveId、file/scene/line、globals、locals (`frames.slice(1)`)、readonly locals、SceneState、表示中 text/speaker、timestamp を保存する。slot は lock 情報、thumbnail PNG は別 blob。encoded data は3,500,000文字超で拒否。Save は命令ポインタや JavaScript await continuation を保存しない。

Load は page reload 後、snapshot を `Runtime.run` の debug input として渡す。`instructionsFromLine` は指定 file の line 以上にある最初の実行可能 instruction suffix から再開する。if/choice body 内も探索し、loop 内なら loop 命令を残して最初の iteration だけ debugBody suffix を使い、次 iteration から通常 body に戻る。debug variables は globals、locals は frame として再構築し readonlyLocals も復元する。

Player `beforeInstruction` は current file/scene/line と既読 say 行を更新する。debug session は `novel-debug:location` を parent に postMessage し、同origin/source/session の ack が来るまで同期停止する。choice は selectedIndex/label/prompt/time を履歴に残す。

`restorePlayerState` は背景、character、image、camera、layers、dialogue、BGM を描画し直す。SE/voice は音声位置を seek して復元しない。video 再生位置、DOM animation continuation、dialogue 中の await point も復元しない。SceneState に action/transitions があっても媒体の時間位置再開は保証されない。

## 11. Error、replacement、cancel、lifecycle

- 不正な値、未定義変数/function、欠落 key、asset decode、host command、media play failure は例外として伝播する。
- 通常 presentation command は状態 draft を clone する。失敗時は draft を戻し、失敗候補 action は `stopped/failed` の履歴として残す。並行 media event は journal 経由で保持する。
- replacement/clear は actionId と reason を記録する。Browser audio/video の ended/error は actionId を照合し、旧イベントで新 action を止めない。
- `Runtime.stopAction` は canonical state API であり、それだけでは実媒体 pause/remove を行わない。Host 側の停止処理と対で使う。
- 任意命令中断用の一般 cancel token はない。pause screen は auto/skip timer を止めるが、すべての媒体を自動停止する契約ではない。
- Runtime/Player の正常終了後処理と error 終了後処理は異なる。外部 goto には `host.load` が必要。

## 12. Browser / Native 差

`test/runtime.test.js` は共通 runtime の関数/loop/choice/scene transfer、bool/list/intrinsics、float、debug start、SceneState、audio action state の parity をテストする。一方、Browser 固有実装は DOM/CSS animation、画像 decode、HTMLAudio/Video、WebAudio、autoplay、keyboard/mouse、thumbnail canvas、save adapter、debug postMessage ack を使う。

`native/runtime.hpp` も common instruction/state semantics と parallel timed visual batch を実装するが、HTML DOM/CSS/WebAudio の詳細を Native に当てはめない。音声開始遅延、decoder、font/layout、input、save backend が同一とはこの仕様では断定しない。Parity の範囲は実際に起動できた runtime test に限る。

関連テスト名は `test/runtime.test.js` の `functions execute statements, preserve lexical scope and return falsy values`、`choice errors reject the run and restore scope`、`scene state tracks blocking transition time and leaves instant actions complete`、`failed presentation commands roll back only their draft and retain concurrent media completion`、BGM crossfade/audio-clock/stale completion/failure 群、`visual-only mode isolates ... without deleting scene state`、`save cursor restoration preserves active choice-local values ...`、`native and browser runtimes agree on functions, loops, choice and scene transitions` 等。

本書はソースと既存テスト名に基づく。今回 test suite、実 Browser player、Native player は実行していないため、実デバイス再生やGUI操作の動作確認を示すものではない。
