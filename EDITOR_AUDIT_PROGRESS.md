# Novel Script Editor Repository Audit

Last updated: 2026-09-25

Status: Repeated cross-layer syntax/editor consistency pass completed for the repository flows listed below. This is not a claim that every possible input, operating system, hardware configuration, or user workflow has been exhausted. Known feature gaps and untested device boundaries are listed at the end.

## Follow-up Pass (2026-09-25)

- Language/editor consistency: external `goto` file paths now require quotes everywhere; escaped Windows separators normalize from `\\` to `/`; unknown escapes are rejected consistently in include, asset, character-pose, expression, and goto strings. Speakerless `say` is documented accurately as accepting a string expression only when its first token is a string literal.
- IDE consistency: local-scene completion is separated from quoted external-file completion, and quoted paths (including `/` and `.tds`) are replaced as one completion range. Corrected function/struct/global tooltip grammar, removed the duplicate stale syntax-help implementation and dead `sayBlock` flow fallback, and aligned help/reference escape notation.
- Regression coverage: parser rejects unquoted external goto paths and path-context unknown escapes; it accepts string-started speakerless expressions. All TDS code fences in both language references are parsed in a test; IDE help examples and both goto completion contexts are checked in the browser E2E.
- Verification: `npm.cmd test` passed 237/237 with a freshly rebuilt native player and no skips; `node test/editor-analysis-check.cjs`, `node test/full-workflow-e2e.cjs`, and `node test/title-playthrough.cjs` passed. Title Browser playthrough traversed all four chapter files and a route (354 dialogue advances, 2 choices); Native transcript reached the same route (353 dialogue lines).
- Test hygiene: `editor-analysis-check.cjs` now seeds and serves an isolated temporary project so page-exit autosave cannot modify Title. During discovery, an earlier run had overwritten the clean Title appendix fixture and tracked screenshots; their original contents were restored, and a post-isolation run left Title unchanged.

Remaining recovery limitation: parser recovery still masks one entire source line per parse error; same-line multiple-error recovery is not yet a separate diagnostic contract.

## Follow-up Pass (2026-09-24)

