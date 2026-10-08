# プロジェクト形式とパッケージ化

本書は、プロジェクトのディレクトリ構成、設定ファイルの解決、複数ファイルにまたがるコンパイル、生成インデックス、ビルド状態の記録、`.nsp.json` の生成について、現行実装を説明します。主な参照元は `tools/project-layout.js`、`tools/project.js`、`tools/pack.js`、`tools/static-variables.js`、`Edit/server.js` です。

## 1. 用語と対象範囲

- **プロジェクトルート**: `--project`、`NOVEL_PROJECT_ROOT`、検出された `setting.txt`、またはリポジトリ既定の `Title/` から選択されるディレクトリです。
- **シナリオルート**: `scenario_dir` が示すプロジェクト相対ディレクトリです。既定名は `senario`（`c` は1文字）で、`.tds` ファイルを置きます。
- **アセットルート**: `asset_dir` が示すプロジェクト相対ディレクトリです。既定名は `asset` です。
- **設定ルート**: 通常は `<project>/setting`、旧レイアウトではプロジェクトルートそのものです。
- **データルート**: `<project>/.novel` です。プロジェクトメタデータ、生成インデックス、ビルド成果物を置きます。
- **エントリ**: 既定ではCLIとEditor Buildのどちらも、シナリオルート配下の `start_file` を使います。CLIは最初の位置引数で、Editor Buildは要求された場合の `name` でentryを上書きできます。`game-screens.json` の初期画面を出す位置はentry TDS内の `start()` で指定します。
- **パッケージ**: `format: "novel-script-package"`、version 1、エントリの `program`、シナリオルート内の全 `.tds` ファイルを格納する `files`、UIメタデータを持つJSONです。参照アセットはパッケージの隣にコピーされます。

本書はJavaScript実装の現状を記述します。例は現在受理される形式を示すもので、すべての任意設定にGUI編集機能があることを保証するものではありません。

## 2. プロジェクトルートの選択と作成

### 2.1 ルート選択の優先順位

`tools/project-layout.js` の `projectOption(args)` は、引数から最初の `--project <directory>` を探します。なければ `process.env.NOVEL_PROJECT_ROOT` を返します。どちらもない場合、呼び出し側はリポジトリ既定の `Title/` を使います。`--project` の値がない場合、または直後が別オプションの場合はエラーです。

`projectLayout(root)` はルートを絶対パスにし、設定を読み、各種ルートを計算します。`layoutForInput(file)` は入力ファイルの親から上位へ探索し、`setting/setting.txt` またはルート直下の `setting.txt` があるディレクトリを探します。その後、ファイルがそのレイアウトのシナリオルート内にあることを確認します。設定済みシナリオルート外の任意の `.tds` ファイルからは、プロジェクトを推定しません。

`entryFile(layout)` は `scenesRoot` と `settings.start_file` からエントリの絶対パスを作ります。字句上のパスがシナリオルート外に出る場合は拒否します。返却時点では対象ファイルの存在までは確認せず、実際の読込み・ビルド時に確認します。

### 2.2 新規プロジェクトの初期化

`seedEmptyProject(root)` はプロジェクトルートを作成します。旧形式のルート直下 `setting.txt` が存在しない場合、現行形式の初期ファイルを作ります。

```text
project/
  setting/setting.txt
  setting/README.md
  setting/asset-folders.txt
  setting/game-screens.json
  senario/main.tds
  asset/bg/README.txt
  asset/{bg,bgm,char,image,se,video,voice}/
  .novel/
```

設定テンプレートには `scenario_dir = senario`、`asset_dir = asset`、`start_file = main.tds` とディレクトリ名由来のタイトルが入ります。`main.tds` には `scene main` の例を作成し、`setting/game-screens.json` には `start()` から開く初期Start screenを生成します。`setting/player-ui.json` は初期化時には作成せず、未作成の場合はエディターAPIが既定テーマを返します。

初期化時のREADMEは `player-ui.json`、`game-screens.json`、画面文書、任意の `story-adaptation.md`、静的変数、保存場所などの慣例も説明します。

ファイルは排他的な `wx` 作成で作り、作成後に検査します。既存ファイルは上書きしません。ディレクトリと管理対象ファイルのシンボリックリンク／ハードリンク検査は§10を参照してください。

## 3. レイアウトの新旧形式と互換性

### 3.1 現行レイアウト

`<root>/setting/setting.txt` が存在すると、ルート直下に旧形式の設定ファイルがあっても、入れ子側が優先されます。`legacySettings` は `false`、`settingsRoot` は `<root>/setting` です。

| 項目 | 現行の場所・解釈 |
|---|---|
| プロジェクト設定 | `setting/setting.txt` |
| Player UIテーマ | `native_ui_theme` が示す設定ルート相対パス。慣例は `setting/ui/player-ui.json` |
| ゲーム画面設定 | `setting/game-screens.json` |
| 画面テンプレート・スタイル・制御設定 | ゲーム画面設定から参照される設定ルート相対パス。慣例上は `setting/screens/` 以下 |
| シナリオソース | `<scenario_dir>/**/*.tds` |
| プロジェクトアセット | `<asset_dir>/**` |
| 静的変数と生成インデックス | `.novel/variables.json`、`.novel/variables.schema.json`、`.novel/assets.json`、`.novel/assets.schema.json` |
| ビルド成果物と状態記録 | `.novel/build/` |

