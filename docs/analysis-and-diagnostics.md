# 静的解析と診断の仕様

この文書は、現行実装の `src/checker/analyzer.ts`、`src/checker/type-checker.ts`、`src/language/builtins.ts`、IDE検証APIとScene Flowの解析連携を説明する。構文定義は[構文リファレンス](syntax-reference.md)、コンパイルは[コンパイラ仕様](compiler-pipeline.md)、IDE上の操作と診断表示は[IDE仕様](ide-spec.md)を参照。

## 1. 解析APIと診断データ

### `analyzeScript`

`analyzeScript(script, file = 'current', externalGlobals = new Map(), externalCharacters = new Map())` は `Diagnostic[]` を返す。`script` はParserの `Script` AST、外部変数は名前から `ValueType` へのMap、外部キャラクターはポーズ集合または `ExternalCharacter` へのMapで渡す。プロジェクトはexternalGlobals Mapに追加の `constraints` 情報を付与し、型情報とは別の値域検査に使う。

おおよその検査順は、(1)グローバル定数の初期評価、(2) `checkTypes`、(3)外部変数制約、(4)ランタイム状態フロー、(5)画像/動画レイヤー・背景/BGM置換・clear状態、(6)一般ブロック制御フローと値域、(7)関数未使用・戻り値、(8)シーン到達性。型検査エラーを記録しても通常は他の解析を続け、エラーと警告を同じ配列に返す。

返却配列は指定ファイル以外を先にし、`line`、`column`、severity（error、warning、info）で並ぶ。通常の位置は1始まり。診断ヘルパーはASTの `node.file` を優先し、位置がなければ1:1を使用する。ASTに `endLine` / `endColumn` がある場合のみ診断にも含むため、全診断がspanを持つわけではない。

### 診断オブジェクト

| field | 内容 |
| --- | --- |
| `code` | 機械判定用の診断識別子。文言より安定した連携キー |
| `severity` | `error` / `warning` / `info` |
| `message` | 利用者向けの説明 |
| `file` | ASTにfileがあればその値、なければAPI引数file |
| `line`, `column` | 1始まりの開始位置 |
| `endLine`, `endColumn` | ASTに終端位置がある場合に限る |
| `variable` | `variable-constraint`等の対象変数名。常に存在するとは限らない |

`errorDiagnostic` は `TypeCheckError` の位置とfileを優先する。その他の例外ではmessage中の `line N`、`column N` を抽出し、得られなければ1を使う。SyntaxErrorのcodeは `syntax-error`、その他の型検査例外は `type-error`、どちらもerror severity。type checker由来診断には通常end位置がない。

`assertAnalyzed` は `analyzeScript` を呼び、最初のerrorを `line N, column N: message` のErrorとしてthrowする。warning/infoのみなら診断配列を返す。Compiler入口ではIDE向け一覧APIというより、error時にコンパイルを止めるゲートとして使う。

## 2. 型検査 (`type-checker.ts`)

### 型と式

内部 `ExtendedType` は `ValueType | 'bool'`。`expressionType(expression, variables, ctx, expected?)` が式型推論の中心であり、期待型は空コンテナなどの要素型解決に使う。

- 数値演算は同じ数値型同士。intとfloatの暗黙変換は行わない。
- `+` は同型数値またはstr同士。比較は互換型、論理演算はboolを要求する。
- `not` の対象はbool、単項 `+` / `-` は数値。
- structのフィールド参照は宣言済みフィールドに限定。list添字はint、dict添字はstr。
- dictはキー重複を拒否し、値型を統一する。期待dict型があれば要素値型が一致する必要がある。
- listの全要素型は一致が必要。空listは文脈から型を得られない場合エラー。`inferValueType` はnone、空dict、型文脈のない空listを変数型として推論しない。
- 関数呼出しは定義・引数個数・各引数型を検査する。none戻り関数の呼出しを値としては使えない。

### 組み込みと関数効果

