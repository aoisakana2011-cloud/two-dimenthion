# コンパイラ・解析・パッケージ仕様

この文書は現行実装の動作を記述する。入口は単一ファイルの `parse(source) -> compile(script)` と、プロジェクト全体を解決する `tools/project.js` / `tools/pack.js` で異なる。エディタの解析結果が成功しても、include・外部シーン・画像ファイル・変数初期化順を検証する pack が成功したことにはならない。

## 1. 処理段階と成果物

```text
source text
  Lexer.next/tokenize -> Token[]
  Parser -> Script(AST)
  type checker + analyzer -> ASTへの解析状態 / diagnostics
  project resolver (pack時) -> include展開済みScript、外部宣言環境
  Compiler -> CompiledProgram (NSP program version 2)
  pack -> package envelope version 1 + files + copied assets
  Edit/runtime.js または native player -> 実行
```

各段階の責務は独立している。`parse` は文法とASTを作るが、assetの実在やgoto到達先を保証しない。`compile` は解析済みScriptを要求し、未解析なら `assertAnalyzed(script, 'current', externalGlobals, externalCharacters)` が拒否する。`pack` はすべての `.tds` を列挙し、各ファイルを個別コンパイルしたうえで遷移可能性、変数フロー、asset、安全な出力先を検証する。

## 2. Lexer / Parser が Compiler に渡すもの

実装は `src/parser/{lexer,parser,ast}.ts`。lexer は `Lexer.next()` で位置を進め、`tokenize()` は EOF までのtoken列を返す。tokenには種別、値、offset、行・列があり、parser diagnosticとIDEの位置表示に使われる。Parserはトップレベル宣言、関数、シーン、ブロック文、式を `kind` 判別子付きASTにする。式・statement・asset・character・sceneにはソース位置が付く場合があり、project resolverは `tagLocations` でファイル名を再帰付与する。

`include` は通常の `parse` が解決する命令ではなくプロジェクト機能である。include先のstruct型をシグネチャ解析時に利用するため、`scanTopLevelDeclarations()` がtoken形状からtop-levelのstruct/function/includeを先読みし、`collectIncludedStructs()` がstruct名を再帰収集する。その後 `resolveProjectScript()` が完全parseする。したがって先読み結果は文法検証の代替ではない。

## 3. Checker / Analyzer の契約

`src/checker/type-checker.ts` は式・宣言・代入・関数引数と戻り値などの型整合性を検査する。project packでは `tools/pack.js` が `inferValueType()` を使って、global `infer` 宣言を依存順に解決する。解決不能の循環や失敗が残れば最後の推論エラーでpackを中断する。ローカル宣言の型推論は型確定済みでなければCompilerが `CompileError` にする。

`src/checker/analyzer.ts` は診断と静的事実の追跡を担い、実行器ではない。Diagnosticは `file`, `code`, `severity` (`error | warning | info`), `message`, `line`, `column`, `endLine`, `endColumn`, 任意の`variable`を持つ。整数定数はBigIntで計算し、符号付き64bit範囲を意識したoverflow判定を行う。制約domainは整数の`min/max`、有限`values`、floatの`floatMin/floatMax/floatValues`、文字列の有限値を保持し、分岐条件の到達性・網羅性、関数引数や時間指定の検査に使う。有限数値集合は最大64候補まで扱う。Presentation offsetの静的上限は1,000,000px、timed commandの上限は2,147,483,647ms。

解析は同じ変数について条件でdomainを絞り、if/elseの全経路を合流する。`and`/`or`、比較の左右反転、有限値集合、整数範囲を用いるが、未知値を真偽どちらかに決めつけない。関数呼び出しは `isPureExpression` 等のeffect情報を使い、呼び出し副作用を含む式から安全でない定数事実を導かない。これは診断やIDE補助のための静的推定で、実行時の保証ではない。

## 4. `CompiledProgram` (NSP program version 2)

型定義は `src/compiler/compiler.ts` 冒頭の `CompiledProgram`。JSONのprogram本体は次のフィールドを持つ。

| field | 内容 |
|---|---|
| `version` | `2`。instruction/expression構造のバージョン |
| `assets` | AST由来のasset宣言 |
| `characters` | character定義。property式はruntime globals側で初期化し、ここはproperty本体を除いた定義情報。include由来の外部characterには`external: true` |
| `globals` | ファイルglobal初期化命令 |
| `functions` | 関数命令の配列 |
| `scenes` | `{name,file?,line?,instructions}`の配列 |
| `variables` | IDE/Flow向けの変数定義・参照情報 |