現行レイアウトをパッケージ化すると、`native_ui_theme` はパッケージメタデータでは `ui/player-ui.json` になります。設定ルートのテーマファイルは、パッケージ隣の `asset/ui/player-ui.json` にコピーされます。現行の `game-screens.json` も設定ルートから読み、実行時用データにコンパイルして `asset/ui/game-screens.json` に書き出します。

Player UIテーマ内の画像パスは、現行レイアウトではBrowser実行時と同じくプロジェクトの `asset/` ルートから解決します。パッケージではテーマJSONが `asset/ui/` に置かれるため、packerは入力画像を `asset/<theme image path>` から読み、テーマJSONの相対参照が維持される `asset/ui/<theme image path>` へ配置します（パスが既に `ui/` で始まる場合は二重に付けません）。旧レイアウトではテーマと画像の両方が `asset/` 内にあり、画像パスはテーマファイルのディレクトリを基準に解決・コピーします。会話枠、ネームプレート、選択肢、操作ボタン画像にこの規則を適用します。

### 3.2 旧レイアウト

入れ子側の設定がなく、`<root>/setting.txt` がある場合、`settingsRoot` はプロジェクトルート、`legacySettings` は `true` です。これは実装されている互換経路であり、新規作成時の標準形式ではありません。

パッケージャーは旧形式の画面設定を `asset/ui/game-screens.json` から探します。旧形式のテーマパスは `assetsRoot` 配下として解決します。旧形式ではUI設定等をコピーする経路になり、現行形式の設定ルート文書コンパイル経路とは同じ扱いではありません。パッケージのUIテーマ項目も、旧形式では設定値のパスを保持する場合があります。

テーマJSONはNative UI metadataが示す相対パスにコピーします。旧形式で `native_ui_theme = ui/custom-theme.json` とした場合、packageには `native_ui.native_ui_theme: "ui/custom-theme.json"` と `asset/ui/custom-theme.json` の両方が含まれます。

設定ファイルが移動済みでも、関連する設定文書すべてが移動済みとは限りません。実際の画面・テーマ参照元は `tools/pack.js` の `legacySettings` 分岐を基準にしてください。

### 3.3 新旧両方の設定ファイルがある場合

`setting/setting.txt` があればそれが選ばれます。欠落先を指すdangling linkは `existsSync` では存在しないものとして扱われるため、旧形式のルート直下 `setting.txt` があればそちらへfallbackします。`looksLikeProject` は新旧いずれかの存在を判定しますが、優先順位の処理は行いません。初期化処理は新しい入れ子ファイルを作る前に、旧形式のルート直下 `setting.txt` の有無を調べます。そのため、旧プロジェクトを現行形式へ移行するときは、現行シーダーを無条件に実行するのではなく、移行手順を明確にしてください。

## 4. `setting.txt` の文法とパス制約

`parseSettings(source)` はUTF-8テキストを行単位で読みます。各行の未escapeの `#` 以降をコメントとして除去し、前後空白を削除し、空行を無視します。値に `#` を含めるときは `\#` と書きます。設定行は次の形式です。

```text
lowercase_key = value
```

キーは `[a-z][a-z0-9_]*` に一致する必要があります。認識するキーは `scenario_dir`、`asset_dir`、`start_file`、`native_ui_theme`、`title` です。未知のキーと同一キーの重複はエラーです。`scenario_dir`、`asset_dir`、`start_file` は必須です。値はトリム後の文字列として扱います。引用符の構文はありません。`\#` だけは文字の `#` として扱います。

例:

```ini
scenario_dir = story/scripts
asset_dir = media
start_file = opening/intro.tds
title = The Winter Archive
native_ui_theme = ui/player-ui.json
```

`scenario_dir`、`asset_dir`、`start_file`、空でない `native_ui_theme` は `safeRelative` で検証されます。バックスラッシュを `/` に正規化し、空パス、POSIX／Windowsの絶対パス、ドライブ名付きパス、空のパス要素、`.`、`..` を拒否します。Windowsとの互換性のため、各パス要素では `<`、`>`、`:`、`"`、`|`、`?`、`*` と制御文字を使えず、末尾のドット／空白、`CON`、`PRN`、`AUX`、`NUL`、`COM1`〜`COM9`、`LPT1`〜`LPT9`（拡張子付きも含む）も拒否します。`start_file` は大文字小文字を区別せず `.tds` で終わる必要があります。設定ファイル自体は、設定値で指定するのではなく、ファイルの存在位置で選択されます。

`title` は省略可能です。省略時、`projectLayout` はプロジェクトディレクトリのベース名をタイトルに使います。`native_ui_theme` も省略可能で、既定値は空です。`settingTemplate(title)` が生成するのはシナリオ、アセット、開始ファイル、タイトルの設定です。

## 5. ディレクトリ構成とファイルの管理者