`PURE_BUILTIN_NAMES` は `str`, `int`, `float`, `list.length`, `list.append`, `list.contains`, `text.trim`, `text.normalize_space`, `text.split`, `text.replace`。コメント上、Browser/Nativeで同一値意味を持つ純粋intrinsicとして扱う。`text.split` のseparatorと `text.replace` のsearchが空文字と静的に確定すればtype checkerが拒否する。

Runtime State APIは実行時host intrinsicであり、pure builtinsとは別物。読み取り値は動的で、Compile APIとして公開されるものではない。定義済みsignature/effectは以下。

| API | 引数 → 戻り値 | 読み取り領域 | 条件推論metadata |
| --- | --- | --- | --- |
| `runtime.state.characters.exists` | str → bool | characters | 引数名のキャラクターが存在 |
| `runtime.state.characters.list` | なし → list[str] | characters | なし |
| `runtime.state.characters.position` | str → str | characters | なし |
| `runtime.state.background.exists` | なし → bool | background | 背景が存在 |
| `runtime.state.background.current` | なし → str | background | なし |
| `runtime.state.audio.bgm_exists` | なし → bool | audio.bgm | BGMが存在 |
| `runtime.state.audio.current_bgm` | なし → str | audio.bgm | なし |
| `runtime.state.execution.current_scene` | なし → str | execution | なし |
| `runtime.state.execution.current_file` | なし → str | execution | なし |
| `runtime.state.execution.current_line` | なし → int | execution | なし |
| `runtime.state.audio.volume` | str → float | audio.mix | なし |
| `runtime.state.ui.dialog_opacity` | なし → float | ui.dialog | なし |
| `runtime.state.variables.exists` | str → bool | variables | 引数名のbindingが存在 |
| `runtime.state.variables.names` | なし → list[str] | variables | なし |

定義のwritesは全て空。`isNonMutatingBuiltin` はpure関数とstate API双方にtrueを返すが、「シナリオ変数を書き換えない」という意味に限る。`isPureBuiltin` はstate APIにはfalse。`isBuiltinFunction` は双方をbuiltin扱いし、import alias時に再namespaceされない関数とする。

### 宣言、スコープ、文脈

`checkTypes` はstruct/asset/character/function/scene等の重複、asset pathと拡張子、volume、character properties/poses、関数再帰を検証し、その後に式・文用の型環境を組む。外部characterはstruct風型とglobal bindingとして登録され、external globalとの同名衝突を検査する。Runtime State API名は関数名として予約される。

文脈上、global blockは宣言を許可し、scene宣言がない場合は暗黙シーンとしてgoto/choiceを許す。関数内はgoto/choice禁止、return許可。scene内はgoto/choice許可、returnと変数宣言は禁止。関数parameter名は重複できない。readonly external globalは変更不可だが、関数parameterが同名ならparameter側のbindingとなる。

条件式はtruthy値では足りず、比較演算 `== != > >= < <=` または論理式を要求する。`checkRecursion` は関数call graphをDFSで走査し、再帰経路を含むTypeCheckErrorを出す。

### コマンド固有検証の例

`checkCommand` はコマンドごとの識別子・引数・範囲も検証する。表示コマンドの識別子はリテラルであること、`--only` / `--layer` は重複や不正順序を持たないこと、layerは0以上8未満で小数第3位までであること、volume/dialog opacityはfloatの0..1であることを要求する。アセットIDは宣言済みかつ期待kindと一致する必要がある。durationはint millisecondで0..2147483647、character offsetはx/y各1回、±1,000,000px以内。これらはtype-check/compileを拒否する規則で、analyzerの警告とは別層。

## 3. 定数・値域・effect解析 (`analyzer.ts`)

### 定数評価と整数境界

`constant` は限定されたcompile-time evaluator。finite number、bigint、string、booleanを返し、literal/const variable、単項符号/not、比較、整数と小数の `+ - * /`、整数 `%`、string連結、短絡and/orを扱う。builtinでは単引数 `str` / `int` / `float` の安全な変換を評価する。一般関数呼出しや不明な変数値は定数にしない。

