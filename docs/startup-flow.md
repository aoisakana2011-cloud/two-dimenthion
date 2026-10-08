# 起動フロー: main.tds と start()

TDSで明示的に `start()` を呼び出すと、front-end screenが開きます。表示する画面を `startScene` settingで選ぶ仕組みではありません。起動video、logo、demo commandなどを先に実行し、その位置でTDSの実行を一時停止してから初期game screenを表示できます。top-levelの `start()` はglobalの初期化後、最初のsceneの前に実行されます。scene内や呼び出されたfunction内では、そのstatement位置で実行を一時停止します。

## Editorの起動とPlayerのStart screen

Editor自体の起動と、作品内の `start()` が表示するPlayer screenは別の経路です。Electron Desktop Editorは `NOVEL_PROJECT_ROOT` が指定されていればそのprojectを優先し、なければrecent listの先頭にある有効なprojectを開きます。削除済みfolderやproject形式でないfolderは読み飛ばします。有効なrecent projectがなければtemporary workspaceでEditorを起動します。起動時にprocess current directoryから作品を推測することはありません。

Browserからserverを直接起動する場合は `--project`、`NOVEL_PROJECT_ROOT`、または呼び出し側の既定projectが使われます。`tools/project-layout.js` の既定はrepositoryの `Title/` です。Electronのrecent-project選択はこの直接起動経路には適用されません。どちらのEditor起動経路もPlayerのinitial screenを自動表示せず、Player側ではentry TDSが `start()` を実行した時点で `game-screens.json` のinitial screenが表示されます。

## Runtime contract

- `start()` は引数を取らず、値を返しません。
- top-level statement、scene内、実行中のprogramから呼び出されたfunction内で使えます。nested control flowから到達する場合も同様です。一度も呼ばれないfunction内にあるだけでは、screenは開きません。
- Playerは `game-screens.json` のinitial screenを表示し、start actionを待ちます。
- Startを実行するとscreenが閉じ、同じTDS実行が `start()` の直後から再開します。
- Playerがlaunch時やprogram終了時に自動でinitial screenを開くことはありません。再度表示するには、もう一度 `start()` を明示的に呼び出します。
- Debug startとresumeは、指定された開始位置を保ちます。sceneの途中からresumeする場合、その位置より前に実行済みのtop-level `start()` は再実行されません。選択位置自体が `start()` の行ならscreenが開き、Startの実行後に続きから再開します。
- Native initial screenでContinueを選ぶと、選択したsaveを実行中のRuntimeへ渡し、file・scene・source lineを復元します。初期 `start()` の復帰後にentryの先頭から実行し直すことはありません。BrowserのContinueは同じresume位置を指定してPlayerを再読み込みします。

~~~text
main.tds entry scene
   |
   +-- intro video / logo / demo commands
   |
   +-- start()
   |      |
   |      +-- game-screens.json のinitial screenを表示
   |      +-- Start actionを待つ
   |      +-- 次のTDS instructionから再開
   |
   +-- story commands または goto story
          |
          +-- 通常終了時はscreenを表示せずrunを終了
~~~

## 例

新規projectには、次のentry programとdefault title screenが作成されます。

~~~tds
scene main {
  # intro videoやdemoを再生してからtitle screenを開く場合
  start()
  goto story
}

scene story {
  say narrator "Write your story here."
  goto main
}
~~~

これは通常のTDS control flowです。`goto story` はStartを実行した後に進みます。別sceneが不要なら、storyを `start()` の直後に置いてください。到達可能なsceneは、末尾へ進む前に `goto` で遷移するか、`start()` を呼び出す必要があります。どちらもない経路がある場合、buildはblocking warningを出します。title screenを遅らせる場合は、その表示より前にvideoやdemo commandを置きます。

## Screen configuration

`start()` は既存の `game-screens.json` にあるinitial screenを表示します。そのscreenはbuttonまたは許可されたcustom screen documentを通じて、既存のstart actionを提供する必要があります。専用のscene selectorは不要です。

entry TDSはprojectの `start_file` settingで選びます。別の `titleScene` entryからfront-endを表示することはありません。screenを出す位置は、`main.tds` 内の `start()` で指定してください。

## Browser implementation

Browser Runtimeでは `start()` を非同期のhost intrinsicとして実装しています。intrinsicはpending continuationを設定し、設定済みのinitial screenを表示してscreen actionを待ちます。function内の呼び出しではfunctionとcallerのcall stackを保留し、`start()` の復帰後に評価を続けます。screen actionは別programを起動せず、保留中のcontinuationをresolveします。scenarioの実行が終わるとPlayerはscreenを自動表示・entry再起動せずにrunを終了します。

`start()` を呼び出さないprogramはentryから直接実行され、initial screenを表示しません。Debug sessionとresumeしたsaveも、指定位置より前の通常のentry flowを実行しません。