| パス | 用途 | 手動編集 |
|---|---|---|
| `setting/setting.txt` | プロジェクトルート、開始ファイル、タイトル、任意のNative UIテーマパス | する |
| `setting/player-ui.json`（使用時） | プレイヤーのキャンバス、会話欄、選択肢、レイヤー、音量、操作ボタン | する |
| `setting/game-screens.json`（使用時） | フロントエンド画面定義と画面遷移設定 | する |
| `setting/screens/*` | ゲーム画面設定が参照するHTML/CSS/テキスト文書 | する |
| `setting/asset-folders.txt` | アセットフォルダーの人向け慣例 | する |
| `setting/story-adaptation.md` | 任意のプロジェクト固有の物語方針 | する |
| `senario/**/*.tds` | シナリオソース、モジュール、シーン定義 | する |
| `asset/**/*` | 画像、音声、動画などの実行時アセット | する |
| `.novel/variables.json` | 静的グローバル変数の宣言・制約 | する |
| `.novel/assets.json` | 生成アセットカタログ | 生成物 |
| `.novel/variables.schema.json`、`.novel/assets.schema.json` | インデックスが参照するスキーマ | 生成・補助 |
| `.novel/build/*.nsp.json` | ゲームパッケージ | 生成物 |
| `.novel/build/*.build-state.json` | エディターが変更ファイルを判定するビルドスナップショット | 生成物 |

`/api/files` はエディター用のプロジェクトツリーを返しますが、サーバー実装ファイルと `.novel` 内部は一覧から除外します。`.novel` は専用のプロジェクト／ビルドAPIを通じて利用します。READMEにある `setting/` を設定の集約場所とする説明は慣例であり、APIは旧ルート形式にも対応します。

## 6. シナリオファイルとincludeの解決

### 6.1 シナリオファイル名

`tools/project.js` の `sceneFile(name)` は `\` を `/` に正規化し、大文字小文字を区別せず `.txt` を拒否し、拡張子がない場合は `.tds` を付加します。Nativeのpackage loaderも `.tds` 拡張子を大文字小文字を区別せず判定し、元のファイル名を保持します。ディレクトリ要素は空であってはならず、`.`、`..`、Windowsで無効な文字・制御文字、末尾のドット／空白、Windows予約デバイス名は使えません。最終ファイル名はASCII英字またはアンダースコアで始まり、ASCII英数字、`_`、`.`、`-` が許可されます。実装上、拡張子を含む最終要素は80文字までです。`chapter/next.tds` は有効ですが、`chapter//next.tds`、`con.tds`、`chapter/next.` は拒否されます。

名前の検証後にもファイルシステム検査が行われます。実体パスが実ルート内にある通常ファイルであり、シンボリックリンクでもハードリンクでもないことを確認します。字句上の検査だけでは十分ではありません。

### 6.2 includeと標準ライブラリ

includeにはパスと必須aliasがあります。

```tds
include common.tds as common
include "std/math.tds" as math
```

`scanTopLevelDeclarations` はトップレベルの `struct`、`fn`、`include` の形だけをトークン走査します。完全な構文解析の前にinclude先の構造体名を集めることで、includeで定義した構造体を型付き宣言や関数シグネチャに使えるようにします。includeパスは引用符付き、またはトークンを連結した形式にできますが、空白を含む無引用パスは拒否します。aliasは識別子である必要があります。

通常のincludeは、include元ファイルのサブディレクトリではなく、設定済みシナリオルートを基準に解決します。`std/` で始まるパスはリポジトリ同梱の `std/` 以下で解決します。標準ライブラリAPIは `listStandardLibrary()` と `readStandardLibraryFile(name)` です。後者が開けるのは `std/` のモジュールだけです。

`resolveProjectScript` はincludeグラフを再帰的に解決します。現在の再帰経路でincludeが再登場すると循環として失敗します。また、同じソースから同一モジュールパスを複数回直接includeすることも失敗します。includeされたモジュールはシーンを宣言できず、トップレベルには宣言以外のグローバル文を置けません。

インポートした関数はaliasで修飾されます。ローカル関数への未修飾呼び出しはインポート先のalias付きに変換し、組み込み関数名は維持します。既に修飾された関数名はインポートaliasの下に置きます。文字列補間中の関数呼び出しも修飾対象です。インポートしたアセット、キャラクター、構造体、宣言、関数は統合され、ソースファイルと名前の組が同じ項目は重複を避けます。

`tagLocations` により解決後のASTにもファイル位置情報が残るため、診断はモジュールのファイルを示せます。パッケージ内ではincludeが解決済みなので、各プログラムの `p.includes` は空配列になります。

### 6.3 gotoとファイル間シーン参照

`gotos(list)` は、命令本体、`otherwise`、else-if分岐、選択肢本体を再帰的に走査し、`goto` の対象を集めます。対象が現在のプログラム内のシーン名ならそのまま有効です。そうでなければ `sceneFile` で正規化し、シナリオルート内のファイルとして解決できる必要があります。

静的な遷移先は、同じファイル内のシーンにも別の `.tds` ファイルにもできます。パッケージ化では指定されたエントリを `program` にし、`files` にはシナリオルート内の全 `.tds` ファイルを格納します。ファイル間 `goto` の参照先も同じシナリオルートから解決します。参照されていないファイルも `files` に含まれ、宣言・型・assetなどのpack検証対象になります。

## 7. プロジェクト全体の宣言とインデックス