整数はsigned 64-bit、−2^63 .. 2^63−1。`checkedInteger` は演算結果を都度範囲検査し、最小値を作る `-9223372036854775808` の特殊表現を考慮する。小数結果がfiniteでない場合は `float-overflow`。不明な値を定数と誤認せず、範囲が不十分なら診断severityをwarningへ弱めるか、証明できない診断を出さない。

### 値域と条件の絞り込み

制約domainはint/float/strで、数値のmin/max、int/strの有限 `values`、floatの `floatValues` を持ち得る。flow中に得た条件制約と宣言制約を分けて管理する。比較の変数が右側でも演算子を反転して処理する。`not` は条件反転、真側のandおよび偽側のorは左辺から順に制約を適用する。有限候補全てを検査して真偽を確定するほか、min/max全体が同じ側にある比較も確定可能。

分岐後のjoinでは到達可能パスの共通事実に弱める。片方だけ到達可能なら到達側を維持。有限候補数 `MAX_STATIC_NUMERIC_VALUES` は64で、集合演算がこの上限を越える場合は列挙をやめる。ループ等も反復状態をjoin/widenし、解析を有限にする。これは任意の計算式を証明する定理証明器ではない。

### purity、関数effect、条件fact

`isPureExpression` はpure builtinを含む式の条件結果を安定factとして記録する。比較factと逆条件、notの反転、真のandの各辺、偽のorの各辺を伝播する。effectful関数呼出しを含む条件は、無条件に再利用可能なfactとしない。

`functionEffects` は関数本体のglobal write集合を求め、関数call graph上のcallee writesを推移合成する。解析中の `activeFunctionEffects`, `activeFunctionDefinitions`, `activeGlobalNames`, `activeFunctionCallStack` がcall-site再評価・再帰防止に使われる。callが書き換えないと分かる変数のfactsは維持可能だが、書込み対象の値域/factsは無効化または拡張する。Runtime State APIはシナリオ変数を書かないが、読み取るruntime stateは静的定数ではない。

### runtime state / presentationのflow

`IDE_ANALYSIS_RULES` はシナリオ構文/APIではなく、IDE診断規則の定義。runtime state APIのguard情報に基づき、既知状態と矛盾する分岐に `unreachable-runtime-state-branch` infoを出す。character presence guardは `runtime.state.characters.exists(name)`。

`analyzeRuntimeStateFlow` はcharacter表示位置slot、character presence、variable binding依存、背景/BGM等のstateを追う。showはslotを占有し、同一slotのcharacter競合を警告する。moveはshow済み、またはruntime guardによる存在証明があるかを検査する。hide/clearは各経路の状態を更新する。関数内でcharacterをmoveする場合のpresence依存を呼出位置で検査するため、`unproven-character-presence-at-call` が発生し得る。if/elif/elseとchoiceの各経路を解析してjoinする。関数ではparameter presence、sceneではglobal bindingを初期状態として与える。画像slot、背景/BGM置換、background/BGM clear divergence、単一video layer置換は別のflow解析関数で走査する。

## 4. 診断code一覧

診断messageは日本語/英語表記が変更され得る。連携側はcodeとseverityを使う。