program version 2とpackage envelope version 1は別のversionである。packの外側は `{format:'novel-script-package', version:1, source, debug?, program, files, native_ui}`。`files`はgoto先を含むファイル別CompiledProgram辞書であり、entryの`program`と同一のものではない。

`variables`の各要素は`name`, `type`, `scope` (`global|function|scene|local`), `definedIn`, `definitions[]`, `references[]`, `mutable`を持つ。各locationは`file/line/column/scope/container/kind`を保持する。referenceは式、代入先、文字列補間を辿って収集され、interpolationの変数は`kind:'interpolation'`。`const`宣言は`mutable:false`となる。これはソースマップ的な補助情報で、命令の実行意味そのものではない。

## 5. 式と命令の完全な形

整数はJavaScript JSONで安全なNumberに変換せず、`{kind:'integer', value:'9007199254740993'}` のように10進文字列で直列化する。floatも `{kind:'float',value:'1.25'}`。その他の式は次のunion。

| `CompiledExpr.kind` | fields | 例 / 用途 |
|---|---|---|
| `literal` | `value` | string / boolean等 |
| `load` | `name` | 変数参照、または代入可能な変数target |
| `index` | `target`,`key` | `items[i]`, `record.name` |
| `binary` | `operator`,`left`,`right` | 算術、比較、論理 |
| `unary` | `operator`,`value` | `not`, 単項符号 |
| `call` | `name`,`args[]` | 組み込み/ユーザー関数 |
| `dict` | `entries:[{key,value}]` | 順序付きkey-value要素 |
| `list` | `items[]` | list literal |

命令は`op` discriminatorを持ち、位置`file?`,`line?`が結合される。statement生成箇所は`Compiler.statement()`。

| op | payload | AST対応 |
|---|---|---|
| `declare` | `type,name,initial?,constant?` | 宣言 |
| `set` | `target,value` | 変数またはindexへの代入 |
| `unset` | `target` | 要素の解除 |
| `command` | `name,args[]` | `say`, `wait`等のランタイムcommand |
| `parallel` | `body[]` | 並行ブロック |
| `if` | `condition,body,elseIf:[{condition,body}],otherwise[]` | 条件分岐 |
| `for` | `name,start,stop,step,body` | 範囲loop |
| `forEach` | `name,iterable,body` | iterable loop |
| `while` | `condition,body` | 条件loop |
| `choice` | `prompt?, options:[{label,body}]` | 選択肢 |
| `function` | `name,returnType,params:[{type,name}],body` | 関数定義 |
| `call` | `name,args[]` | 手続き呼び出しstatement |
| `return` | `value?` | return |
| `goto` | `scene` | scene/file遷移 |

命令unionには汎用の`body`だけでなく`elseIf`, `otherwise`, `options[].body`がある。packのgoto走査とruntime双方がこれらの入れ子を処理する必要がある。

## 6. Compile処理の順序とdebug差

`compile(script, externalGlobals = new Map(), externalCharacters = new Map(), debug=false)` は、解析済み検査→character暗黙global構築→変数metadata構築→raw命令生成→function effect算出→最適化→program組立の順。

1. `assertAnalyzed` は現行入力・外部global/character環境で解析済みかを確認。
2. characterは`character:<name>` struct型の暗黙global宣言へ変換される。外部character定義も同じく初期化命令を持つが、metadataでは`external:true`となる。Scene Flowから任意ファイルを直接起動する場合もcharacterの既知propertyを用意するため。
3. `Compiler.variables()` はスコープを辿りmetadataを作る。`infer`が未解決なら失敗。
4. `Compiler.statements()` / `.function()` がASTを前節のunionへ変換。
5. const global初期化を`immutableGlobals`に収集し、`functionWrites()`で各関数が直接または呼び出し経由で書くglobal集合を固定点計算。
6. `debug=true`ではraw命令を返す。通常時は`optimizeInstructions()`をglobals/functions/scenesごとに呼ぶ。