### 7.1 `projectGlobalVariables`

`tools/pack.js` の `projectGlobalVariables(scenesRoot, dataRoot)` は、シナリオルート以下のすべての `.tds` を再帰走査します。各ファイルのソースを解析し、includeを解決して、ローカル宣言、関数、キャラクターメタデータを記録します。

- プロジェクト全体でキャラクター名の所有ファイルは一つでなければなりません。同名キャラクターの重複宣言はエラーです。
- `main.tds` 内の変数宣言は暗黙のプロジェクトグローバルとして扱います。それ以外のファイルでは `global` を付けた宣言だけを昇格させます。
- 型推論が必要な宣言は、他の型・関数を集めたあとに処理します。推論の反復で進展がなくなった場合、最後に記録された推論エラーを返します。
- `.novel/variables.json` または別のシナリオファイルが同じプロジェクト変数名を所有している場合は重複です。後続ファイルには代入に `set` を使うよう促します。
- 定数は `readonlyNames` に登録されます。

暗黙のエントリ判定は、設定の `start_file` ではなく、相対パスをリテラル `main.tds` と大文字小文字を無視して比較します。開始ファイルを別名にしても、この特別扱いは自動では有効になりません。同様に扱うグローバルには明示的な `global` 宣言が必要です。

### 7.2 静的変数

`readStaticVariables(dataRoot)` は `.novel/variables.json` を読みます。ファイルがない場合は空の静的変数テーブルになります。`staticVariables` が省略されたJSONオブジェクトは `source` に保持されますが、宣言は生成されません。指定する場合は配列でなければなりません。各要素は `name`、`type`、`value`、任意の `constant`、任意の `min`、`max`、`possibleValues` を持ちます。

型は `int`、`float`、`str` です。`constant` の既定値は `false` です。変数名はASCII識別子です。整数は符号付き64ビット範囲で検査し、JavaScriptの安全整数範囲を超える値も扱えるよう文字列形式を使用できます。浮動小数点数は有限値でなければなりません。`min <= max` が必要で、初期値と `possibleValues` は制約を満たし、候補値リストは空でなく重複がない必要があります。`str` では `min`／`max` を使えず、文字列の候補値だけを指定できます。

例:

```json
{
  "$schema": "./variables.schema.json",
  "staticVariables": [
    { "name": "difficulty", "type": "int", "value": 2, "min": 1, "max": 3 },
    { "name": "ending", "type": "str", "value": "common", "possibleValues": ["common", "true_end"] },
    { "name": "build_id", "type": "int", "value": "9007199254740993", "constant": true }
  ]
}
```

返却値は `table`、`table.readonlyNames`、`table.constraints`、解析済みの `declarations`、元の `source` を持ちます。コンパイル時、静的変数は各プログラムに実際のグローバル宣言として注入されます。型検査だけのヒントではありません。実行時の `preserveGlobals` は初回に一度だけ初期化し、後続のファイル遷移では型の整合性を検証する想定です（実行時の詳述はランタイム仕様の範囲です）。

### 7.3 生成されるプロジェクトインデックス

`Edit/server.js` の `rebuildProjectIndexes({ variables, assets })` とラッパー `rebuildVariables()`、`rebuildAssets()` が `.novel/variables.json` と `.novel/assets.json` を構築します。

- `variables.json` は `{"$schema":"./variables.schema.json","staticVariables":[...],"variables":[...]}` の形です。`variables` はプロジェクト内宣言・参照情報を集約し、静的項目や可変性を示します。同じ変数が複数シナリオに出ることだけを理由に重複登録しないようにします。
- `assets.json` は `{"$schema":"./assets.schema.json","assets":[...]}` の形です。項目はアセット種別と名前で識別されます。キャラクターのポーズは `type: "char"`、キャラクター名／ポーズ名、パス、定義元 `definedIn` を持ちます。
- `createProjectAnalysisContext`、`globalVariableTable`、`globalCharacterTable`、`projectContext` は、シナリオツリー、include関数、静的宣言、ファイルごとの所有情報から解析用メタデータを作ります。コンパイル対象ファイル自身の宣言・キャラクターは他ファイル由来のコンテキストから外し、自己重複として扱わないようにします。

`ProjectChangeTracker` と `scanProjectFileSignatures` はプロジェクトファイルを監視し、`/api/project/changes` に差分情報を返します。これはビルドスナップショットとは別機能です。生成データの索引更新と、シナリオ内容の変更確認は用途が異なります。

## 8. アセット参照とパッケージへのコピー

コンパイル済みプログラムは `assets` とキャラクターポーズのパスを持ちます。`assetPaths(program)` は `program.assets` とキャラクターポーズのパスを返します。`validateProgram(program, assetsRoot, scenesRoot)` は各参照について先頭の任意の `asset/` を取り除き、設定済みアセットルートの下で解決できることを検査します。外部キャラクターはローカルポーズの存在検査対象から除外されます。

パッケージャーは、パッケージに含まれるすべてのプログラムから得た重複のない参照パスを、次の場所にコピーします。

```text
<packageを置くディレクトリ>/asset/<プロジェクトのアセットルート相対パス>
```

さらに、パッケージ対象UI設定が参照する画像もコピーします。