| code | severity | 条件 |
| --- | --- | --- |
| `syntax-error` | error | IDE serverのparse失敗またはSyntaxError |
| `type-error` | error | TypeCheckError等の型/意味検査失敗 |
| `missing-return` | error | none以外を返す関数で全経路returnを証明できない |
| `duration-range` | error/warning | durationが0..2147483647ms外。候補全て外ならerror、一部ならwarning |
| `presentation-offset-range` | error/warning | presentation offsetの確定/可能範囲が許容外 |
| `variable-constraint` | error/warning | 変数テーブル制約への代入。完全逸脱error、可能逸脱warning。対象名を `variable` に保持 |
| `integer-overflow` | error | 定数式またはループ更新/反復で64bit overflow |
| `float-overflow` | error | 小数演算結果が有限値でない |
| `division-by-zero` | warning | 定数/可能値から0除算または剰余を検出 |
| `invalid-conversion` | error/warning | 静的に不正な変換。valid/invalid候補混在時warning |
| `invalid-for-step` | error | stepの符号/値でstartからstopへ進めない |
| `loop-limit` | warning | 実行時上限100,000回を越えると証明 |
| `infinite-loop` | warning | while条件が常真かつ本体が後続へ抜けない |
| `constant-condition` | warning/info | 常偽branchはwarning、常真branchはinfo |
| `duplicate-condition` | warning | 前のbranchと同一条件 |
| `unreachable-branch` | warning | 前条件に包含、または前条件が常真 |
| `non-exhaustive-condition` | warning | 既知有限値全体をbranchで扱わない |
| `unreachable-code` | warning | transfer/return/終端loop後の文 |
| `unreachable-scene` | warning | scene graphで到達しないscene |
| `unreachable-runtime-state-branch` | info | runtime state factsに矛盾する枝 |
| `unused-variable` | warning | 関数内の変数/引数が未使用 |
| `self-assignment` | warning | 変数を同じ値で再代入 |
| `duplicate-choice-label` | warning | choiceの静的label重複 |
| `character-slot-conflict` | warning | character表示slotを既存characterが占有 |
| `move-unshown-character` | warning | presence proofのないcharacterをmove |
| `unproven-character-presence-at-call` | warning | characterをmoveし得る関数呼出しでpresence未証明 |
| `hide-unshown-character` | warning | show済みでないcharacterをhide |
| `image-slot-conflict` | warning | image slotに既存imageがあり重なる |
| `clear-unshown-image` | warning | show済みでないimageをclear |
| `background-replacement` | warning | clearせず背景を置換 |
| `bgm-replacement` | warning | clearせずBGMを置換 |
| `move-unset-background` | warning | 未設定backgroundをmove |
| `bgm-clear-path-dependent` | warning | BGMなしの経路ではclearがno-op |
| `background-clear-path-dependent` | warning | 背景なしの経路ではclearがno-op |
| `video-layer-replaced` | warning | 単一video layer上のasync videoを置換 |
| `project-error` | error | IDE serverでinclude、asset、compile等のproject errorを診断化 |

`CALL_CONTEXT_DIAGNOSTICS` は `duration-range`, `presentation-offset-range`, `variable-constraint`, `non-exhaustive-condition`, `integer-overflow`, `float-overflow`, `division-by-zero`, `invalid-conversion`, `invalid-for-step`, `loop-limit` の集合。関数呼出し文脈で再評価/重複抑制に関連するコードを示し、全診断一覧を意味するものではない。

### 制約解析例

```tds
if difficulty >= 1 and difficulty <= 3 {
  set difficulty = difficulty + 1
}
```

枝内ではdifficultyのdomainを絞り、代入後の候補域を外部variable tableの宣言制約と比較する。すべて範囲外なら `variable-constraint` error、一部候補が逸脱するならwarning。枝を出る時点で生存パスをjoinする。ループ検査は終端値だけでなく繰返し中の更新overflowも見るが、未知effectや64値上限超過で正確な証明を失う。

## 5. IDE、build、Scene Flow連携

### `POST /api/validate`

`Edit/server.js` のrouteは `{source, name}` を受け `validate(source, sceneName(name), null, true)` を呼ぶ。`collectSyntaxDiagnostics` は失敗行を空白化して再parseし、最大min(行数,100)回まで複数syntax errorを回収する。構文診断があれば意味解析へ進まず返す。

構文成功後 `resolveProjectScript` がincludeを解決し、asset宣言pathの存在とproject内安全性を別途検証する。global variable/character tableからproject contextを作り、static declarationがあれば解析用ASTのglobals/body先頭に合成する。`analyzeScript` のerrorがあれば `ok:false`。errorなしなら警告/infoを返却に残しつつ、`compileSource` も実行する。成功応答は `ok`, `diagnostics`, `statements`, `instructions` を返し、includeProgram指定時はprogramも含む。compileやproject resolution errorはserver側で `project-error` 等へ変換される。