saveの復元では、記録されたsceneとsource lineから再開します。scene途中のresumeでもglobal initializerは評価しますが、その中から到達した `start()` は抑制し、表示済みのtitle screenが再度開くのを防ぎます。復元先のsource line以降にある `start()` は通常どおり実行されます。

## Native implementation

Compilerは `start()` をprogram内の通常のbuiltin callとして保持します。Native Runtimeはそのcallを実行したときにEngineのstart callbackを呼び出します。function内のcallにも対応し、Startが実行されるまでinitial screenを処理した後、同じinterpreter stackへ戻ります。通常終了時にNative Runtimeがscreenを自動表示したりentryを再実行したりすることはありません。

scene途中からDebugまたはsaveをresumeするとき、Nativeはglobal initializerを評価しますが、そこから到達した `start()` はfunction経由を含めて抑制します。復元先のscene line以降にある `start()` は通常どおり実行されます。Headless modeでは `start()` をno-opとして扱い、残りのprogramを検査できるようにします。Interactive packageで `start()` を画面表示に使うには、game-screen configurationが必要です。

## Compilerとstatic analysisのcontract

Parserは `start()` を通常のcall syntaxとして保持します。Type checkerはこの名前を引数0個、戻り値 `none` のintrinsicとして予約し、user functionとしての再定義や値としての使用を拒否します。Compilerは通常のcall instructionを生成し、各Runtimeはそのbuiltin名をscreen hostへ渡します。

このcallは実行を一時停止し、visible UI stateを変更するeffectを持ちます。Static call/effect analysisで、状態を変えないpure conversionとして扱ってはいけません。IDEはcompiled call instructionから `start()` の有無を検出し、initial screenを型付きScene Flow nodeとして表示できます。

## Scene Flow representation

entry programの到達可能な経路で `start()` を呼ぶ場合、Scene Flowは設定済みinitial screenの型付きnodeを追加し、entry fileからscreen、screenから再開後のentryへrelationを作ります。staticに到達不能なbranch、空の定数 `for` range、未呼び出しfunction、non-returning pathの後ろにあるinstructionはscreen nodeを作りません。screen edgeとresume edgeはUIの中断位置を示すもので、TDSの `goto` relationではなく、goto range validationの対象外です。

screen nodeは編集可能なTDS fileではなく、`goto` のtargetにもできません。nodeを選ぶとUI上の役割が表示され、double-clickしても存在しないsource fileは開きません。runtimeのentryはentry fileのままです。

## Compatibilityとエラー

### Malformed resume data

Browser Player は起動時に一度だけ使う resume marker を読み込み、decode の前に削除します。JSON parse または snapshot validation に失敗しても例外は握りつぶされ、entry の起動は通常どおり続き、設定済みの initial screen に進みます。ユーザーへの復旧通知はなく、ストーリー位置は復元されず、不正な一時 marker も保持されません。

Native Player では loadable snapshot がある場合のみ Continue を有効にします。破損slotは `corrupt` と表示し、操作を無効にします。Quick Load は有効な snapshot がなければ何も表示せず終了します。Quick Save は保存境界違反を検出すると、story画面の下部に3秒間通知します。一方、現在の仕様では、不正な resume marker の復旧通知や、保存位置がない場合・保存ファイルを書き込めない場合の Quick Save 通知を定義していません。Browser の marker 消費と無通知の fallback は実装上の制限です。

`test/title-screen.browser.cjs` は、Browser Player の不正な resume fallback とユーザーへの通知がないことを確認します。Native の corrupt slot 判定と無効化は `test/game-screens-native.cjs` と `test/native-save-load.cjs` で確認します。

`test/browser-continue-start-resume.cjs` は、global initializer内の `start()` を含む作品でentry外のsaveをContinueし、初期screenを再表示せず保存sceneから再開するBrowser経路を確認します。

- `start()` がない既存projectはentry TDSを直接実行し、initial screenを暗黙には表示しません。
- interactive packageで `start()` に到達したときinitial screen configurationがなければ、BrowserとNativeは「start()を使うには開始画面を設定してください」と表示します。Headless smokeやresume中の `start()` は通常のscreen表示経路ではないため、この検査条件から区別されます。
- 到達可能なscene pathが `goto` または `start()` を実行せず末尾へ進む場合、Buildはblocking warningを出します。次のsceneへ明示的に `goto` するか、front-endを出す位置で `start()` を呼び出してください。
- build checkは、少なくとも1回実行されると保証できる定数範囲のinclusive `for` を追跡します。literal `while true` は、そのfunctionから到達可能な `return` で抜けない限り後続へ進みません。条件付きloopは0回の可能性を残し、範囲を確定できないloopは保守的に扱います。nested conditionとfunction callも、sceneへ復帰する経路の判定に含めます。
- legacy `titleScene` settingはentry選択に使われません。`start_file` を設定し、`main.tds` から `start()` を呼び出してください。
- 引数を付けた `start()` はtype errorです。
- Interactive modeでscreen hostが設定されていない場合、Runtime errorになります。
- Headless modeではUI入力を待たず、`start()` の後を実行します。