- Scene Flow/compiler integration (2026-09-25): audited the existing file-level graph and found that include files were used only for reachability flags, not rendered relations or range validation; compiler/analyzer diagnostics were also discarded. The graph now preserves the legacy `from`/`to` contract while adding `version: 2`, `start`, `kind: goto|include`, per-node diagnostics and scene reachability counts. Scene Flow adds diagnostic tooltips/details, diagnostic search, and include-relation visibility control; range validation follows both goto and include relations.
- Verification: the dedicated include-path unit test, real-project flow API assertions, Scene Flow browser search/toggle checks, `npm.cmd test` (230 tests: 228 passed, 2 expected native skips), editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Windows distribution boundary (2026-09-24): Electron packaging now includes the prebuilt Native player, its runtime DLLs, image checker, and `engine_data`; packaged startup places the default writable project under the user's Documents folder instead of the installed application directory, and existing Native binaries are reused without requiring CMake on the target machine. The generated package was started from its own `resources/app` tree and served the editor successfully.
- Verification: `npm.cmd run desktop:package:win` created `release/Novel Script Editor-win32-x64/`; package inspection found the editor executable, Native executable, SDL3.dll, 27 Release runtime files, and engine_data. Packaged server smoke reached `http://127.0.0.1:4291`.
- Syntax/encoding boundary (2026-09-24): the compiler Lexer now accepts only a leading UTF-8 BOM as file metadata without shifting line/column locations; BOMs appearing inside source remain invalid. This closes the gap between formatter normalization and direct IDE/CLI compilation. The syntax reference was synchronized with the implemented include-defined struct visibility rule.
- Verification: `npm.cmd test` passed 229 tests with 0 failures and 2 expected native skips (227 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Syntax-boundary audit (2026-09-24): include-defined struct types are now collected before parsing and merged into the project AST; complete goto paths, include paths, duplicate dictionary keys, ordinary-string escape sequences, CRLF/CR/U+2028/U+2029 line separators, empty path components, Windows-reserved names, and non-canonical asset paths were tested and hardened. Asset paths now require the canonical `asset/` prefix and forward slashes.
- Verification: `npm.cmd test` passed 228 tests with 0 failures and 2 expected native skips (226 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Remaining audit candidate: syntax recovery still masks one entire source line per parse error; same-line multiple-error recovery is not yet a separate diagnostic contract.

- Project-wide formatter completion synchronization (2026-09-24): the Edit-menu all-scene formatter now exposes its in-flight Promise through the editor API, so IDE/E2E callers can wait for every read-format-compile-save operation to finish; project scene reads use `no-store`, and workflow coverage verifies an externally unformatted closed chapter is persisted canonically. Structural header detection is constrained to the first brace on a line so inline dictionary literals remain inline.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis passed on standalone rerun after a concurrent-run timing flake, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Compile-boundary formatting (2026-09-24): IDE project compilation now runs the same project-wide formatter before building, so closed scene files are normalized and persisted before the compiler reads them; full workflow coverage externally corrupts a closed chapter, compiles, verifies its canonical source, and then confirms the player executes the normalized result.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Formatter re-entry protection (2026-09-24): overlapping Edit-menu, embedded-editor, and compile-triggered project-format requests now share one in-flight Promise, preventing duplicate scene writes and refresh races while preserving the public formatter API.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- DSL command-boundary corpus (2026-09-24): formatter regression coverage now exercises background/BGM/character/audio/video/effect/wait/clear/goto commands, nested dictionary indexing, generic dictionary types, and compound boolean branches, with idempotence checks retained for every case.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Cross-line delimiter context (2026-09-24): structural expansion now carries parenthesis and bracket depth between lines in addition to brace context, preventing incomplete or future multiline expressions from turning inner `{}` literals into blocks; a multiline incomplete call/dictionary regression remains idempotent.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- UTF-8 BOM normalization (2026-09-24): the formatter now removes a leading BOM before structural analysis, allowing files imported from Windows editors or external tools to normalize into a compilable canonical scene instead of treating the BOM as source text; a real-editor corpus case verifies the result and idempotence.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Unicode line-separator normalization (2026-09-24): formatter input now converts CRLF, CR, U+2028, and U+2029 to LF before structural expansion, keeping external text sources aligned with editor line numbers and indentation; Unicode-separated block input is covered by the real formatter corpus.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Project-format rollback safety (2026-09-24): all project scene sources are now read and formatted before any writes; if a later scene write fails, already-written scenes are restored in reverse order and the original error is rethrown, reducing partial-formatting damage during permission or transport failures.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Failed-write recovery coverage (2026-09-24): rollback now also includes the scene whose PUT itself failed, covering servers that may have written before returning a transport or response error; successful and failure paths retain the original error contract.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Rollback browser E2E (2026-09-24): full workflow now injects a failure into the second project-format PUT and verifies both the previously written scene and the failed scene retain their original source, proving recovery through the actual browser/API path.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Cross-line delimiter context (2026-09-24): structural expansion now carries parenthesis and bracket depth between lines in addition to brace context, preventing incomplete or future multiline expressions from turning inner `{}` literals into blocks; a multiline incomplete call/dictionary regression remains idempotent.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Typed-return scaffold parity (2026-09-24): Enter-time function scaffolding now recognizes parser-supported generic returns such as `dict[str]` and `dict[int]`, matching the formatter's existing typed-signature support; Browser coverage verifies a `dict[str]` function body is generated canonically.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Project-format API parity (2026-09-24): `window.novelEditorApi.formatProject()` now exposes the same all-scene normalization used by the Edit menu, allowing embedded panes, Electron lifecycle code, and automated IDE validation to invoke one project-wide formatter contract.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Project-wide formatting command (2026-09-24): Edit menu now provides `全シーンを整形`, normalizing both open panes first and then reading/formatting/saving every scene file, including files not currently open in the IDE; the embedded editor API exposes a current-source formatter for split-pane coordination.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Virtual closing-brace formatting (2026-09-24): `beforeinput(insertText, data='}')` now applies the same standalone-closing-brace normalization as keydown, covering virtual keyboards and IME text insertion without touching inline expressions or strings.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Virtual line-break formatting (2026-09-24): `beforeinput(insertLineBreak)` now uses the cursor-safe formatter path, covering virtual keyboards and IME-style line insertion that bypasses the normal keydown handler; Browser regression verifies canonical indentation.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Braced-choice Enter scaffolding (2026-09-24): promptless and prompted `choice {` headers now generate the first empty option and missing outer close on Enter, while an existing close is respected; this completes the choice-specific input paths alongside generic block scaffolding.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Selection outdent precedence (2026-09-24): Shift+Tab now bypasses autocomplete acceptance even when suggestions are visible, so selected-line outdent remains deterministic and independent of completion state.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Trailing-whitespace invariant (2026-09-24): formatter output now performs a final line-end whitespace sweep, guaranteeing canonical results for comment lines, tab-suffixed statements, and whitespace-only lines; a dedicated formatter corpus case locks this invariant.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- External drop formatting parity (2026-09-24): drag-and-drop text now shares the paste normalization path, including line-ending normalization, canonical formatting, and cursor-safe insertion; Browser coverage verifies a real `DragEvent` result.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Menu-accessible formatting (2026-09-24): the Edit menu now exposes `整形 (Ctrl+Shift+F)` and routes through the same cursor-preserving formatter as the keyboard shortcut; Browser coverage verifies the menu action produces canonical output.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Braced-header Enter scaffolding (2026-09-24): pressing Enter after a regular block header that already ends in `{` now creates a missing closing brace and canonical blank body, while existing closers are detected and not duplicated; choice-specific scaffolding remains isolated.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- New-scene draft normalization (2026-09-24): newly created scene drafts now start with canonical LF line endings instead of constructing CRLF directly, keeping generated editor content aligned with formatter and save normalization.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Autosave formatting parity (2026-09-24): page-unload persistence now formats through the same canonical formatter as explicit save/compile, closing the last direct `editor.value` persistence path and preventing unformatted sources during window/page termination.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- DSL block scaffold parity (2026-09-24): Enter-time structure generation now covers promptless `choice` and `elif` alongside every parser-level block form (`scene`, `fn`, `if`, `else`, `for`, `while`, `character`, and `struct`), with direct editor regressions for the newly covered forms.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Closing-brace input normalization (2026-09-24): a standalone `}` typed on an otherwise blank/whitespace-only line now immediately adopts canonical block indentation, while inline dictionary/string content remains untouched; the regression also confirms existing trailing-newline preservation.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Choice/branch Enter scaffolding (2026-09-24): promptless `choice` now creates a canonical first option block, and incomplete `elif` headers now create an empty branch body, closing the remaining structural Enter gaps beside `if` and promptful choices.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Structural-header Enter scaffolding (2026-09-24): Enter on incomplete `scene`, typed `fn`, `for`, `while`, `character`, `struct`, or `else` headers now creates a canonical empty block and places the caret inside it, extending the existing `if`/`choice` scaffolds.
- Marker-only blank-line normalization (2026-09-24): formatter replacement now removes indentation left behind when a cursor or selection marker occupied an otherwise empty line, keeping generated blocks free of trailing whitespace and preserving canonical blank lines.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Save-boundary canonical formatting (2026-09-24): `saveScene` now normalizes the current source through the same cursor-safe formatter before persisting it, so files saved from the IDE cannot retain avoidable indentation or spacing drift. Full-workflow coverage saves deliberately unformatted source and verifies canonical persistence, compile, playback, reload, and fresh-process restoration.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Paste-time canonical formatting (2026-09-24): multiline or inline script pasted into the editor now passes through the same formatter and cursor-safe replacement path, normalizing line endings and preserving string/interpolation contents. Browser coverage dispatches a real cancellable ClipboardEvent and verifies the canonical result.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Selection indentation controls (2026-09-24): Tab and Shift+Tab now indent or outdent every line touched by a multi-line editor selection, while preserving the selection and participating in the existing undo history. Browser regression coverage verifies round-trip indentation inside a scene block.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Selection mapping hardening (2026-09-24): selection endpoints at exact line starts/ends now move with per-line indentation deltas, including outdent clamping at document offset zero; Browser coverage verifies endpoint preservation and Undo/Redo restoration.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Dynamic choice-label context (2026-09-24): formatter context is now typed, so choice options expressed as identifiers, numeric labels, or calls expand as blocks while command-led dictionaries and `return { ... }` literals remain inline.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Unary choice-label coverage (2026-09-24): choice-option structure detection now also recognizes labels beginning with unary `+` or `-`, keeping malformed-but-parseable expressions formatted for later diagnostics instead of collapsing the option body.
- Verification note: the parallel Editor run hit the known startup timing miss; the required standalone Editor rerun passed after aligning the new regression's expected spacing with the existing unary-expression rule.
- Structured formatter fuzz expansion (2026-09-24): deterministic idempotence coverage now mixes scenes, conditionals, choices, dynamic labels, nested dictionary literals, return literals, comments, and closing branches across 1,000 generated inputs.
- Dynamic choice-expression semantics (2026-09-24): semantic formatting coverage now compiles a choice whose prompt is a dictionary element and verifies formatted/unformatted programs remain equivalent after location metadata is removed.
- Unary-operator boundary preservation (2026-09-24): consecutive unary operators now retain an explicit separator (`- -1`) instead of being collapsed into a visually ambiguous token sequence; the formatter corpus covers this normalization.
- Compound choice-label semantics (2026-09-24): semantic coverage now includes a choice label built from dictionary indexing plus string concatenation, verifying expression-level labels remain compilable and equivalent after formatting.
- Expression-brace discrimination (2026-09-24): structural expansion now tracks parentheses and brackets, so dictionary literals inside choice prompts/calls are not mistaken for option blocks; formatter and semantic regressions cover `choose({"key":"go"})`.
- Incomplete-input idempotence (2026-09-24): formatter fuzz inputs now include unclosed choice calls and dictionary literals, covering the editor's mid-typing state without requiring compilation to succeed.
- Branch-chain whitespace normalization (2026-09-24): blank lines between a closing branch and its `elif`/`else` are now removed when joining the canonical chain, matching the existing same-line branch normalization.
- Signed grammar corpus (2026-09-24): formatter coverage now combines negative/positive loop bounds, typed function signatures, dictionary indexing, return expressions, and signed comparison operands.
- Branch-chain semantic preservation (2026-09-24): compilation-equivalence coverage now includes source branches separated by blank lines, proving whitespace normalization does not alter conditional structure.
- Branch-chain selection anchoring (2026-09-24): Editor regression coverage now selects a branch body across blank-line removal and verifies both selection endpoints remain attached to the same text after formatting.
- Keyword-parenthesis spacing (2026-09-24): formatter spacing now separates keyword-led parenthesized expressions (`not (...)`, `return (...)`, `choice (...)`) from ordinary function calls, with direct editor regressions for each structural form.
- Keyword-parenthesis semantic preservation (2026-09-24): compile-equivalence coverage now includes parenthesized `not`/`return` expressions and a parenthesized choice prompt.
- Position formatting (2026-09-24): formatter tokenization and compile-equivalence regressions cover the canonical underscored positions.
- Position completion (2026-09-24): IDE autocomplete offers only the canonical underscored position spellings.
- Image-position completion parity (2026-09-24): `show image` exposes the same canonical position candidates as character display.
- Position syntax-highlighting parity (2026-09-24): canonical and legacy position names are now classified as IDE builtins, and the `show` command help documents both accepted spellings.
- Image position semantic preservation (2026-09-24): semantic formatting coverage compiles an image asset displayed with canonical `far_right`, extending verification beyond character poses.
- Position tokenizer parity (2026-09-24): syntax highlighting classifies canonical underscored positions as builtins, with a DOM-level highlight regression.
- Whole-document selection coverage (2026-09-24): formatting a complete document selection now has an end-to-end regression proving canonical indentation, final newline preservation, and selection endpoints at 0 and the formatted document length.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- If/elif/else chain coverage (2026-09-24): compact conditional chains now have canonical multiline regression coverage; each branch body expands independently while `} elif {` and `} else {` remain joined.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Escaped choice-label coverage (2026-09-24): formatter tests now include escaped quotes and brace-like text inside option labels, confirming quote scanning remains active until the real closing quote and nested choice blocks stay canonical.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Promptless choice coverage (2026-09-24): formatter regression coverage now handles `choice { ... }` without a prompt, including compact option labels and nested option blocks.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Input-normalization corpus (2026-09-24): formatter regression coverage now includes tabs, CRLF/CR normalization, and trailing `//` comments after compact blocks; all converge to the same canonical indentation and comment attachment rules.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Nested multiline dictionary comments (2026-09-24): added a regression combining an outer `if`, nested dictionaries, multiple lines, and a comment after an inner close; dictionary braces retain their nesting and comment indentation remains stable.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Function-return dictionary coverage (2026-09-24): compact function bodies containing `return { ... }` now have regression coverage proving only the function block expands while the returned dictionary remains an inline literal.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); Browser, Native SDL smoke, and full-workflow E2E passed. Parallel Editor hit the known startup timing miss; standalone Editor rerun passed.
- Collision-safe internal marker delimiters (2026-09-24): formatter markers now use non-identifier private delimiters, so ordinary identifiers resembling the former marker names (for example `__NOVEL_EDITOR_CURSOR__value`) remain a single user token.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); Browser, Native SDL smoke, and full-workflow E2E passed. Parallel Editor hit the known startup timing miss; standalone Editor rerun passed.
- Composite-operator range preservation (2026-09-24): selection-end markers no longer move past formatter-inserted trailing spaces, while selection-start/caret markers still move after leading inserted spaces; selecting exactly `>=` therefore preserves both endpoints and the operator text.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Exact marker tokenization and range anchoring (2026-09-24): cursor/selection markers are lexed before ordinary identifiers so they cannot consume adjacent numbers or words; cursor starts move past formatter-inserted spaces while selection ends remain before newly inserted trailing spaces.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Unary-operator caret anchoring (2026-09-24): formatting now distinguishes real composite operators from separate `=` and unary `-`, preserves `value = -1`, and moves a caret across newly inserted spaces so its logical position remains before `-1`.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Composite-operator caret preservation (2026-09-24): formatting now suppresses artificial spacing immediately after an embedded marker for all token kinds, preserving operators such as `>=` when the caret is between their characters; the correction also retains spaces in selections that begin at a line or string boundary.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Nested call-literal coverage (2026-09-24): added a compact `if` case containing `fn({ "x": 1 })`; formatting expands only the outer block and retains the inner dictionary literal inline.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); Browser, Native SDL smoke, and full-workflow E2E passed. Parallel Editor hit the known startup timing miss; standalone Editor rerun passed.
- Structural-prefix and quoted-brace hardening (2026-09-24): block detection now uses only the current statement prefix and ignores braces inside strings, preventing function-argument dictionary literals and choice labels such as `"a {b}"` from being misclassified as structural blocks.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Identifier-interior selection preservation (2026-09-24): added an end-to-end case selecting a substring entirely inside `far_left`; formatting preserves the exact source and relocates both selection endpoints without introducing spaces.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Identifier-interior caret preservation (2026-09-24): formatting markers now record when they are embedded inside an identifier and suppress artificial token spacing across that marker, so formatting a caret inside `far_left` preserves the identifier and relocates the caret correctly.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Block-comment attachment hardening (2026-09-24): trailing `#` comments after compact structural blocks remain attached to the formatted closing brace, preserving source association and stable repeated formatting.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Trailing structural comments (2026-09-24): compact block formatting now keeps a comment following the closing brace attached to that closing line instead of moving it to an unrelated standalone line; the result remains idempotent.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Nested-literal boundary coverage (2026-09-24): formatter corpus now covers nested dictionaries inside executable blocks and choice labels containing brace-like text, proving literal/label braces do not become structural block boundaries.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis passed on standalone rerun, Browser, Native SDL smoke, and full-workflow E2E all passed. The parallel Editor invocation hit the known startup timing miss before the standalone pass.
- Mixed-script semantic corpus (2026-09-24): editor E2E now compiles compact and formatted variants containing dictionary updates plus choices, and character metadata plus scene dialogue. Comparison ignores only source-location metadata, so formatter-induced line/column movement cannot hide changes to generated semantics.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed. Parallel Editor also passed after the timing-sensitive run completed.
- Multiline dictionary/context coverage (2026-09-24): formatter regression cases now prove top-level and nested multiline dictionaries retain dictionary semantics while block context indents surrounding executable code; cross-line block closures after declaration lines are expanded correctly.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Cross-line brace context (2026-09-24): structural formatting now carries block/dictionary brace context across lines, so a block opened on one line and closed after a declaration line is expanded correctly while multiline dictionary closures remain non-structural.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Structural formatter regression coverage (2026-09-24): added canonical output cases for compact blocks containing dictionary literals, character declarations, functions, and nested choice options. Dictionary braces remain inline while executable block braces expand and indent deterministically.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); Browser, Native SDL smoke, and full-workflow E2E passed. Parallel Editor hit the known tab-timing miss; standalone Editor rerun passed.
- Structural block expansion (2026-09-24): formatter now expands compact `scene`/`if`/`else`/`for`/`while`/`choice`/`character`/`struct` blocks into canonical multiline form while preserving inline dictionary literals. `else` remains joined to its closing brace, and nested choice options receive deterministic indentation.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Deterministic formatter fuzz coverage (2026-09-24): added 500 generated whitespace/brace/comment/string cases to the real editor E2E and require each formatted result to be idempotent. A 5,000-seed exploratory probe also found no non-idempotent case before the smaller regression corpus was committed.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Collision-safe formatter markers (2026-09-24): formatter cursor/selection markers now avoid names already present in source text, and marker boundaries reuse the surrounding real-token spacing rules. Added coverage for marker-like text inside dialogue, including a diagnostic-selected range, preventing spaces such as `say narrator` from collapsing.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Formatter-to-completion continuity (2026-09-24): added a real IDE regression that formats an indented `show` command, preserves the caret at the partial position, accepts the position completion, and verifies the resulting source does not gain an unwanted trailing space before an existing newline.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Format/edit-history continuity (2026-09-24): added a regression for `format -> type -> undo -> undo -> redo -> redo`, proving typing and formatting remain separate reversible history entries and restore the exact source in order.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Diagnostic-link to formatter continuity (2026-09-24): added a real IDE regression that clicks an `unreachable-code` diagnostic, confirms the source selection, formats the document, and confirms the selected token remains the same after indentation changes.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Multi-line selection preservation (2026-09-24): added an end-to-end regression for selections spanning nested control-flow lines, verifying both boundaries move to the corresponding formatted source offsets while preserving the selected content.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Formatter cursor/selection preservation (2026-09-24): `Ctrl+Shift+F` now preserves both caret and selected ranges through indentation and operator reformatting, including selections ending inside string literals. Formatting markers are treated as invisible tokens and end-of-document formatting avoids marker-induced trailing spaces or closing-brace layout changes.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Formatter diagnostic-location contract (2026-09-24): added a regression that validates the same unreachability diagnostic before and after formatting through `/api/validate`, preserving code, line, and message while moving the column to the formatted indentation.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Formatter semantic contract (2026-09-24): exposed the existing pure formatter through the editor API for contract testing and added a regression that compiles the original and formatted source through `/api/compile`, requiring identical generated programs. This verifies formatting does not change compiler meaning.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); Browser, Native SDL smoke, and full-workflow E2E passed. Parallel Editor hit the known tab-timing miss; standalone Editor rerun passed.
- Formatter corpus expansion (2026-09-24): added real-editor cases for CRLF normalization, blank lines, indexed/call expressions, comments containing braces, escaped strings, compact choices, and repeated-format idempotence. The corpus runs through the same keyboard shortcut path used by the IDE.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Formatter contract hardening (2026-09-24): expanded the real editor E2E formatter coverage for nested `if`/`else`/`while`, unary and binary operators, braces inside strings, line comments, compact closing braces, and idempotence when formatting an already formatted document. Existing undo/redo coverage remains active.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Background/BGM replacement analysis (2026-09-24): added conservative `background-replacement` and `bgm-replacement` warnings for direct replacement of a different active asset without `clear`; explicit clears, same-asset replay, and branch/loop state paths remain modeled without rejecting intentional transitions.
- Verification: `npm.cmd test` passed 217 tests with 0 failures and 2 expected native skips (215 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Detailed merged image-slot occupant coverage (2026-09-24): added a regression proving a later `show image` reports each statically possible prior image in a branch-merged slot, preserving the exact command range and actionable predecessor names.
- Verification: `npm.cmd test` passed 216 tests with 0 failures and 2 expected native skips (214 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Detailed merged-slot occupant coverage (2026-09-24): added a regression proving a later `show` reports each statically possible prior character in a branch-merged slot, preserving the exact command range and actionable predecessor names.
- Verification: `npm.cmd test` passed 215 tests with 0 failures and 2 expected native skips (213 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Final regression after character branch-hide coverage (2026-09-24): all four cross-layer checks remained green after the branch merge test was added.
- Verification: `npm.cmd test` passed 214 tests with 0 failures and 2 expected native skips (212 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Branch-dependent character hide coverage (2026-09-24): added a regression proving `hide-unshown-character` is emitted after a branch where only one path showed the character, with exact command range, while preserving the existing valid-path behavior.
- Verification: `npm.cmd test` passed 214 tests with 0 failures and 2 expected native skips (212 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- IDE background divergence contract (2026-09-24): the real editor-server `/api/validate` path now has coverage for a branch-dependent `clear bg`, including warning severity and exact line/column/end-column, using an actual project background asset.
- Verification: `npm.cmd test` passed 213 tests with 0 failures and 2 expected native skips (211 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Branch-dependent background clear analysis (2026-09-24): added `background-clear-path-dependent`, mirroring BGM analysis while avoiding warnings for initial clears or paths where a background is definitely active.
- Verification: `npm.cmd test` passed 213 tests with 0 failures and 2 expected native skips (211 passed); editor-analysis, Native SDL smoke, and full-workflow E2E passed. Parallel Browser media startup hit a source-support failure; standalone Browser rerun passed.
- Branch-dependent BGM clear analysis (2026-09-24): added `bgm-clear-path-dependent` warnings only when a merged control-flow state has BGM active on some paths and absent on others. Initial `clear bgm` and clears that are definite on every path remain accepted.
- Verification: `npm.cmd test` passed 212 tests with 0 failures and 2 expected native skips (210 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Diagnostic range precision (2026-09-24): parser command AST nodes now retain end line/column at the actual command boundary, so character, image, and video SceneState warnings can highlight the complete offending command rather than only its start point.
- Verification: `npm.cmd test` passed 211 tests with 0 failures and 2 expected native skips (209 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- External goto state-inheritance verification (2026-09-24): added a loaded-program regression proving external transfers preserve the same SceneState, record the transfer before loading, and allow the destination program to clear inherited background state.
- Verification: `npm.cmd test` passed 211 tests with 0 failures and 2 expected native skips (209 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Goto state-inheritance contract (2026-09-24): SceneState now records internal and external goto transfers with target, transfer kind, and logical time, and emits a `goto` event before the destination executes. This makes inherited background/audio/character state traceable across scene boundaries.
- Verification: `npm.cmd test` passed 210 tests with 0 failures and 2 expected native skips (208 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Choice-to-SceneState merge contract (2026-09-24): Runtime now records each selected choice's prompt, labels, selected index/label, and logical time, then emits a `choice` SceneState event before executing the selected branch. Branch effects therefore remain attributable to the selection that produced them.
- Verification: `npm.cmd test` passed 209 tests with 0 failures and 2 expected native skips (207 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Background provenance contract (2026-09-24): background replacement and clearing now expose `replacedAsset`/`clearedAsset` on host operations, matching the BGM provenance model while retaining the unified SceneState background value.
- Verification: `npm.cmd test` passed 208 tests with 0 failures and 2 expected native skips (206 passed); Browser, Native SDL smoke, and full-workflow E2E passed. Parallel editor E2E hit the known tab-timing miss and the standalone rerun passed.
- BGM action provenance contract (2026-09-24): SceneState BGM replacement and clearing now expose `replacedActionId`/`actionId` on the host operation, in addition to recording stopped reasons internally. Browser/Native hosts can therefore observe the same replacement and clear lifecycle.
- Verification: `npm.cmd test` passed 207 tests with 0 failures and 2 expected native skips (205 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- IDE image-slot diagnostic contract (2026-09-24): added a real editor-server `/api/validate` regression using existing project image assets, proving `image-slot-conflict` is returned while validation remains successful.
- Verification: `npm.cmd test` passed 206 tests with 0 failures and 2 expected native skips (204 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Static image-slot conflict analysis (2026-09-24): image lifecycle tracking now records image ID and slot, warning when a different statically known image remains in the same slot. Re-showing the same image and clearing before a later valid show remain handled without false positives.
- Verification: `npm.cmd test` passed 206 tests with 0 failures and 2 expected native skips (204 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Static image-layer lifecycle analysis (2026-09-24): added `clear-unshown-image` warnings when a literal image ID is cleared before it is statically shown. Branches, choices, loops, and terminating transfers follow the same conservative path model as character placement analysis.
- Verification: `npm.cmd test` passed 205 tests with 0 failures and 2 expected native skips (203 passed); editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Unshown character diagnostic (2026-09-24): added conservative `hide-unshown-character` warnings when a literal character is hidden before it is statically shown. Valid show/hide sequences remain accepted, and control-flow uncertainty does not create false positives.
- Verification: `npm.cmd test` passed 204 tests with 0 failures and 2 expected native skips; editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.

- Character slot conflict analysis: added conservative `character-slot-conflict` warnings for statically known different characters shown at the same position. Same-character pose changes and explicit `hide`-then-show sequences remain valid; `/api/validate` coverage confirms the IDE contract.
- Reachability precision for placement diagnostics: character-slot analysis now stops after `goto`/`return`, preventing impossible later commands from producing placement warnings. A regression covers a transfer followed by a conflicting `show`.
- Verification: `npm.cmd test` passed 197 tests with 0 failures and 2 expected native skips; editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- SceneState action unification (2026-09-24): timed `effect fade` operations now register a blocking action with an action ID, duration, start time, and completion status, matching BGM/SE/Voice/Video action tracking while preserving the existing transition state.
- Verification: `npm.cmd test` passed 198 tests with 0 failures and 2 expected native skips; editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Character transition action unification (2026-09-24): timed `show ... fade` and `hide ... fade` now register blocking SceneState actions with duration and action IDs. Hide keeps the character transition state until completion, then commits visibility and slot release; instant commands preserve their previous behavior.
- Verification: `npm.cmd test` passed 199 tests with 0 failures and 2 expected native skips; editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Async video replacement contract (2026-09-24): Browser playback now treats the video layer as single-owner, matching Native's single `Video` instance. Starting a new video removes the previous element and calls the Runtime stop-action path with reason `replaced`; the SceneState action lifecycle is now observable for this replacement.
- Verification: `npm.cmd test` passed 200 tests with 0 failures and 2 expected native skips; editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Static video-layer replacement analysis (2026-09-24): added `video-layer-replaced` warnings for a new video started while a statically known async video is active. Blocking video completion clears the active layer fact; branch/choice/loop paths are tracked conservatively.
- Verification: `npm.cmd test` passed 201 tests with 0 failures and 2 expected native skips; Browser, Native SDL smoke, and full-workflow E2E passed. Parallel editor E2E had a tab-timing miss and the standalone rerun passed.
- IDE video diagnostic contract (2026-09-24): added a real editor-server `/api/validate` regression proving `video-layer-replaced` is returned for two active async video commands using a project asset, while validation remains successful.
- Verification: `npm.cmd test` passed 201 tests with 0 failures and 2 expected native skips; Browser, Native SDL smoke, and full-workflow E2E passed. Parallel editor E2E had the known tab-timing miss and the standalone rerun passed.
- IDE variable/video integration coverage (2026-09-24): confirmed the real project validation path reports `video-layer-replaced` while preserving existing static variable-table constraint behavior; the test uses an actual project `.mp4` asset path and verifies validation remains successful.
- Verification: `npm.cmd test` passed 201 tests with 0 failures and 2 expected native skips; editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Final IDE validation pass for the video-layer contract (2026-09-24): the temporary project now supplies a real `.mp4`-named asset, so `/api/validate` exercises extension checks, asset existence, compilation, and `video-layer-replaced` diagnostics together rather than relying on an analyzer-only fixture.
- Verification: `npm.cmd test` passed 201 tests with 0 failures and 2 expected native skips; editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- BGM replacement provenance (2026-09-24): SceneState BGM replacement now assigns the stopped action a `replacedBy` action ID, preserving the exact old-to-new relationship for instant switches and later diagnostics/telemetry.
- Verification: `npm.cmd test` passed 199 tests with 0 failures and 2 expected native skips; editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- SceneState character fade completion (2026-09-24): `show ... fade` and `hide ... fade` now share the blocking action lifecycle with timed effects. Hide keeps the slot occupied during the transition and releases it only after the action completes, matching the intended temporal model.
- Verification: `npm.cmd test` passed 199 tests with 0 failures and 2 expected native skips; editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.

## Follow-up Pass (2026-09-22)

The additional path audit found one confirmed project-boundary defect after the earlier pass. A Windows hard link named `setting.txt` passed the path checks because its resolved path still appeared inside the project. The settings API then overwrote the external file sharing that hard link. The API reproduction returned HTTP 200 before the fix.

The follow-up rejects symlinks and files with multiple hard links in project settings, scene, asset, metadata, and package paths. It also routes project scene reads through the checked resolver, prevents scene enumeration through an external scenario-root junction, checks CLI package input/data roots, and prevents package asset copies from following linked output folders. Project seeding now creates new files exclusively and validates existing files before leaving them in place.

Added regression coverage for settings API writes, project startup, seed files, CLI package reads, external `.novel` junctions, linked package output folders, and scenario-root replacement. These tests use Windows directory junctions and hard links because this machine denied file-symlink creation with `EPERM`.

Latest verification after the follow-up changes:

- `npm.cmd test` with `NOVEL_NATIVE_EXE` set to the fresh temporary CMake build: TypeScript build passed; 108 tests passed, 0 failed. This includes native/browser parity fixtures for dictionary copy behavior, includes and initialization order, and malformed `int("+-1")` conversion.
- `node test/editor-analysis-check.cjs`: PASS.
- `node test/browser-check.cjs`: PASS.
- `node test/native-smoke.cjs` with the fresh executable: PASS for image, audio, video, dialogue, choice, and transition paths using dummy media drivers.
- `node test/full-workflow-e2e.cjs`: PASS after the final scenario-root guard; project creation, edits, saves, build/play, diagnostics, reload, and server restart.
- `npm.cmd run desktop:package:win` with an isolated `%TEMP%` output directory: PASS after the follow-up server changes. A launch/close test of this newly built package was rejected by automatic tool review before process creation. The previous audit's packaged Electron launch/close evidence refers to the earlier package build, so this latest packaged binary's GUI launch is unverified.
- `git diff --check`: no whitespace errors; Git printed its configured LF/CRLF notices.

The new security fix and regression evidence are reflected in the findings table below as `AUD-014`.

## Architecture

- Language: `src/parser/lexer.ts` tokenizes source; `src/parser/parser.ts` builds the AST; checker and analyzer modules validate types, names, scopes, and control flow; `src/compiler/compiler.ts` lowers analyzed scripts to version 2 instructions.
- Project build: `tools/project.js`, `tools/project-layout.js`, `tools/static-variables.js`, and `tools/pack.js` resolve project files, includes, external scene transfers, metadata, assets, and version 1 package output.
- Editor: `Edit/editor.js` owns the web IDE, tabs, split view, project picker, diagnostics, completion, formatting, and save state. `Edit/server.js` serves editor pages and project APIs. JSON over local HTTP is the editor/backend boundary; it is not Electron IPC.
- Browser game player: `Edit/player.js` compiles/loads scenes and renders dialogue, choices, images, audio, video, and transitions through `Edit/runtime.js`.
- Desktop wrapper: `Edit/electron-main.js` starts the local editor server and opens the editor in a sandboxed BrowserWindow. Closing the window calls `window.novelEditorApi.saveAll()` before destruction.
- Native runtime: `native/runtime.hpp` executes package instructions; `native/player.cpp` supplies SDL rendering and audio/video playback; `native/main.cpp` selects interactive, smoke, and headless modes.
- Package data: project source is UTF-8 `.tds` text under the configured scenario directory; settings and variable/asset tables live under `.novel`; build output is `.novel/build/*.nsp.json`.

## Language Pipeline

Observed data flow:

`editor source -> UTF-8 API request -> lexer tokens -> AST with source locations -> type/data-flow/control-flow checks -> version 2 instruction JSON -> project resolver/package -> browser or native version 1 runtime -> commands and game state`

- Lexer positions use JavaScript string offsets and columns, so offsets/columns are UTF-16 code units. Parser and diagnostics retain file, line, and column data; an editor click test after an emoji verified the reported source selection.
- There is no separate source-normalization pass in the current implementation. The lexer consumes source directly; project/path normalization is handled by project-layout and resolver helpers; HTTP payloads and packages use JSON serialization.
- Errors flow from lexer/parser/checker/compiler to API diagnostics and then the editor. Invalid lexer characters and malformed syntax produce syntax errors; project path escapes and malformed project metadata return explicit HTTP errors.
- Browser and native implementations consume the same packaged instruction representation. The automated runtime suite compares globals and command traces for the historical audit regression cases.

## Problems Found

| ID | Severity | Finding | Root cause and repair | Evidence |
|---|---|---|---|---|
| AUD-001 | P2 | Some documented reserved words were accepted as identifiers. | Parser keyword set lagged the language specification. Added the missing words and a full reserved-word regression. | Parser test and full suite pass. |
| AUD-002 | P2 | Completion offered obsolete `char` and `at` syntax. | Editor completion maintained an independent stale list. Removed the old entries and checked the live completion UI. | Browser editor check passes. |
| AUD-003 | P2 | Editor browser audit test targeted controls removed by the current UI. | Test selectors and workflows had not followed the menu/split-pane UI. Updated the test against current controls. | Browser editor check passes. |
| AUD-004 | P2 | Player test expected the narrator label to be visible. | Test expectation differed from the player, which intentionally renders narrator text without a nameplate label. | Browser player check passes. |
| AUD-005 | P2 | Clicking a type diagnostic selected the start of the line. | Diagnostic text omitted the column, so the editor defaulted to column 1. Added columns and verified UTF-16 selection after an emoji. | Editor browser check passes. |
| AUD-006 | P1 | Scenario and asset symlinks/junctions could cross the project root. | Lexical containment did not resolve filesystem links. Added real-path containment for scene and asset reads/writes/serving. | Junction regression tests pass. |
| AUD-007 | P2 | Project switching ignored dirty content in the split editor; its confirmation could sit behind the picker. | Guard checked only the left editor and the dialog had a lower stacking order. Checked both panes and raised dialog stacking order. | Browser editor check passes. |
| AUD-008 | P2 | Delayed startup restore could overwrite edits after a project switch or fail to restore after reload. | Delayed callback observed mutable project state, and HTML supplied a stale initial scene name. Added root/dirty/name guards and removed the stale initial name. | Full workflow E2E passes through reload and server restart. |
| AUD-009 | P1 | A new project without a UI theme could not open player/settings UI. | Fallback theme existed only in the sample project. Added a server default, solid UI fallbacks for blank image fields, and first-save theme creation. | Browser E2E and project/native package test pass. |
| AUD-010 | P1 | File DELETE through a scenario junction could delete a file outside the project. | DELETE bypassed the safe scene/asset resolvers. Routed deletion through real-path checks and limited it to files. | Regression confirms HTTP 400 and external file preservation. |
| AUD-011 | P1 | A default theme with empty image fields failed CLI packaging and then native smoke. | Blank image values were treated as paths (`ui/`) by packer/native loader. Packer skips empty values; native loader treats them as absent textures. | Fresh native build and arbitrary-title package smoke pass. |
| AUD-012 | P2 | Corrupt variables/assets JSON appeared to be valid empty metadata. | Broad catches converted parse failures and I/O errors into HTTP 200 defaults. Defaults now apply only to missing files; malformed/outside data returns 400 and other I/O errors return 500. | Both malformed metadata regression checks pass. |
| AUD-013 | P1 | Secondary metadata/build/theme paths were not consistently contained by the project root. | Some file routes used derived lexical paths after the primary scene/asset checks. Added safe project data/build/asset resolvers and applied them to package, theme, image, and metadata access. | Junction tests reject external `.novel` and build roots; full suite passes. |
| AUD-014 | P1 | Hard links bypassed the project-root checks for settings, source, metadata, and package output. | Resolved paths do not reveal that an in-root file shares storage with another path. Reject multiply linked files, check regular-file types at read/write boundaries, validate CLI package roots and outputs, and create seeded files exclusively. | Regression first reproduced an external overwrite through `/api/project/settings`; API, CLI, hard-link, and junction regressions now pass. |

The historical `AUDIT-2026-09-08.md` regression candidates were also exercised through the current `test/audit-regression.test.js` fixture matrix, including loop/effect analysis, dictionary aliasing, const flow, includes, transfer behavior, conversions, and syntax placement. Current full-suite run included the fresh native executable, so executable cases compared browser-runtime results with native headless results.

## Root Causes

- Several language/UI definitions were copied into separate lists and drifted from the parser or current interface.
- Project containment was checked on normalized strings in some routes but not on resolved filesystem targets, and some secondary routes skipped the shared resolver.
- Deferred browser work used mutable project state, and API broad catches hid invalid data as empty data.
- Theme defaults and blank-image semantics differed between editor API, browser player, packer, and native player.
- Browser tests encoded old labels/selectors and therefore stopped representing the current UI.

## Changes

- Updated reserved words, completion vocabulary, diagnostic columns, say help text, and stale editor browser checks.
- Protected project switching and startup restore across split panes/reload.
- Added default theme behavior and consistent blank-image handling in browser, packaging, and native execution.
- Applied real-path containment to scene, asset, metadata, and build/package routes; rejected outside-project junction targets for reads, writes, serves, and deletes.
- Made metadata corruption visible instead of silently replacing it with empty data.
- Removed an unused theme-path helper after all callers moved to the safe resolver.
- Added/updated parser, project-layout, browser, and full-workflow regression coverage.
- Preserved the pre-existing dirty worktree. No broad restore or replacement of project files was performed. The untracked `Title/senario/chapter1.novel.tds` was left untouched.

## Tests

- `npm.cmd test` with `NOVEL_NATIVE_EXE` set to a fresh CMake build: TypeScript build passed; 103 tests passed, 0 failed, including native/browser runtime comparison and project path integration.
- `node test/editor-analysis-check.cjs`: PASS for completion, formatting, diagnostics, split editing, and highlighting.
- `node test/browser-check.cjs`: PASS for browser player commands, images, choice, functions, error propagation, and runtime cases.
- `node test/native-smoke.cjs` with the fresh executable: PASS for image formats, characters, clear/fade, mixer audio formats, blocking/async FFmpeg video, choice, and dialogue under SDL dummy drivers.
- `node --test test/project-layout.test.js` with the fresh executable: 3/3 passed, including fresh-project default-theme pack and native smoke plus external-junction/corrupt-metadata checks.
- Deterministic parser fuzz: 5,000 mixed grammar, malformed, newline, and Unicode inputs; only expected parser/lexer errors occurred.
- `node --check` passed for server, player, editor, and the new E2E/integration tests. `git diff --check` reported no whitespace errors; Git only printed its configured LF/CRLF notices.

## E2E

- `node test/full-workflow-e2e.cjs`: PASS. Created a project in the actual project picker, added a scenario and image, edited/saved, compiled, ran dialogue/image/choice/state and external scene transfer, introduced/fixed a syntax error, reloaded, restarted the server, and played again.
- Fresh Windows Electron package built outside the repository with `npm.cmd run desktop:package:win`: PASS.
- Packaged Electron was launched with an isolated temporary user profile. The desktop renderer loaded, the local `/api/files` route returned 200, the renderer `saveAll` callback ran, a native window-close message invoked the close-save hook, and the app exited with code 0.
- Native smoke and browser checks use dummy/headless media drivers. They verify code paths and decoding/command delivery, not physical speaker output, monitor color, or long-duration playback quality.

## Remaining Issues

- No game save/load, backlog/history, skip, or auto-play system was found in the current editor/runtime code. Project source/settings/build persistence exists; runtime game-state save slots do not. These features were not invented as part of this audit.
- File rename and Save As were not found as editor operations. Project switching and recent-project lists do exist. Verify any newer intended workflow before treating absent controls as defects.
- No exhaustive grammar-generated fuzzing, deeply nested/very large input stress run, or cross-platform OS build was performed. The 5,000-case deterministic fuzz run is bounded.
- Native multimedia was tested with SDL dummy audio/video devices. Physical hardware output and long-running playback remain unverified.
- Existing user changes were present before this audit. Review the final diff against that baseline; this report does not claim every pre-existing change was authored here. The fresh native build and packaged Electron output remain under `%TEMP%`: the automatic tool policy rejected recursive deletion after path verification, and no audit application processes remain running.

## Final Assessment

The main implemented path from editing source through validation, project packaging, browser execution, native execution, and packaged desktop startup/close has current automated or end-to-end evidence. The audit found and repaired cross-layer defects in language/UI agreement, startup state, project-root security, metadata errors, and theme handling. No claim is made that absent game features exist or that physical multimedia output and every possible input have been validated.

## Compiler Strengthening Follow-up (2026-09-23)

- Added side-effect-aware constant folding for integer/string expressions and the `str`/`int` builtins. User-function calls, global mutation, evaluation order, and short-circuit conditions remain dynamic.
- Added dead-code trimming after `return`/`goto`, removal of statically false `while` loops, and termination propagation through exhaustive `if`/`choice` bodies.
- Extended compiler termination propagation through always-true `while` and valid `for` bodies that cannot fall through.
- Merged identical constant values across all possible fall-through branches and choice options when conditions/labels are side-effect free; choice-local declarations are excluded from the outer scope merge.
- Type checking no longer leaks declarations from a possibly empty dynamic `for`; post-loop declarations are merged only for statically non-empty ranges whose bodies can fall through. Termination analysis uses the same guarantee.
- While-condition folding now excludes variables written by the loop body and globals written through called functions, preserving finite loops such as `while value < 1 { set value = value + 1 }`.
- Package variable-flow validation now retains the zero-iteration path for dynamic `for` loops while still accepting statically non-empty ranges.
- Analyzer constant evaluation covers safe `str`/`int` conversions and reports a warning for statically known `for` ranges above the runtime 100,000-iteration limit.
- Analyzer estimates provably bounded canonical `while` loops, warns for limit-exceeding or non-progressing directions, and rejects provable first-iteration 64-bit overflow in both `while` and statically non-empty `for` bodies.
- Type-checker termination analysis now understands pure `str`/`int` conversions, keeping its control-flow result aligned with analyzer constant evaluation.
- Global declaration-derived constants are not propagated in the compiler because transferred files execute globals with `preserve=true`; this preserves existing global state across `goto` file transfers. Function-local constants remain optimizable.
- Added regression coverage for optimization output, cross-file state preservation, loop termination, body-mutated while conditions, branch/choice constant merging, dynamic for-flow, builtin conversion flow, for/while loop-limit diagnostics, while/for loop-update overflow, dictionary RHS-before-key evaluation order, runtime choice behavior, and a 128-case compiler/runtime differential corpus.
- Verification: `npm.cmd test` 123/123 passed with `NOVEL_NATIVE_EXE`; `node test/browser-check.cjs`, `node test/editor-analysis-check.cjs`, and `node test/native-smoke.cjs` all passed after the latest changes.

Remaining compiler risk: the differential corpus covers generated branches, loops, and function side effects but is not exhaustive grammar-generated fuzzing; nested dictionary/index side effects and very large inputs remain covered by targeted audit fixtures rather than exhaustive generation.

## Compiler Strengthening Follow-up (continued, 2026-09-23)

- Fixed a cross-layer unsoundness for zero-argument function interpolation such as `"{mutate()}"`. Analyzer purity/condition facts, compiler constant invalidation/effect propagation, and recursion detection now treat these interpolations as real calls.
- Fixed package variable-flow validation so function calls embedded in interpolated strings are walked before accepting a path. A function reading a not-yet-initialized global is now rejected even when reached through a `choice` or command string.
- Added native interpolation execution for `{function()}` so native dialogue and choice evaluation matches the browser runtime and can preserve function side effects.
- Added regression coverage for the optimizer state bug, interpolation recursion, package-flow reads, native headless execution, and browser choice-to-dialogue execution.
- Verification after these changes: `npm.cmd test` 127/127 passed with the freshly rebuilt native executable; `node test/browser-check.cjs`, `node test/editor-analysis-check.cjs`, and `node test/native-smoke.cjs` all passed.

## Compiler Strengthening Follow-up (continued 2, 2026-09-23)

- Package variable-flow now carries immutable constant facts through short-circuit conditions, so a provably skipped external-global read is accepted while a live read is rejected.
- Package flow tracks statically known strings, aliases, concatenations, and nested interpolation calls. It collects all variable-expanded templates before applying call effects, preventing an earlier template call from hiding a later template dependency.
- Type checking now validates statically known nested interpolation strings, including strings assembled from known aliases, while dynamic strings remain unchecked until runtime.
- Native `set` evaluation preserves browser order: the right-hand side runs before const-mutation rejection, and indexed assignment evaluates its key after the value.
- Analyzer unused-variable tracking recognizes dotted interpolation roots.
- Added regression coverage for static nested interpolation aliases, multiple nested templates, immutable short-circuit flow, dotted interpolation usage, and native assignment order.
- Verification: `npm.cmd test` 135/135 passed; `node --check` and `git diff --check` passed; browser, editor-analysis, and native smoke checks all passed.
- Headless native transcript recording now performs the same `say` interpolation as the SDL player, so compiler/runtime differential tests observe function side effects instead of raw template text.
- Added a native-versus-browser nested-interpolation side-effect regression; after rebuilding `native/build/Release/novel_player.exe`, the full suite reached 136/136.

## Compiler Strengthening Follow-up (continued 3, 2026-09-23)

- Package variable-flow now propagates statically known global string writes from user-function return/fall-through paths, so a later text use sees the same template mutation as the runtime.
- Choice flow now models the runtime sequence exactly: evaluate every label, evaluate the prompt, then validate each possible option body from the post-prompt state. This prevents unselected body effects from leaking into labels and preserves prompt effects inside option bodies.
- Compiler choice optimization now follows the same label-to-prompt order and passes the post-prompt constant environment into option-body optimization.
- Added regressions for label-before-prompt effects, prompt effects reaching option bodies, and unselected option-body isolation.
- Verification: `npm.cmd test` with `NOVEL_NATIVE_EXE` set passed 144/144 with 0 failures and 0 skips; browser check, editor-analysis check, and native SDL smoke all passed; `node --check` and `git diff --check` passed.

## Compiler Strengthening Follow-up (continued 4, 2026-09-23)

- Package variable-flow now carries all statically known string return candidates through declarations and assignments, including nested string concatenation returned from a function.
- Return candidates are associated with the exact call expression, so a nested argument such as `wrapper(inner())` cannot leak `inner`'s dormant template into `wrapper`'s safe result.
- Compiler, analyzer, type-checker, and package-flow behavior was checked against the runtime rule that interpolation is expanded in text/choice display positions, while ordinary expression literals remain dormant and eligible for constant folding.
- Added regressions for static return candidates, nested return composition, nested-argument isolation, dormant interpolation conditions, and package-flow condition handling.
- Fixed an editor project-picker startup race by loading `/api/project` before rendering the picker when initial workspace discovery has not completed.
- Verification: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 157/157 with 0 failures and 0 skips; browser check, editor-analysis check, native SDL smoke, Node syntax checks, `git diff --check`, and the full workflow E2E all passed.

## Compiler Strengthening Follow-up (continued 5, 2026-09-23)

- Package variable-flow now tracks string templates nested inside displayed dictionaries, including dictionary aliases, indexed updates, dictionaries returned by functions, templates passed through string/dictionary function parameters, mutations through dictionary-parameter aliases, returned aliases, and function-level dictionary rebinding. Local shadowing and same-named parameters are handled without leaking unrelated locals.
- Added regressions for direct dictionary display, returned dictionaries and aliases, function-parameter forwarding, indexed writes through parameters/local aliases, global dictionary rebinding through functions, and string-parameter value semantics, preventing not-yet-initialized globals from escaping package validation through JSON-style or parameter interpolation.
- Verification after the change: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 166/166 with 0 failures and 0 skips; browser check, editor-analysis check, native SDL smoke, and full workflow E2E all passed.

## Compiler Strengthening Follow-up (continued 6, 2026-09-23)

- Type checking now carries statically known global string templates into function and scene scopes. Nested variables and zero-argument calls introduced by a global template are rejected even when the display is inside a function or scene, matching runtime second-pass interpolation.
- Added regression coverage for both function-local and scene-local displays of a statically assembled global template.
- Verification after the implementation and ledger update: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 166/166 with 0 failures and 0 skips.

## Compiler Strengthening Follow-up (continued 7, 2026-09-23)

- Recursion analysis now follows statically assembled interpolation templates inside function-local and top-level string declarations and assignments. Direct and indirect cycles such as a concatenated `"{first()}"` can no longer reach runtime recursive evaluation; function parameter shadowing is excluded.
- Added direct, indirect, and global-template concatenated-recursion regressions.
- Verification after the implementation: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 166/166 with 0 failures and 0 skips.

## Compiler Strengthening Follow-up (continued 8, 2026-09-23)

- Analyzer integer-overflow checks now cover all provably executed updates in canonical while loops, including the final update after an inclusive boundary and reverse-direction loops that overflow before the runtime iteration limit.
- For loops now also detect repeated constant-delta updates to an outer value, while preserving the existing loop-variable first-iteration check and runtime-limit ordering, including overflow on an early iteration of a range longer than 100,000 iterations.
- Added regressions for final while updates, reverse-direction while overflow, second-iteration for updates, and long-range first-update overflow.
- Verification after the implementation: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 166/166 with 0 failures and 0 skips.

## Compiler Strengthening Follow-up (continued 9, 2026-09-23)

- For-loop overflow analysis now evaluates the known loop variable at each observable iteration, catching cumulative updates such as `value = value + i` and reverse-direction variants that are safe on the first iteration but overflow later.
- The simulation is bounded to the runtime's first 100,000 iterations and uses arbitrary-precision analysis values, preserving the runtime-limit ordering without introducing host-number precision loss.
- Added regressions for positive and negative loop-variable accumulation, including compile-time rejection of programs that previously failed only at runtime.
- Verification after the implementation: `npm.cmd test` passed 164/164 with 0 failures and 2 existing native-player skips when `NOVEL_NATIVE_EXE` was not set.

## Compiler Strengthening Follow-up (continued 10, 2026-09-23)

- Canonical `while` overflow and loop-limit analysis now accepts additional engine-command statements around the single loop-variable update, while rejecting extra assignments/control-flow statements that could invalidate the proof.
- Added a regression for a `say` command before an overflowing update; the compiler now rejects it before the browser/native runtime reaches the overflow.
- Verification after the implementation: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 166/166 with 0 failures and 0 skips.

## Compiler Strengthening Follow-up (continued 11, 2026-09-23)

- The same guarded command-aware update discovery now covers `for` loops, so fixed-string engine commands around a loop-variable or accumulator update do not hide overflow.
- Commands containing interpolation/function effects are excluded from this proof, preventing mutable state hidden in display expressions from being treated as transparent.
- Added a `for` regression with a preceding fixed-string `say`, plus a negative regression showing that an interpolated function inside a command disables the proof when it can reset the accumulator; the valid program remains compilable.
- Final verification after these regressions: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 166/166 with 0 failures and 0 skips.
- Cross-layer verification also passed: browser check, editor-analysis check, full-workflow E2E, and serial native SDL smoke. Native smoke must not run concurrently with workflow checks because both regenerate the shared audit audio asset.

## Compiler Strengthening Follow-up (continued 12, 2026-09-23)

- Added a checked integer evaluator that reports overflow in intermediate arithmetic results, not only in the final assignment value. This covers updates such as `value + 1 - 1` at the signed 64-bit boundary.
- Applied intermediate-result checking to canonical `while` and `for` updates, including the existing loop-variable simulation.
- Complex canonical `while` updates are now simulated through the runtime's observable prefix to distinguish finite convergence from a loop-limit failure.
- Added regressions for intermediate overflow and finite/non-terminating complex updates.
- Verification after the implementation: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 166/166 with 0 failures and 0 skips.
- Cross-layer verification after the implementation also passed in serial order: browser check, editor-analysis check, native SDL smoke, and full-workflow E2E.

## Compiler Strengthening Follow-up (continued 13, 2026-09-23)

- Fixed package variable-flow unsoundness where invoking a function erased the caller function's local string, dictionary, and constant facts. A local dictionary containing an uninitialized-global interpolation can no longer bypass validation after an unrelated function call.
- Function effects now invalidate and recompute only globals; caller locals remain isolated in accordance with runtime lexical scope and copied dictionary arguments.
- Added a package regression for a local dictionary displayed after `noop()`; it now rejects the package before runtime execution.
- Verification after the implementation: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 167/167 with 0 failures and 0 skips.

## Compiler Strengthening Follow-up (continued 14, 2026-09-23)

- Fixed package variable-flow handling for finite `while` loops whose entry condition is currently true but whose body changes that condition. The post-loop state is now retained when the condition is no longer provably true after one body pass, so caller-local templates cannot bypass initialization checks after a function call inside the loop.
- Added a regression with a function-local dictionary template, `while flag == 0`, a `noop()` call, and `set flag = 1`; packaging now rejects the later uninitialized-global interpolation.
- Verification after the implementation and ledger update: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 168/168 with 0 failures and 0 skips.

## Compiler Strengthening Follow-up (continued 15, 2026-09-23)

- Isolated compiler variable-metadata bindings for `if`/`else if`/`else` branches. A same-named local declaration in one branch can no longer rebind sibling-branch references that resolve to the global variable.
- Common declarations that are present on every branch are merged back into the surrounding metadata scope, including their definitions, references, and conservative mutability.
- Added a metadata regression covering a branch-local `x` shadowing a global `x`; each interpolation is now attached to the correct scope.
- Verification after the implementation and ledger update: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 169/169 with 0 failures and 0 skips.

## Compiler Strengthening Follow-up (continued 16, 2026-09-23)

- Extended package variable-flow analysis with per-dictionary static key states. Known keys now track present/removed status, while dictionary literals and known dictionary copies retain a closed key set; statically missing reads and repeated `unset` operations are rejected before runtime.
- The facts propagate through assignments, indexed writes, branches, loops, function parameters, global function effects, scene transfers, and copied dictionary arguments. Dynamic keys remain conservative and are not rejected solely from incomplete information.
- Added regressions for repeated `unset`, a known missing key through a string variable, and a direct read of a known missing key. A 512-case package/runtime combination search and a 196-case function/dictionary search found 0 accepted runtime failures after the fix.
- Verification after the implementation and ledger update: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 170/170 with 0 failures and 0 skips.
- Cross-layer verification also passed in serial order: browser check, editor-analysis check, native SDL smoke, and full-workflow E2E.

## Compiler Strengthening Follow-up (continued 17, 2026-09-23)

- Static dictionary-key facts now propagate through functions returning dictionaries. When every reachable return path yields the same closed key set, callers can validate subsequent indexed reads and `unset`; divergent or unknown return paths remain conservative.
- Added a regression for a dictionary returned from a function followed by a known missing-key `unset`. A focused 16-case returned-dictionary search found 0 accepted runtime failures.
- Verification after the implementation and ledger update: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 170/170 with 0 failures and 0 skips.
- Cross-layer verification after the implementation also passed in serial order: browser check, editor-analysis check, native SDL smoke, and full-workflow E2E.

## Compiler Strengthening Follow-up (continued 18, 2026-09-23)

- Compiler variable metadata now isolates declarations inside possibly zero-iteration `while` bodies, preventing loop-local bindings from hiding an outer variable after the loop.
- Metadata analysis now evaluates statically decidable conditions such as `if 1 == 1`, so declarations from a guaranteed branch are attached to subsequent references and dead branch bindings are not used.
- Added regressions for zero-iteration `while` shadowing and statically selected branch shadowing.
- Verification after the implementation and ledger update: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 172/172 with 0 failures and 0 skips.
- Cross-layer verification also passed in serial order: browser check, editor-analysis check, native SDL smoke, and full-workflow E2E.

## Compiler Strengthening Follow-up (continued 19, 2026-09-23)

- Type checking now follows statically selected branches and merges compatible same-type shadow bindings across all fall-through branches. Incompatible post-branch types are rejected as path-dependent instead of reaching runtime conversion errors.
- The same path-sensitive protection now covers `const` mutability and declarations inside dynamic `while`/`for` loops, including zero-iteration paths and statically guaranteed ranges.
- Compiler variable metadata now isolates dynamic `for` bodies, promotes declarations only for guaranteed non-empty ranges, and omits statically unreachable `while` bodies.
- Added regressions for static and dynamic branch/loop shadowing, same-type metadata merging, const divergence, dynamic/fixed `for` ranges, and unreachable `while` metadata.
- Verification after the implementation and ledger update: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 177/177 with 0 failures and 0 skips.

## SceneState演出モデル実装 (2026-09-23)

- JavaScriptランタイムに背景・立ち絵・画像・BGM・SE・Voice・画面効果を保持する統一 `SceneState` を追加し、シーン遷移後も状態を維持するようにした。
- 立ち絵と画像の標準配置を `far_left` / `left` / `center` / `right` / `far_right` の5スロットへ拡張し、同一slotへの表示を新しい演出で原子的に置換するようBrowser/Nativeを揃えた。
- 演出引数を省略した場合を即時演出として扱い、`fade` を指定した場合だけ時間付き演出にする正規形へ統一した。
- 回帰テストを追加し、SceneStateのslot置換、BGM状態、goto後の状態保持を確認した。
- Verification after the implementation and ledger update: `npm.cmd test` with `NOVEL_NATIVE_EXE` passed 180/180 with 0 failures and 0 skips; native build and SDL smoke also passed.

## IDE compiler integration (2026-09-23)

- IDE live validation now calls the same `compileSource` entry point used by `/api/compile`, so editor diagnostics and player compilation share project resolution, external globals, character tables, asset checks, and the current compiler.
- Added Browser API coverage proving that live validation and compilation both accept the five-slot `far_left` position and preserve the compiled command arguments.
- Verification after the integration: `npm.cmd test` passed 180/180 with 0 failures and 0 skips; Browser, Editor analysis, Native SDL smoke, and full-workflow E2E all passed.

## Static variable value propagation (2026-09-23)

- IDE analysis now injects `.novel/variables.json` static declarations into the same analysis script used by the compiler, so constant thresholds and fixed strings participate in diagnostics and branch analysis.
- The optimizer preserves immutable table values while emitting their declarations, allowing exact 64-bit integer arithmetic and fixed-string initializers to fold without freezing mutable shared variables.
- Added regression coverage for a constant integer threshold, a constant string, and the resulting compiled initializer values.
- Verification after the implementation: `npm.cmd test` passed 180/180 with 0 failures and 0 skips.
## 23. 変数テーブルの値域・許容値制約 (2026-09-23)

- `.novel/variables.json` の `staticVariables` に `int` 用の `min` / `max`、`int` と `str` 用の `possibleValues` を追加。値は64bit整数として検証し、空集合・重複・範囲外の初期値を拒否する。
- 制約は IDE の `validate` とパッケージコンパイルへ同じ `Map` として伝播する。
- コンパイラは可変変数を範囲内の特定値へ固定せず、確定できるリテラル／定数式の代入だけを制約検査する。Browser/Native の実行時意味論は変更しない。
- 条件式では、範囲または `possibleValues` の全候補が同じ結果になる場合だけ常に真／偽と判定し、IDEの到達性・定数条件診断へ反映する。候補が混在する条件は動的なまま保持する。
- コンパイラ最適化にも同じ制約を渡し、確定した分岐だけを削除する。関数引数などのローカル同名変数は制約の対象外にする。
- シーン到達性解析にも制約を渡し、コンパイルで削除される分岐内の `goto` をIDEのシーン到達性グラフへ誤って含めない。
- `for` の開始値・終了値・確定stepに変数テーブルの整数範囲を使い、最大反復回数が100,000回を超え得る場合も `loop-limit` 警告を出す。不確定なstepや方向は従来どおり動的扱いにする。
- `while` も制約付き初期値と単調な確定stepから最大反復回数を推定し、逆方向更新による無限化可能性を警告する。関数呼び出しや複雑な更新は推定しない。
- 文字列 `possibleValues` の有限集合について、同一変数の `==` 分岐が全候補を覆うか検査する。`else` がなく未処理候補がある場合だけ `non-exhaustive-condition` 警告を出す。
- `min/max` の整数範囲でも、同一変数に対する `<`, `<=`, `>`, `>=`, `==` の単純な区間分割が全範囲を覆うか検査する。複雑な式や `!=` は推測しない。
- `if`/`elif` の兄弟分岐では、先行条件の否定から残余値域を絞り込み、後続条件の常に真/偽、`else` の到達不能を検出する。本体内の代入を越えて値域は持ち越さない。
- 同じ残余値域をコンパイラ最適化にも適用し、変数テーブルの `min/max` と `possibleValues` を併用した閾値分岐から到達不能な `else` を生成物から除去する。
- 同一整数変数を参照する単純な `and/or` 条件について、許容値集合または値域の交差・結合を評価し、矛盾条件を常に偽、全範囲を覆う条件を常に真として診断・最適化する。
- `and` 条件が真、または `or` 条件が偽になった場合は、証明可能な内部条件も `knownFacts` に分解してネストした分岐へ伝播する。その他の論理分解は推測しない。
- 値域制約を `definitelyTerminates`/`blockTerminates` にも渡し、制約から常に真と分かる終端分岐後のコードを到達不能として扱う。
- 文字列 `possibleValues` の `==`/`!=` 複合条件も有限集合上で交差・結合を評価し、常時真偽の診断とコンパイラ分岐除去を整数条件と一致させる。
- 関数ごとのグローバル書き込み効果を直接・間接呼び出しから収集し、状態を書き換えない関数では条件事実を保持し、未知または書き換え関数では安全に無効化する。
- 間接呼び出し（`outer_bump` → `inner_bump`）のグローバル書き込みも回帰テストで確認し、Analyzerの条件事実無効化をCompilerの関数効果解析と整合させる。
- Compilerの最適化中も制約Mapをブロック局所で複製し、`set`/`unset`/関数効果/分岐内書き換え後に古い値域を再利用しないようにする。
- 分岐本体には条件成立後の局所値域を渡し、`if difficulty < 2` 本体内の `difficulty >= 2` のようなネスト条件を安全に除去する。merge後は各分岐の書き換えを再び無効化する。
- 純粋関数呼び出し後は分岐値域を維持し、グローバルを書き換える関数呼び出し後は値域を破棄するCompiler回帰を追加する。
- 値域付き代入では、式の推定範囲が制約外に確定する場合はエラー、一部だけ外れ得る場合は警告を出す。動的値そのものは固定化しない。
- 選択肢の確定ラベル重複を `duplicate-choice-label` 警告として検出し、動的ラベルや実行順序は変更しない。
- 本体で制約付き変数を更新しない `while` も、条件が成立し得る場合は無限化／実行上限超過として検出する。
- 制約で常に真と証明された非終了 `while` の後続コードを到達不能として扱い、無限ループ診断と制御フロー診断を一致させる。
- 有限の整数 `possibleValues` にも分岐網羅性検査を適用し、連続 `min/max` 範囲は候補無限性を理由に推測しない。
- `runtime.test.js` で64bit閾値、固定文字列、整数範囲、整数・文字列の許容値集合、不正代入の拒否を回帰検証。
- `npm.cmd test`: 178 passed, 2 skipped (Native executable not configured).

## Compiler Strengthening Follow-up (continued 20, 2026-09-23)

- Branch-local constraint environments are now merged conservatively after `if`/`elif`/`else`: integer bounds use the common envelope, finite values use the union, and writes/calls invalidate affected facts.
- The merged facts are reused by subsequent optimization, while Browser/Native runtime semantics remain unchanged.
- Regression coverage verifies nested branch narrowing, pure-call fact preservation, and mutating-call invalidation.
- Added a post-merge regression proving that an impossible finite-string comparison is removed after a preceding dynamic branch.
- `while` 本体にも条件の真側制約を渡し、変数を書き換える場合は従来どおり制約を無効化する回帰テストを追加。
- 静的な `for` の `start/stop/step` からループ変数の整数値域を作り、本体の条件推論へ渡すようにした。ループ変数の制約はローカル扱いで、外部変数テーブルへ漏らさない。
- 動的な `for` でも変数テーブルの `min/max` と安全な加減算区間を開始値・終了値へ伝播し、step が確定しない場合は推論を行わない。
- `for` の `step` も単一符号の値域なら最小絶対値を使って最大反復回数を推定し、`step` が0または正負混在のときは警告を推定しない。
- Analyzerにも同じ `for` ループ変数のローカル値域を渡し、IDEの本体条件診断・終端判定とCompilerの条件削除を一致させた。
- Analyzerの `for` 本体値域は変数テーブルの加減算区間にも対応し、ループ変数を外側の制約環境へ漏らさない。
- 値域付き累積更新では、少なくとも1回実行されることと更新区間全体が64bit範囲外であることを証明できる場合にエラー、部分的な超過だけを証明できる場合に警告を出す。相関不明のケースは推測しない。
- 単純な定数幅の累積更新は固定反復回数なら最終値まで追跡し、動的反復では値域上限を使った警告に限定する。
- `if`/`elif`/`else` の本体へ条件真側・残余制約を伝播し、分岐内の代入と副作用関数で制約を無効化する。純粋関数呼び出しでは制約を保持する回帰テストを維持。
- 条件式を評価する前にも副作用関数の書き込み効果を制約Mapへ反映し、条件内の関数呼び出し後に初期値域を再利用しないようにした。
- `and`/`or` の短絡右辺と関数引数内の短絡式を実行順に走査し、未実行の副作用を制約無効化へ反映しない回帰テストを追加。
- Verification: `npm.cmd test` passed 178 tests with 0 failures and 2 expected native skips; Browser, Native SDL smoke, full-workflow E2E, and editor-analysis checks all passed.
- Compilerの条件内関数呼び出しも、引数を先に評価し、`and`/`or` の短絡で実行されない右辺を状態無効化の対象外にする実行順序へ統一した。dormant RHS と実行され得る RHS の回帰テストを追加した。
- `elif` 連鎖では、確定真の先行条件後に後続条件の関数効果を適用しないようにし、分岐制約の置換時に同一Mapを消去してしまうCompilerの制約喪失バグも修正した。`npm.cmd test` は179 passed / 0 failed / 2 skipped、Browser／Native／フルワークフロー／IDE検証も通過した。
- `if` が確定偽で `elif` が確定真になる経路でも、後続の `elif` を副作用解析しないように拡張した。回帰テストを追加し、最終検証は `npm.cmd test` 180 passed / 0 failed / 2 skipped、Browser／Native／フルワークフロー／IDE単独実行が全てPASS（IDE並列時のみ既知のUI競合）だった。
- Analyzerの分岐本体を枝ごとの定数Mapで解析し、ある枝の代入・関数効果が sibling `elif` 条件へ漏れないようにした。枝制約とCompilerの既知定数分離を回帰テストで確認し、`npm.cmd test` 181 passed / 0 failed / 2 skipped、Browser／Native／フルワークフロー／IDEもPASSした。
- Analyzerでも `if`/`elif`/`else` の到達枝ごとの制約を共通包絡へmergeし、分岐後の条件推論へ安全に戻すようにした。書込み変数は既存の無効化処理で維持し、`npm.cmd test` 181 passed / 0 failed / 2 skipped、Browser／Native／フルワークフロー／IDE単独実行がPASSした（IDE並列時のUI競合は既知）。
- `choice` の各選択肢も独立した定数・事実・制約環境でAnalyzerを実行し、未選択選択肢の更新が兄弟選択肢へ漏れないようにした。回帰テストとBrowser／Native／フルワークフロー／IDE単独検証を通過した。
- `while` 本体にも独立した制約Mapを渡し、0回実行可能なループ内の絞り込みがループ後へ漏れないようにした。`npm.cmd test` 181 passed / 0 failed / 2 skipped、Browser／Native／フルワークフロー／IDE検証もPASSした。
- 0回実行可能な `while` 内で条件事実を再利用する回帰テストを追加し、ループ後の条件を誤って定数化しないことを確認した。Browser／Native／フルワークフロー／IDEも再検証済み。
- 変数テーブルの `str.possibleValues` にも重複検出を追加し、`int` と同じく許容値の入力ミスをパッケージ時に拒否するよう統一した。回帰テストを追加し、全テストとクロスレイヤー検証を通過した。
- `Edit/schemas/variables.schema.json` を実装規則に合わせ、`int` の64bit文字列形式、`str` の文字列値、`str` での `min/max` 禁止、許容値の一意性をIDE Schemaにも反映した。Schema JSONの構文確認、全テスト、Browser／Native／フルワークフロー／IDEを通過した。
- IDEの `show` 補完候補を5スロット（`far_left` / `left` / `center` / `right` / `far_right`）へ拡張し、言語ガイドと仕様書の位置定義も更新した。IDE回帰テストで `far_left` の補完確定を検証し、Browser／Native／フルワークフローもPASSした。
- IDEの `show` 補完をキャラクター・画像とも5スロット（`far_left` / `left` / `center` / `right` / `far_right`）に統一し、仕様書とIDE回帰テストを更新した。`npm.cmd test` 181 passed / 0 failed / 2 skipped、Browser・Native SDL・full workflow・editor を全てPASSで確認。
- 時間付き演出（`wait` / `fade` / `effect`）の静的整数値を `0..2147483647ms` に制限し、Native の遅延上限とBrowser側の受理範囲をコンパイル時に揃えた。負値・上限超過の回帰テストを追加し、`npm.cmd test` 182 passed / 0 failed / 2 skipped、Browser・Native SDL・full workflow・editor を全てPASSで確認。
- SceneStateに時間付き遷移の `startedAt` / `endsAt` / `progress` / `status` を追加し、blockingな `effect`・キャラクターフェード・`wait` の完了後に論理時計を進める共通処理を実装した。`effect fade <color> <ms>` の引数解釈ミスも回帰テストで修正。`npm.cmd test` 183 passed / 0 failed / 2 skipped、Browser・Native SDL・full workflow・editor（単独実行）をPASSで確認。
- `SceneState.actions` にSE・Voice・Videoを登録し、各アクションの `startedAt` / `blocking` / `status` / `endedAt` を管理するようにした。Videoは `blocking` 完了と `async` 実行中を区別し、同時実行を回帰テストで検証。`npm.cmd test` 184 passed / 0 failed / 2 skipped、Browser・Native SDL・full workflow・editor（単独実行）をPASSで確認。
- BGMアクションの置換・`clear bgm` を `stopped` として `reason=replaced/cleared`、`endedAt` と共に正本へ残すようにした。Browser/Nativeの既存停止挙動と回帰テストで対応を確認。`npm.cmd test` 185 passed / 0 failed / 2 skipped、Browser・Native SDL・full workflow・editor（単独実行）をPASS。
- Runtimeに `completeAction()` を追加し、BrowserのVoice/SE Audioとasync Videoの `ended` イベントを `SceneState.actions` へ反映した。blocking Videoは命令完了時にも完了確定する。終了イベントの回帰テストを追加し、`npm.cmd test` 185 passed / 0 failed / 2 skipped、Browser・Native SDL・full workflow・editor（単独実行）をPASSで確認。
- IDE初期シーン復元を固定800ms待ちだけに依存させず、`loadWorkspace()` 完了直後に復元し、遅延タイマーは補助再試行へ変更した。並列時の `sceneName` 空状態によるファイルツリー競合を修正。単独IDEとBrowser・Native SDL・full workflow・IDEの並列実行を全てPASS。
- 推奨方針に沿ってVoiceを `async`（省略時の既定）/ `blocking` から選べるようにした。TypeChecker・IDE補完・SceneState・Browser Audio終了待ち・Native SDL_mixer終了待ち・仕様書・回帰テストを同期。Native再ビルド後のVoice blocking smoke、Browser・full workflow・editor、`npm.cmd test` 186 passed / 0 failed / 2 skipped を確認。
- Editor compiler contract hardening (2026-09-24): fixed `compileSource` to pass the edited source filename into `compileProject`, exported the live `validate` entry for direct testing, and added regression coverage for IDE validation, compilation, syntax locations, invalid voice modes, and same-file global declarations.
- Verification: `npm.cmd test` passed 190 tests with 0 failures and 2 expected native skips; Browser, Native SDL smoke, full-workflow E2E, and editor-analysis checks all passed.
- Editor diagnostic precision (2026-09-24): project errors for missing assets now retain the asset path's source column instead of always selecting column 1; IDE selection and runtime contract tests cover the new behavior.
- Verification: `npm.cmd test` passed 191 tests with 0 failures and 2 expected native skips; editor-analysis, Browser, Native SDL smoke, and full-workflow E2E passed. A parallel IDE run was also investigated and the standalone rerun passed after updating the old column-1 expectation.
- Include/goto diagnostic contract (2026-09-24): missing include files are now reported as `project-error` rather than `syntax-error`; missing goto/include targets retain their source line and column, alongside existing asset locations.
- Verification: `npm.cmd test` passed 192 tests with 0 failures and 2 expected native skips; IDE analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Diagnostic range/order hardening (2026-09-24): project diagnostics now resolve referenced `.tds`/`.txt` targets back to source locations, and include resolution failures use the project-error contract. Added direct regression coverage for missing goto/include positions.
- Verification: `npm.cmd test` passed 192 tests with 0 failures and 2 expected native skips; IDE analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Whole-project build diagnostic contract (2026-09-24): added an API-level temporary-project regression covering multiple errors across scenes, deterministic file ordering, source lines, and duplicate elimination. The existing project-build path now has direct evidence beyond successful builds.
- Verification: `npm.cmd test` passed 192 tests with 0 failures and 2 expected native skips; IDE analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Whole-project diagnostic ordering is now covered through the real editor server: multiple errors across `chapter/next.tds` and `main.tds` preserve deterministic scene-file order, line positions, and uniqueness. Independent analyzer errors currently short-circuit package validation; this remains an explicit follow-up candidate for aggregating independent asset failures without duplicate type errors.
- Independent diagnostic aggregation (2026-09-24): editor validation now preflights source asset references before the compiler short-circuit, so an asset failure remains visible alongside an unrelated type error. Diagnostics are merged in source order without running the compiler twice or duplicating the type error.
- Verification: `npm.cmd test` passed 193 tests with 0 failures and 2 expected native skips; IDE analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Diagnostic aggregation hardening (2026-09-24): source asset preflight now preserves independent missing-asset errors when type analysis also fails, merging them by source position without invoking package compilation for an already invalid type graph.
- Verification: `npm.cmd test` passed 193 tests with 0 failures and 2 expected native skips; IDE analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Unified diagnostic ranges (2026-09-24): AST locations and Analyzer diagnostics now carry `endColumn` in addition to `endLine`; parser propagates closing-brace columns through character, function, scene, if, for, while, and choice ranges. Existing line-based IDE rendering remains compatible.
- Verification: `npm.cmd test` passed 194 tests with 0 failures and 2 expected native skips; IDE analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Character slot conflict analysis (2026-09-24): added conservative static `character-slot-conflict` warnings for statically known different characters shown at the same position. Same-character pose changes and explicit `hide`-then-show sequences remain valid; branch, choice, and loop paths are analyzed independently without turning the warning into a compile error.
- IDE contract coverage (2026-09-24): the real editor server `/api/validate` now has a regression proving the placement warning is emitted with a successful validation result. Direct analyzer tests cover source locations and path behavior.
- Verification: `npm.cmd test` passed 196 tests with 0 failures and 2 expected native skips; Browser, Native SDL smoke, and full-workflow E2E passed. The parallel editor E2E had one existing tab-timing miss on its first run; the standalone rerun passed.
- Variable-table value-set IDE contract (2026-09-24): extended the real editor-server regression to cover integer `min/max`, string `possibleValues`, constant-condition narrowing for an impossible string literal, and out-of-range assignment errors through `/api/validate`.
- Verification: `npm.cmd test` passed 194 tests with 0 failures and 2 expected native skips; editor-analysis, Browser, Native SDL smoke, and full-workflow E2E all passed. Remaining coverage is focused on richer variable-table schemas, branch merge edge cases, and visual IDE interaction under a live editor session.
- Diagnostic range completion (2026-09-24): project asset/goto/include diagnostics now expose `endColumn`, and whole-project deduplication includes both line and column endpoints so distinct ranges cannot collapse accidentally.
- Verification: `npm.cmd test` passed 194 tests with 0 failures and 2 expected native skips; IDE analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Syntax diagnostic ranges (2026-09-24): parser-token syntax errors now expose an exclusive `endColumn`; unterminated-line errors use the source line end. This aligns parser diagnostics with project and analyzer range fields.
- Verification: `npm.cmd test` passed 194 tests with 0 failures and 2 expected native skips; IDE analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
- Variable-table IDE contract (2026-09-24): the real editor server now has regression coverage proving `.novel/variables.json` `min/max` constraints reach `/api/validate` and produce the same constant-condition diagnostic semantics as package analysis.
- Verification: `npm.cmd test` passed 194 tests with 0 failures and 2 expected native skips; IDE analysis, Browser, Native SDL smoke, and full-workflow E2E all passed.
# Optimistic scene revision checks (2026-09-24): scene reads now expose a SHA-256 content revision, and IDE saves/project formatting send the revision they loaded. The server rejects stale writes with `SCENE_CONFLICT`, preventing an external edit from being silently overwritten. Rollback first re-reads and only restores content that still equals the formatter output, so recovery cannot undo an unrelated concurrent edit. API regression covers the stale-write rejection; all five cross-layer checks pass.

# Shared Lexer/CST formatter (2026-09-24): moved the active formatter into `shared/formatter.js`, with a tolerant lexer and brace CST stack that preserve incomplete editor input while distinguishing block braces from dictionary literals. The browser loads this module directly, while `tools/format.js` and its `npm run format` entry point require the same implementation. Formatter contract tests now check idempotence, line-ending/BOM normalization, parsed compiler structure, string/comment boundaries, CLI reuse, and 221 total unit tests pass.
# Formatter scale benchmark (2026-09-24): added `npm run benchmark:formatter`; a 14,000-line / 360,741-byte corpus completed with p50 21.16 ms and p95 25.59 ms in the current Windows environment, with an idempotence assertion before timing samples. This is a baseline, not a cross-machine performance guarantee.

# Variable reference and definition assistance (2026-09-25)
- Right-click resolution now uses the exact active-source compiler binding and source range instead of the first project-wide same-name variable. Static `.novel/variables.json` integer bounds and finite allowed values are shown only for their actual global binding.
- Compiler metadata now points at identifier tokens for declarations, loop variables, function parameters, and interpolations, including escaped characters; navigation selects the symbol. Wrapped Japanese lines are covered by a browser interaction regression.
- Verification: `npm.cmd test` passed 237 tests with 0 failures and 2 expected native skips; `node test/editor-analysis-check.cjs` passed twice, including on the final tree; `node test/full-workflow-e2e.cjs` passed project creation/open/switch, edit, save, compile, player, and server-restart flows. `node --check` passed for the editor and browser test, and `git diff --check` reported no whitespace errors.

# IDE構文ヘルプ刷新 (2026-09-24): ヘルプメニューをUTF-8の日本語クイックリファレンスへ更新し、シーン、素材、変数、分岐、choice、演出、ショートカット、診断対応を実例中心で表示するようにした。詳細な [tds-language-and-editor-guide.md](docs/tds-language-and-editor-guide.md) へのリンクもIDEから開ける。Editor E2Eで見出し、8セクション以上、初期展開、文書URLを検証し、全5系統が通過。

# Struct前方参照 (2026-09-24): Parserがファイル全体のトップレベルstruct名を字句走査で先に収集し、宣言より前に現れるstruct型変数・関数型を正しく解析できるようにした。文字列やブロック内のstruct語は誤収集せず、Parser/Checker回帰を追加。Unit 222件中220成功、2件は想定スキップ、Editor/Browser/Native/Workflowも通過。