### `POST /api/compile`

IDEからのcompile要求はprogramを得る入口。compilerは `assertAnalyzed` を通るのでerror severityがあれば拒否、warning/infoは拒否理由にならない。`/api/validate` はcompile成功も確認するため、純粋なchecker出力だけの検証より広い。

### `GET /api/flow-domains`

queryは `file`, `scene`, `line`, comma区切りの `names`。lineは1以上のinteger、namesは識別子形式に限定し最大128件。serverは対象AST/scene行範囲を検査し、configured variable constraintsを読む。`analyzeScript` でその制約を破る `variable-constraint` が出た名前はtrusted constraint mapから除外し、不正な前提で可視化しない。次に `analyzeStartDomains(ast, scene, line, names, configured.declarations, true, trustedConstraints, definitions, globalNames, globalVariables)` を呼ぶ。Scene Flowは選択ファイルをfresh runtime entryとして起動し、そのglobal初期化後に指定scene/lineの値域を見る前提。

`GET /api/scene-graph` も `sceneReachability` を利用し、診断をscene nodeに保持する。Flow図のdiagnostic UIは `Edit/flow.js`、通常エディタの一覧・行装飾・navigationは `Edit/editor.js`。IDEはseverity/code/message/file/line/columnを使用するので、code追加は絞込み・関連表示への影響も見る必要がある。

## 6. 保証範囲と制限

- 動的入力や実行時host stateを一般に確定できない。未知状態は保守的にunknownとして扱う。
- 有限候補列挙は64件まで。制御フローjoinとloop wideningを使うため、全実行を列挙するわけではない。
- `constant` / `checkedInteger` は限定演算のみ。ユーザー関数の戻り値を一般に定数伝播しない。
- type checkerとanalyzerとserver project validationは別段階。それぞれの診断code/severityは同じとは限らない。
- `sceneReachability` はscene遷移解析であり、実際のproject起動やfile解決全体の代替ではない。
- 診断spanの終端は任意。IDEが描画時に行範囲を補完する場合があり、診断payloadのspan保証とは異なる。

## 7. テストソース上の根拠

主な回帰テストは `test/parser.test.js`, `test/runtime.test.js`, `test/project-layout.test.js`, `test/standard-library.test.js`。

- parser tests: `analyzes constant builtin conversions for flow and range safety`、duplicate condition、loop-limit、while/for中間overflow、non-terminating loop。
- runtime tests: runtime-state branch、character presence warning、`/api/validate`のfile-aware syntax/project diagnostics、constraint globals、branch join、関数の直接/間接global write effect、short-circuit facts。
- project-layout tests: configured variable constraints、character/image slot conflict、background clear path divergence、video layer replacement。
- standard-library tests: include alias後のeffect/presence proof、関数call越しのcharacter guard。

これらはテストファイル内のテスト名・アサーションを調査した根拠。今回テストは実行していない。

## 8. 調査範囲

直接確認した主要箇所は `src/checker/analyzer.ts`（定数、制約、effects、runtime state、block解析、`analyzeScript` / `assertAnalyzed`）、`src/checker/type-checker.ts`（式/文/コマンド検査、`checkTypes`）、`src/language/builtins.ts`、`Edit/server.js`（validate/compile/flow-domains/scene-graph）、`Edit/editor.js`・`Edit/flow.js`（診断連携）、上記テストの関連部分。

未調査範囲: Browser/Native runtime intrinsicの完全な意味同値性、全compiler命令変換、全コマンドの引数行列と各エラー文言、診断UIのCSS/アクセシビリティ詳細。各領域は[コンパイラ仕様](compiler-pipeline.md)、[UI仕様](ui-runtime-spec.md)、[IDE仕様](ide-spec.md)を参照。