- Playerテーマの会話欄、ネームプレート、選択肢、操作ボタンの画像。
- ゲーム画面の背景、スロットスタイル、アイテム画像、UIツリーの画像ソース、CSS形式の背景URL。hover／focus／focus-visible styleと、control-skinの `track`、`fill`、`thumb`、`thumbHover`、`off`、`on`、`offHover`、`onHover` も対象です。
- ゲーム画面の `stylesheet`、`controlSettings`、テンプレート文書は設定ルートから読み込み、画面データへコンパイルします。これらの原文書をプロジェクトアセットとしてコピーする処理ではありません。

アセットJSON内のパスは慣例上アセットルート相対です。テーマ画像は、既にテーマのディレクトリが先頭にある場合を除き、テーマファイルのディレクトリを基準に解決します。操作ボタン画像はアセットルート相対として扱います。ゲーム画面画像は先頭の小文字 `asset/` 接頭辞だけを任意のaliasとして取り除き、アセットルート内で解決します。たとえば `Asset/icon.png` は `asset/Asset/icon.png` を指します。参照ファイルは通常ファイルであり、シンボリックリンクやハードリンクではなく、ルート内にある必要があります。アセットツリー全体ではなく参照されたファイルをコピーするため、未参照ファイルは自動的にはパッケージに含まれません。

画像参照の検証は存在・パス安全性を対象にし、packer自体は画像データをdecodeしません。そのため、通常ファイルとして存在する破損画像もpackageへコピーされ、実行時のBrowserまたはNative decoderで失敗することがあります。Editorの `POST /api/native-tools/images` はNative decoderを使う別の画像検査経路ですが、package作成時に自動実行される検証ではありません。

未参照ファイルもプロジェクトのアセット原本です。出力先に指定したファイルがアセットルート内の既存ファイルと一致する場合、参照中かどうかに関わらずパッケージ作成を拒否し、原本を保護します。

## 9. パッケージ形式と実行時ファイル

`pack(input, output, roots)` の戻り値が、そのままシリアライズされるJSONです。

```json
{
  "format": "novel-script-package",
  "version": 1,
  "source": "main.tds",
  "program": { "...": "コンパイル済みエントリプログラム" },
  "files": {
    "main.tds": { "...": "include解決済みのコンパイル済みプログラム" },
    "chapter/next.tds": { "...": "別ファイルのプログラム" },
    "unused.tds": { "...": "遷移元から参照されないファイルも含む" }
  },
  "native_ui": {}
}
```

デバッグ時だけ `debug: true` が含まれます。`source` と `files` のキーはシナリオルート相対で、区切り文字は `/` です。エントリの `program` は別途コンパイルされます。その際、エントリ自身のファイル内宣言は外部グローバルコンテキストから除かれるため、プロジェクト宣言と重複しません。`files` はシナリオルート内の全 `.tds` ファイルを格納します。ファイル間 `goto` の到達性による絞り込みはしません。includeは解決済みなので、各プログラムの `includes` は空配列になります。

`native_ui` には次の項目が入ることがあります。

- `native_ui_theme`: テーマが設定されている場合のパッケージ内テーマパス。
- `game_screens`: ゲーム画面文書が見つかり、コンパイルされた場合の `ui/game-screens.json`。
- `save_id`: 設定に存在する場合、コンパイル済み画面設定から引き継ぐ値。

Native Playerは、必須envelopeの`format`/`version`/`source`/`program`/`files`/`native_ui`と、CompiledProgramのversionおよび`assets`、`characters`、`globals`、`functions`、`scenes`、`variables` arrayを実行前に検証します。`debug`だけは省略可能で、指定時はbooleanでなければなりません。`source`は`files`のkeyとして存在し、各entryは同じCompiledProgram形状である必要があります。

現行プロジェクトでは、ゲーム画面のコンパイル用キャンバスは、Player UI設定がある場合は `player-ui.json` の `screen`、なければ `screenDocumentCompiler.DEFAULT_CANVAS` から決まります。コンパイル後の画面データに記録されます。旧 `titleScene` は後方互換のため形状を検証して読み込みますが、entry選択、Scene Flow、シーン順序、起動画面の表示には使いません。既定entryは `start_file` で、CLI inputまたは明示されたEditor Buildの `name` があればそちらを使います。開始画面はJSONまたはcustom templateに実行可能な `start` actionを持たせ、選択されたentry TDSから明示的に `start()` を呼びます。

パッケージJSONは整形出力され、最後に改行が付きます。隣接するアセットはJSONに埋め込まれません。パッケージと生成された `asset/` ディレクトリは一緒に配布してください。Nativeの通常実行ではセーブデータはOSのユーザーデータ領域に保存されます。`NOVEL_SAVE_ROOT`で保存先を指定でき、テスト用のdummy video driverではパッケージ隣の`saves/`が使われます。旧形式のパッケージ隣`saves/`は新しい保存先へコピー移行されます。

## 10. パス・リンク・出力の保護

### 10.1 プロジェクトルートと管理対象ファイル