globalはscene遷移時に既存値を保持するため、`preserveDeclarations:true`で宣言初期値に基づく伝播を抑える。関数はparameter名をlocalとして除外し、sceneはconst global環境を使うが宣言を保持する。debug packageは外側にも`debug:true`を付ける。debugはsource ASTそのものではなく、Compiler生成後・最適化前の命令を保存する。

## 7. Optimizer: 定数・effect・分岐・制約

最適化の入口は`optimizeInstructions()`。サポートしない計算や不明な状態はそのまま残す。整数定数はBigInt、floatは有限Number、string/booleanも扱う。`foldExpression()`はliteral、load、unary/binary、index/list/dict/call配下を再帰処理し、評価できればliteralへ置換する。組み込み`str`/`int`/`float`の一部も評価し、int変換は符号付き64bit範囲に制限される。短絡`and`/`or`は左辺で決まる場合、右辺を評価しない。

副作用保全は`hasImpureCall()`と`isNonMutatingBuiltin()`に基づく。補間文字列に`{fn()}`のような関数呼び出しがある場合もeffect扱い。純粋でない呼び出しを含む式は既知const環境を空にしてfoldするため、例えば `mutate() == 0` の評価で古いglobal値を使わない。`functionWrites()`は各関数の直接global set/declareと呼び出し先のeffectを反復伝播し、再帰呼び出しを含むcall graphも固定点まで合成する。呼び出し後は該当functionの書込みglobalに関するconst/domainを無効化する。

`constrainedCondition()`は定数式でない条件も制約domainから判定する。整数は`min/max`と有限`values`、floatは境界と`floatValues`、str/intの有限集合を利用する。`and`/`or`と否定を合成し、比較の反転も行う。未解決な経路は`undefined`のまま保つ。`refineCompiledConstraints()`は条件のtrue/false側に入る変数domainを絞り、分岐後は`mergeCompiledConstraints()`で全生存経路に共通する情報へ合流する。

範囲forは`compiledIntegerBounds()`でstart/stop/stepの境界を推定する。stepが単一の非ゼロ値ならloop変数domainを得る。stepが0、または範囲を推定できない場合は変数制約を失効させる。`definitelyTerminates()`はreturn/goto、全分岐が終端するif、全選択肢が終端するchoiceなどを認識し、到達不能な後続命令を除外可能にする。`preserveDeclarations`やlocals境界のため、同じ条件でもglobal init・scene・functionで結果が異なるのは意図された意味差である。

## 8. プロジェクトinclude / goto解決

`resolveProjectScript()`はincludeを再帰展開する。moduleはsceneを宣言できず、global部には宣言以外を置けない。関数はinclude aliasでqualifyされ、例えば`include math.tds as m`の`add(1,2)`が`m.add(1,2)`になる。builtin名はalias化しない。入れ子includeの呼び出し名もmodule境界ごとに変換される。moduleのassets, characters, structs, globals, functionsは呼び出し元Scriptに合成される。重複include、循環include、alias不正、外部scene定義はエラー。

`sceneFile()`は区切りを`/`に正規化し、`.tds`以外の`.txt`、絶対パス、`.`/`..`、Windows予約名、不正文字などを拒否する。`inside(root, relative)`はrealpathとlstatを検査し、通常file以外、symlink、hardlink (`nlink > 1`)、root外解決を拒否する。assetsも同じroot境界検査を受ける。assetパスはscript内では`asset/...`として保持し、実体解決時にprefixを取り除く。

packはscenario root以下の全`.tds`を先にparseし、`main.tds` globalsおよび明示globalだけをプロジェクト共通変数に集める。global inferは関数情報を使って依存順に解決する。各fileは自分の宣言を外部global表から除いて二重定義を防ぎ、自分のcharacter定義も外部表から外す。entryからgotoを再帰走査して到達ファイルを`files`へ追加し、各ファイルの命令中の`goto`はローカルscene名またはscenario fileとして検証する。`validateVariableFlow(files, entry)`はファイル間遷移時の変数初期化可能性を調べ、例えば遷移先fileが実行前に宣言されるglobalを参照するケースを拒否する。単一file compileではこの全体到達・初期化検査は行われない。

## 9. Pack出力、安全境界、UI resource

