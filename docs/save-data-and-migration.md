# セーブデータ・ユーザー設定・移行仕様

この文書はPlayerが永続化するゲーム進行状態、slot metadata/thumbnail、ユーザー設定、Browser/Native保存領域を説明する。画面上のslot操作は [`ui-runtime-spec.md`](ui-runtime-spec.md)、実行状態の生成と復元は [`runtime-semantics.md`](runtime-semantics.md)、NSPとpackは [`compiler-pipeline.md`](compiler-pipeline.md) を参照。

## 1. 保存されるデータの分類

Playerの永続化データはひとつのファイルではなく、用途別に分かれる。

| 種別 | Browser | Native |
|---|---|---|
| 通常slot snapshot | IndexedDB `snapshots` object store（backend fallback時はlocalStorage） | `slot-<1..120>.json` |
| slot metadata | IndexedDB `metadata` store | snapshot内のfieldから導出 |
| slot thumbnail | IndexedDB `thumbnails` store (`Blob`) | `thumb-slot-<1..120>.png` |
| quick save | `preferences` storeの`quick-save` | `quick-slot.json` |
| UI preference | `preferences` storeの`ui-settings`等 | `ui-settings.json` |
| 一時resume pointer | `sessionStorage`。legacy fallbackとして一部localStorage | 実行中プロセスがslot内容を読む |

BrowserとNativeは保存先といくつかのdetail表現が異なります。共通に読める契約はsnapshot versionと必須fieldを中心に扱い、thumbnailとUI preferenceは相互移行可能な共通ファイルだと見なさないでください。

## 2. Browser storage namespace

`Edit/save-store.js` は `NovelSaveStore.open({ namespace, legacyPrefix, indexedDb, storage })` を公開します。database名は固定で `novel-script-user-data`、version 1です。object storeは `snapshots`, `metadata`, `thumbnails`, `preferences`。

slot keyは `${namespace}:slot:${index}`、preference keyは `${namespace}:pref:${name}` です。`namespace` は空でないstring、最大512文字である必要があります。`Edit/player.js` は概ね `saveId || projectRoot || origin` と `game` / `test` を組み合わせ、作品やdebug sessionのデータを分けます。

IndexedDBが存在しopenに成功すれば4 storesを使用します。openできずlocalStorageが使用可能な場合はfallback backendとなり、snapshotとpreference JSONをnamespaced keyで格納します。fallbackにはpersistent metadata/thumbnail storeがありません。保存直後のthumbnailは現在のpageのobject URLで表示されますが、再読み込み後には復元できません。Save/Load screenはfallback backendとpreviewの制限を明示します。thumbnailがなくてもsnapshotはloadできます。両storage backendが使えない場合はopenが失敗します。

## 3. Snapshot v1

Browser slotとNative slotは次の主要fieldを使います。

| Field | 意味 | 読み込みでの扱い |
|---|---|---|
| `version` | snapshot format version。現行値`1` | 不一致は非互換 |
| `saveId` | 任意の作品識別子 | current configと不一致なら非互換。空文字/省略は旧形式互換として許可し、string以外は破損扱い |
| `file` | scenario file path | 必須string、空不可 |
| `scene` | scene name | Required identifier matching `[A-Za-z_][A-Za-z0-9_]*` |
| `line` | 再開位置 | 必須integer、1以上。Browserではsafe integer |
| `variables` | global変数map | 必須object、array/nullは不可 |
| `locals` | local frame stack | Browser snapshotでは`runtime.frames.slice(1)` |
| `readonlyLocals` | frameごとのreadonly名 | 現在のlocal frameに対応するarray群 |
| `loopScopes` | Native loop scope状態 | Native snapshotで保存される |
| `sceneState` / `presentation` | 描画・演出状態。背景、character/image、camera、layers、audio状態、dialogue opacity等を含む | Browser / Native実装のfield名が異なる。保存済みpresentation値を復元し、旧snapshotで省略された値だけを現在のproject defaultsで補う |
| `text`, `speaker` | 現在表示中の会話 | slot summaryと画面表示にも使う |
| `savedAt` | epoch milliseconds | Continue候補の新旧比較に使う |
| `locked` | slot保護 | Browser/Native slot operationが上書き等を防ぐ |