`assertProjectDirectory(projectRoot, directory, key)` は字句上の包含と実パス上の包含を検査します。`ensureProjectDirectory` は再帰作成の前に、最も近い既存祖先の実パスが安全であることを確認します。作成後もディレクトリの実パスを検査します。そのため、設定された `scenario_dir`、`asset_dir`、`.novel` や入れ子出力ディレクトリが、シンボリックリンク／junctionを介してプロジェクト外へ抜けることを防ぎます。

`assertProjectSettingFile` は入れ子設定を優先して選び、`setting.txt` が通常ファイルであること、シンボリックリンクでないこと、リンク数が1以下であることを確認します。実パスもプロジェクト内でなければなりません。`ensureProjectFile` は初期化する管理ファイルにも同種の通常ファイル・非リンク検査を行い、`wx` で作成します。

### 10.2 読み込むファイルとinclude／asset

`inside(root, relative)` はルートと対象を実パスに解決します。`lstat` で対象を検査し、シンボリックリンク、通常ファイルでない対象、`nlink > 1` のファイルを拒否します。その後、実パスがルート内にあり通常ファイルであることを確認します。シナリオ、include、アセットなどの読込みに使われます。Editorの設定・素材pathも各要素を検査し、Windows予約device名、alternate data stream用のコロン、不正文字、末尾dot/spaceを拒否します。`sceneFile` もファイルシステム確認の前に同種のWindows不正path要素を拒否します。

Native playerはpackage内のUI画像、テーマ、画面設定でも絶対パスと親参照要素 `..` を拒否します。要素単位で判定するため、`foo..bar.png` のようにファイル名の途中に連続ドットがある相対パスは有効です。

### 10.3 出力の境界

プロジェクト情報付きのpackでは、シナリオルートとアセットルートがプロジェクト内にあることを検査します。パッケージの親ディレクトリがプロジェクト内であれば、プロジェクト用ディレクトリ検査を通して作成します。次に出力親の実パスを確定し、作成するアセット用サブディレクトリがその下に留まることを確認します。出力先に既存ファイルがある場合、通常ファイルであり、シンボリックリンクでもハードリンクでもないことを要求します。出力先が走査済みシナリオ、参照アセット、またはコンパイル時に読み込む `.novel/variables.json` と一致する場合は、入力を上書きしないよう拒否します。アセットは出力親の `asset/` 以下に書き、リンク経由でそこから抜ける構成は失敗します。最終パッケージの書込み前にも出力先を検査します。

エディターAPIにはさらに `safeScenePath`、`safeAssetPath`、`safeSettingPath`、`safeSettingDocumentPath`、`safeBuildPath`、`safeDataPath` があります。パス要素、実ルート、通常ファイル、ハードリンク、シンボリックリンク／junctionの逸脱を検査してから読込み・書込み・削除します。`GET /api/files` のExplorer一覧と `/api/project/changes` の署名スキャンも各ルートを検証し、root junctionやハードリンクの混入を拒否します。サーバーが配信するエディターファイルは許可リストに限定され、アセット配信も対応メディア形式に限定されます。`/api/native-package` は要求されたパッケージ名を制限し、保護されたビルドルートを使います。

### 10.4 保護の適用範囲

これらはパス解決・ファイル操作時点の検査です。別プロセスが同時にツリーを変更する競合に対するトランザクションロックではありません。エディターのプロジェクトビルドは別途、pack前後のシナリオスナップショットを比較して、ビルド中のシナリオ変更を検出します（§12）。アセットコピーとJSON書込みを含む全体を、一つの原子的なリネーム操作で確定する処理ではありません。

## 11. プロセスの起動方法とHTTPルート

### 11.1 CLIパッケージャー

直接のプロセス起動形式は次のとおりです。

```text
node tools/pack.js [input.tds] [output.nsp.json] [--project <directory>] [--debug]
```

入力を省略すると `entryFile(layout)` が選ばれます。出力を省略すると `.novel/build/<input-base>.nsp.json` が選ばれます。レイアウトは `--project`、または位置引数の入力から見つけたプロジェクト、またはいずれもない場合の既定プロジェクトで決まります。`--debug` は位置引数から除かれ、パッケージのdebugフィールドを有効にします。成功時は `Packed <input> -> <output>` を表示します。失敗時は `Package creation failed: <message>` を表示し、終了コードを非ゼロにします。

`npm run pack -- [args]` は、パッケージャー実行前にTypeScriptビルド（`npm run build`）を行います。ライブラリAPI `pack(input, output, roots)` の `roots` には `projectRoot`、`scenesRoot`、`assetsRoot`、`dataRoot`、`debug` を渡せます。

### 11.2 エディターサーバー

`node Edit/server.js [--project <directory>]` は起動時に選択したレイアウトを初期化します。`npm run editor` はTypeScriptをビルドしてサーバーを起動します。`PORT` が初期ポートを指定し、既定値は4173です。利用可能なポートを最大10回探します。`POST /api/project/open` は `bindLayout` を介して、プロセス内で選択プロジェクトを切り替えられます。

`handleApi` の主要なプロジェクト関連API:

| ルート | 動作 |
|---|---|
| `GET /api/project` | 選択中のプロジェクト情報と設定を返す |
| `PUT /api/project/settings` | 対応するプロジェクト設定を更新し、必要に応じてレイアウトを再適用する |
| `POST /api/project/open` | プロジェクトを開く／作成する。確認が必要な場合は `needsCreate` を伴う409を返す場合がある |
| `GET /api/files`、`GET /api/scenes` | エディターに公開するプロジェクトファイル／シナリオを列挙する |
| `GET/PUT /api/setting-file` | 設定文書を読み書きする。`setting.txt` とJSON設定を検証し、リビジョン照合に対応する |
| `GET/PUT /api/player-ui` | Playerテーマを読み書きする。未作成時は既定値を返す |
| `GET/PUT /api/game-screens` | ゲーム画面設定と参照文書を読み書きする |
| `GET /api/variables`、`GET /api/assets` | 生成インデックスを返す。欠落時は空／既定データを返せるが、不正またはプロジェクト外のメタデータはエラー |
| `GET /api/asset-info`、`GET /api/ui-assets`、`GET /api/catalog` | アセット情報とエディター用カタログを返す |
| `GET/PUT /api/scene`、`DELETE /api/file` | パス検査付きのシナリオCRUD・削除 |
| `POST /api/validate`、`POST /api/compile`、`POST /api/editor-symbols` | プロジェクト情報を使った言語検査・コンパイルを行う |
| `POST /api/project-build` | プロジェクト全体を検証してパッケージ化し、ビルド状態スナップショットを書く |
| `POST /api/project-build-status` | 現在のシナリオスナップショットと保存済み状態を比較する |
| `GET /api/native-package?name=...` | Native再生用にパッケージをパス検査付きで取得する |

サーバーはエディター実装ファイル（`EDIT_ROOT`）と選択中のプロジェクトルートを分離します。`POST /api/project/open` はエディター本体またはリポジトリのパスを、シンボリックリンク／junction経由で指定した場合も拒否します。アセットHTTP要求は `/asset/...`、シナリオや設定データはAPI経由です。これにより、リポジトリと無関係な場所のプロジェクトを扱えます。

## 12. エディターの全体ビルドと変更状態

`buildWholeProject(name)` は `configuredEntry(name)` でエントリを選びます。`start_file` を使い、明示的に要求された場合だけ要求ファイルを使います。全シナリオを列挙して、まず構文診断を行います。構文診断がなければ、全ファイルにプロジェクト対応の検証を行います。さらにentryから到達するgoto経路を検査し、`goto` または `start()` なしにscene末尾へ届く経路をblocking warningにします。診断はコード、重大度、ファイル、行・列範囲、メッセージをキーに重複排除されます。エラーまたはblocking warningがあれば `{ok:false, build:true, fileCount, diagnostics, error}` を返します。

ビルド開始時に同じentryの既存 `.build-state.json` を削除し、失敗後に前回の状態が現在の作品に有効だと判定されないようにします。検証に成功すると、`readScenarioBuildSnapshot(entry)` でビルド前の状態を作ります。スキーマは `{version:1, entry, files:{relativeTdsPath:sha256Hex}}` です。`.novel/build` を確保し、`pack` で `<entry-base>.nsp.json` を作ります。pack後にスナップショットを再計算し、シナリオ内容が変化していたら、現行状態を示すビルド状態ファイルを書かずにビルド失敗とします。問題がなければ `<entry-base>.build-state.json` を書き、パッケージパス `.novel/build/<name>`、ファイル数、命令数を返します。前回成功したpackage本体は失敗時も保持しますが、ビルド状態を削除するためEditorのPlayは再buildを要求します。

`projectBuildStatus(name)` は保存済みスナップショットと現在のスナップショットを比較します。結果の `reason` は `"not-built"`、`"build-state-invalid"`、`"scenario-changed"`、`"up-to-date"` などです。`changedFiles` には変更、追加、削除されたシナリオパスが含まれます。この状態判定はシナリオファイルのハッシュとエントリ識別に基づき、パッケージ本体、アセット、UI設定、静的変数ファイルのチェックサムではありません。したがって、これらの入力変更は、この差分一覧だけでは表現されません。

## 13. エラーと診断の発生段階

エラーは複数の層から発生します。

1. **レイアウト／設定**: 設定文法の誤り、必須キー不足、未知キー、安全でない相対パス、`.tds` 以外の開始ファイル、不在・不正な設定ファイル。
2. **プロジェクト探索／ファイルシステム**: 設定済みシナリオルートを含むプロジェクトが見つからない、ファイル／ディレクトリ不在（`ENOENT`）、ファイルの代わりにディレクトリを指定（`EISDIR`）、危険なリンクや実パス逸脱。
3. **プロジェクト宣言の収集**: キャラクター／変数の所有重複、推論型を決定できない、静的変数メタデータの不正。
4. **解析／include解決**: ソース構文エラー、不正なシーン名、include不在、alias不足、循環／重複include、モジュール内のシーン宣言や実行文を伴うグローバル、不正な標準ライブラリパス。
5. **コンパイル／検証**: 言語・型・制御フロー診断、参照アセット不在、ファイル間goto先不在、制約違反。
6. **UIパッケージ化**: JSONやスキーマ不正、未対応テーマバージョン（現状version 1のみ）、参照された画面文書／画像不在、不正な画面文書パス・拡張子、開始画面に `start` actionがない。
7. **出力**: 出力先が親ディレクトリ外へ抜ける、既存のシナリオ／設定／データ／アセット原本と同じパス、リンクされた危険な出力ファイル／ディレクトリ、ファイルシステムの書込み・コピーエラー。