出力JSONは `{format:'novel-script-package',version:1,source,debug?,program,files,native_ui}`。全`files`のprogram assetsとcharacter pose assetsを一意化して`<package dir>/asset/...`へコピーする。出力ディレクトリのrealpathがpackage root内にあること、既存出力が通常の未link fileであることを確認する。project layout経由では設定された`scenario_dir`/`asset_dir`もproject root境界内であることを検査する。

`.novel/variables.json`由来の静的globalは型、readonly名、制約domainをtableへ読み込み、static declarationsとして各pack programに実際のglobal命令として挿入する。これはcheckerにだけ見せる仮想名ではない。character全件の重複定義、global名重複、型推論不能もpack失敗。

`native_ui_theme`があれば`asset/ui/player-ui.json`へコピーし、package metadataに`native_ui_theme:'ui/player-ui.json'`を設定する。game screen設定がある場合はschema検証し、stylesheet/control settings/template等の` screens/`相対pathを確認して`screen-document` compilerでBrowser/Native用screen JSONを生成する。UI画像・tree内src・background-image・control skin画像もassets root内から出力先へコピーする。これはCompilerのNSP program schemaとは別のpackage resource処理。

## 10. Runtime接続と互換性境界

Browserは`Edit/runtime.js`、Nativeは`native/runtime.hpp`等が同じCompiledProgram/commandの意味を実装する。NSP v2は2 runtime間の受け渡し形式だが、描画API、画像decode、音声・動画、フォント、レイアウト、保存、OS統合が同一という意味ではない。debug位置やvariables metadataをruntimeが必ず表示するとも限らない。整数文字列は両方でBigInt相当の範囲・演算を維持する必要がある。

過去の差異記録としてdictionary alias/call parameterの参照意味、`int("+-1")`の受理差があるため、共有schemaだけを根拠に意味完全一致とは主張できない。該当変更ではBrowser runtime testとNative differential/smokeを別々に実行する。mock runtime上のCompiler testだけではGUI/OS media flowまで検証しない。

## 11. テスト対応表

| 対象 | 主なテストと確認境界 |
|---|---|
| token/grammar/AST | `test/parser.test.js`, `test/language-reference.test.js`。字句位置、構文、診断・参照言語の契約 |
| 型・静的診断 | `test/audit-regression.test.js`, `test/global-scope.test.js`, `test/standard-library.test.js`。解析条件、global scope、library呼び出し |
| compileと最適化意味 | `test/compiler-differential.test.js` は128 seedで生成されたif/while/for/function/effect例の実行値を照合。`test/runtime.test.js` は定数fold、BigInt、分岐・loop・effect invalidation、NSPロード等を確認 |
| include / file graph / flow | `test/runtime.test.js` と `test/scene-graph-include-scope.test.cjs`。alias、循環/重複、goto到達、初期化前global、Windows separator |
| filesystem境界とpack設定 | `test/project-layout.test.js`, `test/project-settings-security.test.js`, `test/full-workflow-e2e.cjs`。root外path、symlink/hardlink、設定、安全なasset copy |
| Browser runtime | `test/browser-check.cjs`, `test/runtime.test.js`。実ブラウザ確認とRuntime単体境界を区別 |
| Native runtime | `test/native-smoke.cjs`, `test/native-title-scene.cjs`, `test/runtime.test.js` (NOVEL_NATIVE_EXE設定時)。native playerを通る実行・媒体確認 |

テスト名だけでは現在の実行結果を示さない。ドキュメント更新自体ではsuiteを実行していない。compile最適化を変更したらcompiler differentialとruntime、pack/includeを変更したらproject/flow/security、command semanticsを変更したらBrowserとNativeの該当経路を選ぶ。

## 12. 変更時に守るべき不変条件

- AST変更時は`Compiler.statement/expr`、checker、analyzer、formatter/IDE利用箇所も追う。
- instructionフィールド変更時はBrowser runtime、Native runtime、packの再帰走査（特に`elseIf`と`options[].body`）、保存データ読込を追う。
- optimizer変更時は副作用関数のglobal write invalidation、short-circuit評価、debug=true raw出力、scene transition時の`preserveDeclarations`を回帰確認する。
- pack変更時は単体compile成功では不十分。全scenario graph、include alias、external character、static variables、asset実コピー、path境界を検査する。
- `version:2`の命令schemaと`version:1`のpackage envelopeを混同しない。外部reader/runtimeを更新する場合は両versionを明示的に扱う。