Browserはsnapshot全体を `JSON.stringify` し、BigIntを `{ "__novelInteger": "<decimal>" }` の形に置き換えます。読み込み時 `decodeSave()` が整数値に復元します。Nativeはnlohmann/jsonで同等のruntime数値表現をJSONへ書きます。保存形式は単なる表示metadataでなく、実行中の状態復元に使うため、unknown fieldを消したりline semanticsを変えたりする編集は互換性変更です。

Browserの `isLoadableSave()` は version、file、saveId、scene、line、variablesに加え、存在する場合は`locals`のframe objectと`readonlyLocals`のstring配列、および両配列のframe数が一致することを検査します。Native `readSlot()`、quick load、CLIの`--load-slot`はNative restore用の`loopScopes`配列と各indexがlocal frame範囲内であることも検査します。どの入口でも同じframe metadata validatorを通し、破損payloadと非互換version/saveIdを区別して、不正なframe metadataをrestore処理へ渡しません。

`line` はBrowserの `Number.isSafeInteger()` と同じ範囲の1以上の安全な整数です。JSONの整数表記だけでなく、`11.0` や `1.1e1` のようにJSON parserで安全な整数へ評価される有限値も有効です。NativeはBrowserと同じloadabilityを保つため、安全な整数範囲と有限性、整数性を確認します。

## 4. Snapshot作成と復元の順序

Browser `saveGameToSlot(index)` は `currentExecution` のfile/scene/lineが有効で、slotがlockされていないときにsnapshotを作成します。`encodeSave()`後、encoded JSONが3,500,000文字を超えると拒否します。現在frame以外のlocal stack、readonly local名、`runtime.sceneState`、speaker/text、savedAtを含め、thumbnail取得後に `saveStore.writeSlot()` を呼びます。UI通知は書込み完了後に行います。user functionまたは`for` / `forEach` / `while`の実行中は、resume位置が不正になるのを防ぐため保存を拒否し、理由を表示します。

Quick saveはslotではなく `preferences` の `quick-save` に格納され、通常slotのthumbnail/lock/metadata storeを通りません。Browser quick saveにも3,500,000文字上限があります。user functionまたはloopの実行中はQuick Saveも拒否し、理由をgame stage上のtoastに表示します。quick loadはencoded snapshotの形式を検証し、`sessionStorage` にresume tokenを置いてPlayer pageをreloadします。

通常slot loadも対象slot indexを `sessionStorage` に置き、reload後の初期化時にslot snapshotをdecodeして実行状態を戻します。resume pointerは一度読み込んだ後に削除します。これはPage lifecycleを跨いで同じruntime objectを使い続ける方式ではありません。

Nativeは `saveSlot()` / `saveQuickSlot()` でversion 1 JSONを書き、restore側でfile/scene/line/variablesに加えlocal/read-only/loop/presentation状態を読みます。ただしBrowserとNativeのどちらも実行中loopの反復位置/条件継続をsnapshotに含めないため、user functionまたは`for` / `forEach` / `while`の実行中はslot/quick saveを拒否します。BrowserとNativeのどちらも、保存済みのchannel volumeとdialogue opacityを再開時に優先し、旧snapshotで値が欠けている場合だけ現在のproject defaultsで補います。Nativeではslot snapshotとthumbnailは別ファイルです。thumbnail作成またはatomic replacementの失敗は、正常なsnapshot保存自体を無効化しない経路があります。

## 5. Browser transactionとfallbackの差

IndexedDB slot writeは`snapshots`, `metadata`, `thumbnails`の一つのreadwrite transactionです。thumbnailがBlobでない場合、古いthumbnail recordを削除します。削除も3 storesを一transactionで消します。

`transferSlot(source,destination,{move})` はsourceとdestinationが異なること、sourceにsnapshotがありdestinationが空であることを要求します。IndexedDBでは3 storesの一transaction内でsnapshot・metadata・thumbnailを移し、destinationを上書きしません。localStorage fallbackはsnapshotだけをcopy/moveし、metadataとthumbnailを保持しません。

slot indexは0-based APIで0〜119です。UI表示はslot 1〜120へ変換します。save screenの`slotLayout.count * slotPages`は最大120にvalidatorで制限されます。quick-saveはこのslot index空間と別の固定key/fileです。

## 6. Legacy移行