CLIは `Packed <input> -> <output>` を成功表示として使い、失敗時は `Package creation failed: ...` と単一メッセージを表示して非ゼロ終了コードにします。debug packageの成功行には `(debug)` が付きます。NSP JSON、画面manifest、参照assetは一時stageに生成してから出力先へ移します。出力処理で例外が起きると、既存の対象ファイルをrollbackし、stageを削除します。画面manifestは画面画像を解決した後に作るため、画像不在時に不完全なmanifestを残しません。前回成功したpackageは失敗時も保持されます。Editorのbuild-stateはビルド開始時に削除され、成功後にだけ再生成されます。エディターはビルドエラーを `project-error` 診断に変換し、既存の言語診断を保持しながらエントリファイル／行情報を付加します。APIハンドラーは通常、不正入力・パスに400、アクセス禁止に403、ファイル不在に404、リビジョン競合やプロジェクト作成確認に409を返します。正確なステータスは各ルートの分岐が基準です。

## 14. 実装参照一覧

| 項目 | 主なシンボル |
|---|---|
| 設定解析・レイアウト・初期化 | `tools/project-layout.js` の `parseSettings`、`projectLayout`、`projectOption`、`layoutForInput`、`entryFile`、`seedEmptyProject` |
| 安全な相対シーン名とファイル | `tools/project.js` の `sceneFile`、`inside` |
| includeの検出と解決 | `tools/project.js` の `scanTopLevelDeclarations`、`collectIncludedStructs`、`resolveProjectScript`、`qualifyImportedFunctions` |
| プログラムのアセットとgoto | `tools/project.js` の `assetPaths`、`gotos`、`validateProgram`、`compileProject` |
| 静的変数 | `tools/static-variables.js` の `readStaticVariables`、`declaration` |
| プロジェクトグローバルとパッケージ形式 | `tools/pack.js` の `projectGlobalVariables`、`pack` |
| エディターのパス・索引・ビルドAPI | `Edit/server.js` の `safe*Path`、`rebuildProjectIndexes`、`buildWholeProject`、`projectBuildStatus`、`handleApi` |

## 15. 関連テスト（本書作成時には未実行）

以下は実装を確認する際に参照できる既存テストです。本ドキュメント作成作業では実行していません。

- `test/project-layout.test.js`:
  - `project includes expose struct declarations to the including scene`
  - `project scene paths reject empty directory components`
  - `setting.txt fixes layout and entry file at the project root`
  - `project paths reject Windows absolutes and symlinked directories outside the project`
  - `project layout rejects a setting.txt hard link to an external file`
  - `project seeding rejects an externally linked main scene without changing it`
  - `CLI packaging rejects an external .novel junction`
  - `CLI packaging rejects linked scene inputs and linked asset output folders`
  - `arbitrary title: editor CRUD, assets, project build and CLI use the same project`（長い統合テスト。変更・追加・削除されたビルドスナップショット、静的変数制約と診断、アセットパッケージ、既定テーマ、プロジェクト内ビルド出力を確認）
- `test/asset-packaging.test.cjs`:
  - `pack rejects linked files referenced by screen HTML and CSS before creating output`（HTML `img` とCSS `url()` のhardlinkを拒否。Windowsでfile symlink権限がない場合はそのsubtestをskip）
  - `pack rejects screen images reached through an external asset-root junction`（HTML/CSSの両方でasset root外へ出るjunction参照を拒否）
  - `pack preserves uppercase Asset directory names in screen CSS URLs for Browser and Native`（pack済みBrowser documentで画像をdecodeし、同じpackageをNativeで起動）
  - `pack copies a corrupt theme image without decoding it; Browser and Native reject the payload at render time`（packerの非decode境界と両runtimeのdecode失敗を確認）
- `test/project-settings-security.test.js`: `project settings API rejects a setting.txt hard link to an external file`。稼働中のエディターサーバーが外部ファイルへの `setting.txt` ハードリンクを拒否し、外部データを変更しないことを確認します。
- `test/project-changes.test.js`:
  - `project polling reports only changed paths and reuses tokens for unchanged snapshots`
  - `project polling resets stale tokens and does not advance after a scan error`
  `test/project-changes.browser.cjs` はブラウザー側の更新動作を扱います。
- `test/desktop-package-smoke.cjs` はデスクトップアプリ配布のスモークテストです。プロジェクトの `.nsp.json` パッケージ化とは別の対象です。
- 条件が合う環境では `test/runtime.test.js`／`test/native-smoke.cjs` がパッケージのランタイム利用を確認します。JavaScript側のpack成功だけではNative再生まで確認できたことにはなりません。

統合テストはAPIルートや応答形状の期待値も示します。互換性分岐によって動作が異なる場合は、テストのアサーションと現行ソースの両方を確認してください。

`start()` はentry TDSで記述し、実行がその命令に達すると `game-screens.json` の初期画面を表示します。Start操作後は次の命令から実行を再開します。パッケージには画面設定を保存しますが、別のstory sceneをentryとして選択しません。詳しくは[Startup flow](startup-flow.md)を参照してください。
