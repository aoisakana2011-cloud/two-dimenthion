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

IndexedDBが存在しopenに成功すれば4 storesを使用します。openできずlocalStorageが使用可能な場合はfallback backendとなり、snapshotとpreference JSONをnamespaced keyで格納します。fallbackにはmetadata/thumbnail用の別storeがないため、slot preview等の可用性は同じではありません。両storage backendが使えない場合はopenが失敗します。

## 3. Snapshot v1

Browser slotとNative slotは次の主要fieldを使います。

| Field | 意味 | 読み込みでの扱い |
|---|---|---|
| `version` | snapshot format version。現行値`1` | 不一致は非互換 |
| `saveId` | 任意の作品識別子 | current configと不一致なら非互換。空/省略は互換扱いする経路がある |
| `file` | scenario file path | 必須string、空不可 |
| `scene` | scene name | 必須string、空不可 |
| `line` | 再開位置 | 必須integer、1以上。Browserではsafe integer |
| `variables` | global変数map | 必須object、array/nullは不可 |
| `locals` | local frame stack | Browser snapshotでは`runtime.frames.slice(1)` |
| `readonlyLocals` | frameごとのreadonly名 | 現在のlocal frameに対応するarray群 |
| `loopScopes` | Native loop scope状態 | Native snapshotで保存される |
| `sceneState` / `presentation` | 描画・演出状態 | Browser / Native実装のfield名が異なる |
| `text`, `speaker` | 現在表示中の会話 | slot summaryと画面表示にも使う |
| `savedAt` | epoch milliseconds | Continue候補の新旧比較に使う |
| `locked` | slot保護 | Browser/Native slot operationが上書き等を防ぐ |

Browserはsnapshot全体を `JSON.stringify` し、BigIntを `{ "__novelInteger": "<decimal>" }` の形に置き換えます。読み込み時 `decodeSave()` が整数値に復元します。Nativeはnlohmann/jsonで同等のruntime数値表現をJSONへ書きます。保存形式は単なる表示metadataでなく、実行中の状態復元に使うため、unknown fieldを消したりline semanticsを変えたりする編集は互換性変更です。

Browserの `isLoadableSave()` は version、file、saveId、scene、line、variablesを確認します。破損payloadと非互換version/saveIdはslot表示上で区別されます。Native `readSlot()` も同様に`ready`/`corrupt`/`incompatible`/`empty` stateを構築し、file/scene/line/variablesを検査します。

## 4. Snapshot作成と復元の順序

Browser `saveGameToSlot(index)` は `currentExecution` のfile/scene/lineが有効で、slotがlockされていないときにsnapshotを作成します。`encodeSave()`後、encoded JSONが3,500,000文字を超えると拒否します。現在frame以外のlocal stack、readonly local名、`runtime.sceneState`、speaker/text、savedAtを含め、thumbnail取得後に `saveStore.writeSlot()` を呼びます。UI通知は書込み完了後に行います。

Quick saveはslotではなく `preferences` の `quick-save` に格納され、通常slotのthumbnail/lock/metadata storeを通りません。Browser quick saveにも3,500,000文字上限があります。quick loadはencoded snapshotの形式を検証し、`sessionStorage` にresume tokenを置いてPlayer pageをreloadします。

通常slot loadも対象slot indexを `sessionStorage` に置き、reload後の初期化時にslot snapshotをdecodeして実行状態を戻します。resume pointerは一度読み込んだ後に削除します。これはPage lifecycleを跨いで同じruntime objectを使い続ける方式ではありません。

Nativeは `saveSlot()` / `saveQuickSlot()` でversion 1 JSONを書き、restore側でfile/scene/line/variablesに加えlocal/read-only/loop/presentation状態を読みます。Nativeではslot snapshotとthumbnailは別ファイルです。thumbnail作成またはatomic replacementの失敗は、正常なsnapshot保存自体を無効化しない経路があります。

## 5. Browser transactionとfallbackの差

IndexedDB slot writeは`snapshots`, `metadata`, `thumbnails`の一つのreadwrite transactionです。thumbnailがBlobでない場合、古いthumbnail recordを削除します。削除も3 storesを一transactionで消します。

`transferSlot(source,destination,{move})` はsourceとdestinationが異なること、sourceにsnapshotがありdestinationが空であることを要求します。IndexedDBでは3 storesの一transaction内でsnapshot・metadata・thumbnailを移し、destinationを上書きしません。localStorage fallbackはsnapshotだけをcopy/moveし、metadataとthumbnailを保持しません。

slot indexは0-based APIで0〜119です。UI表示はslot 1〜120へ変換します。save screenの`slotLayout.count * slotPages`は最大120にvalidatorで制限されます。quick-saveはこのslot index空間と別の固定key/fileです。

## 6. Legacy移行

Browser `open()` は `legacyPrefix` が与えられ、storageが使える場合、`${legacyPrefix}:slot:<index>`を走査します。target namespaceのslotが既に存在すれば触れません。旧値がJSONとして読め、`version === 1`, `file`, `scene`, integer `line`, object `variables`を満たす場合だけ新storeへimportします。壊れたlegacy bytesは削除せず、手動回復用に元のkeyへ残します。旧`ui-settings` preferenceも新namespaceに値が無い場合にのみJSON parseして移行します。

Native `migrateLegacySaves(packagePath,saveDirectory)` はpackage横の`saves/`から新user data rootへ、`slot-1.json`〜`slot-120.json`、対応thumbnail、`ui-settings.json`を `skip_existing` 付きでcopyします。sourceは削除しません。`NOVEL_SAVE_ROOT`がlegacy directoryを指す場合はself-copyを避けます。

これらは特定の既知legacy layoutの移行です。Browser/Native間移行、全将来version間migration、任意の旧slot形式復旧を保証するものではありません。

## 7. Native保存先とatomic write

Native `saveDirectoryFor(packagePath,package)` の順序:

1. `NOVEL_SAVE_ROOT`が設定されていれば絶対pathを要求し、そのpathを使う。
2. SDL video driverが`dummy`ならテスト用にpackage横`/saves`を使う。
3. `native_ui.save_id`があればsanitizeし、なければpackage parent absolute pathからFNV-1a hashを生成した `project-<hex>` をidentifierにする。
4. `SDL_GetPrefPath("NovelScript", id)`を呼ぶ。

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

- 空slot、破損JSON、unsupported version、別saveIdは別stateとして表示し、ロード可能判定から除外する。
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

この資料作成時点ではテストコマンドを実行していない。テスト名の列挙は現在存在する回帰境界を示し、実行成功を主張しない。