Browser `open()` は `legacyPrefix` が与えられ、storageが使える場合、`${legacyPrefix}:slot:<index>`を走査します。target namespaceのslotが既に存在すれば触れません。旧値がJSONとして読め、現行のloadable条件（v1、非空のstring `file`、識別子形式のstring `scene`、1以上のsafe integer `line`、配列でないobject `variables`、省略可能なstring `saveId`、および省略可能な`locals`/`readonlyLocals`のframe形状と対応数）を満たす場合だけ新storeへimportします。条件を満たさない、または壊れたlegacy bytesは削除せず、手動回復用に元のkeyへ残します。旧`ui-settings` preferenceも新namespaceにrecordが存在しない場合だけJSON parseして移行します。`false`、`0`、空文字などfalseyな値も既存recordとして保持し、legacy値で上書きしません。

Native `migrateLegacySaves(packagePath,saveDirectory)` はpackage横の`saves/`から新user data rootへ、`slot-1.json`〜`slot-120.json`、対応thumbnail、`ui-settings.json`を `skip_existing` 付きでcopyします。sourceは削除しません。`NOVEL_SAVE_ROOT`がlegacy directoryを指す場合はself-copyを避けます。

これらは特定の既知legacy layoutの移行です。Browser/Native間移行、全将来version間migration、任意の旧slot形式復旧を保証するものではありません。

## 7. Native保存先とatomic write

Native `saveDirectoryFor(packagePath,package)` の順序:

1. `NOVEL_SAVE_ROOT`が設定されていれば絶対pathを要求し、そのpathを使う。Windowsではwide environment valueとして読み取るため、日本語を含むpathも指定できる。
2. SDL video driverが`dummy`ならテスト用にpackage横`/saves`を使う。
3. `native_ui.save_id`があればsanitizeし、なければpackage parent absolute pathからFNV-1a hashを生成した `project-<hex>` をidentifierにする。
4. `SDL_GetPrefPath("NovelScript", id)`を呼ぶ。Windowsでは現環境の実測で `%APPDATA%\NovelScript\<id>\` に保存されます。macOS/Linuxの実pathはSDL/OS環境に依存します。

`saveSlot()`、UI settings、slot copy等は一時`.tmp`ファイルを書いてflush後 `replaceSaveFile()` で置換します。WindowsではReplaceFile/MoveFileEx系、その他はfilesystem renameを使います。更新中にprocessが落ちてもdestinationを直接途中書きする確率を抑えます。移行先directoryのOS上の正確なpathはSDL/OS環境に依存します。

Native slot filenameは1-based (`slot-1.json`)で、内部indexは0-basedです。quick saveは`quick-slot.json`で、通常slot一覧の上限に含みません。

## 8. Thumbnail、slot metadata、Continue

Browser thumbnailはsnapshotと別のBlobです。metadata storeにはscene/speaker/text/savedAtの軽い表示値がありますが、復元の正本はencoded snapshotです。load時にthumbnailが欠けたり読めなくてもsave自体がloadableならロードできる設計です。

Native thumbnailは`thumb-slot-N.png`です。metadataはslot JSONのscene/speaker/text/savedAt/locked等から作ります。C++のslot cacheはfile last-write-timeが変わった場合に再読込します。外部ツールから同じmtimeで内容だけ置き換えたときcacheが直ちに気付くかは保証されません。

`latestSaveSlotIndex()` はload roleのcapacityを見て、loadable slotの最大`savedAt`を選びます。timestampが欠ける場合は0扱いになり、同値なら最初のindexが残る実装経路があります。存在しないresume pointや別作品saveをContinueに出さないため、loadable判定とsaveId照合が必要です。

## 9. ユーザー設定

Browser preferenceもnamespace付きIndexedDB keyです。`ui-settings`等のJSON値はゲーム進捗snapshotとは別に保存され、`loadUiSettings()`が既定値とvalidationを通して適用します。`ui.shortcut.*`, audio volume/mute, dialog opacity, text/auto speed等を含み得ます。

Native `ui-settings.json` はsave directoryに格納されます。ロード時に各key/valueを許容設定ruleに照合し、無効値は採用しません。NativeとBrowserで同じpreference JSONを自動同期する経路はありません。

## 10. 失敗・保護・整合性

- 空slot、空文字を含む破損JSON、unsupported version、別saveIdは別stateとして表示し、ロード可能判定から除外する。保存recordの存在判定では空文字payloadを空slotとして扱わず、破損データとして保持する。
- locked slotへの上書き/移動/削除を拒否する。削除UIは誤操作防止の再確認段階を持つ。
- Browser write/IndexedDB transaction/localStorage quota失敗はユーザー向けsave errorになる。quota量は固定値として保証されない。
- Browser `writeSlot()` は保存snapshot stringを最大8,000,000文字まで受けるstore-level制約を持つが、Playerはそれより低い3,500,000文字上限を先に課す。
- Nativeはsnapshot、thumbnail、設定で別ファイルなので全ファイル同時のtransactionではない。thumbnail失敗時はsnapshotが残る場合がある。
- Browser slot copy/moveはatomic transactionだが、fallback backendではsnapshotだけの複数localStorage操作となり、metadata/thumbnail transaction semanticsはない。

## 11. 実装・回帰テスト

| 範囲 | 主な実装 | 主なテスト |
|---|---|---|
| Browser store backend / keys | `Edit/save-store.js` | `test/save-store.test.js` |
| Browser save/load UI、BigInt encode | `Edit/player.js` | `test/save-load.browser.cjs`, `test/save-slot-card.browser.cjs` |
| Browser runtime restore | `Edit/runtime.js`, `Edit/player.js` | `test/runtime.test.js`, save/load Browser tests |
| Native directory/migration | `native/player.cpp` | `test/native-save-load.cjs` |
| Native screen slot actions | `native/player.cpp` | `test/game-screens-native.cjs` |
| screen role/capacity validation | `Edit/game-screens.js` | `test/game-screens.test.js`, `test/game-screen-document.test.js` |

### Fixture境界と実動作確認

- `test/save-load.browser.cjs` は一時projectを作り、Playwrightのisolated browser context内のIndexedDB/localStorageを使う。`test/save-slot-card.browser.cjs` も設定・assetをTitleから一時projectへcopyして動作し、実Title projectのsave namespaceは使わない。同testはIndexedDB openを拒否するfresh contextも作り、localStorage fallbackでsnapshotを保存・再読込して再開できること、thumbnailは再読込後に復元されずSave/Load screenに説明が表示されることを検査する。
- `test/native-save-load.cjs` はspace/Japanese characterを含む一時project/package path、package横のfixture `saves/`、space/Japanese characterを含む一時 `NOVEL_SAVE_ROOT` を使う。Native Playerをproject外のworking directoryから起動し、wrapper経由のabsolute package path、missing-package errorのUTF-8 path表示、legacy `slot-1.json` と `thumb-slot-1.png` の移行、既存user thumbnailの保護を検査する。Windowsではunique `saveId` と実SDL video driverで `SDL_GetPrefPath` のsave/thumbnail作成も検査し、作成したprofile directoryを削除する。Title save dataには書き込まない。
- `test/game-screens-native.cjs` はNativeの実Title packageでも画面描画とcontrol操作を検査するが、各起動時に一時 `NOVEL_SAVE_ROOT` を設定する。quick saveは書込みprocessを終了した後、別processからquick-loadし、`quick-slot.json`が起動をまたいで読めることも確認する。実Title save directoryへ書き込まない。Title package参照が必要なのは、実データのscreen treeとassetsを検査するため。
- Browser `save-load.browser.cjs`、`save-slot-card.browser.cjs`、Native `native-save-load.cjs` と実Title Native screen test `game-screens-native.cjs` を実行し、すべて成功した。Windowsでは一時packageと一意の`saveId`でNative playerの`--screen-save-smoke`を`NOVEL_SAVE_ROOT`なし、dummy driverなしで実行し、`%APPDATA%\NovelScript\<saveId>\` にslot snapshotとthumbnailが作成されることを確認した。検証後、一意の保存directoryとtemporary projectを削除した。実Title Native testの前後で `Title/.novel/build/saves/slot-1.json`、`thumb-slot-1.png`、`ui-settings.json` のSHA-256が一致した。
- Browser thumbnail testは実際にslotへ保存したBlobがPNGで、描画画面とdialogue textを合成した320×180 previewとなることをpixel差分で検査する。Native testはSDL描画時のframeをthumbnailへ保存し、slot templateがそのimageをdecodeして表示することを検査する。

これらの結果は記載したfixture/実行環境に対するもの。NativeのmacOS/Linux default pathとBrowserでlocalStorage quotaに達した場合のsave outcomeは未検証。
