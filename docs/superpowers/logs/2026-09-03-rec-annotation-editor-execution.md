# SDD ledger — plan: docs/superpowers/plans/2026-09-03-rec-annotation-editor.md

Merge base: `b76c380`
Branch: `feature/rec-annotation-editor`
Worktree: `/mnt/data4T-Path/wangsen/drone/rec-annotation-editor/.worktrees/rec-editor-implementation`
Spec: `docs/superpowers/specs/2026-09-03-rec-annotation-editor-design.md`

## Pre-flight task self-consistency scan

| Task | Tests vs implementation | Files vs later use | Finding |
|---|---|---|---|
| 1 | Shell test names match minimal App controls; RED precedes App implementation | Creates build/test foundation consumed by all tasks | Ruling: `.gitignore` already exists from worktree setup, so Task 1 must modify it and preserve `.worktrees/` and `.superpowers/` while adding planned entries — losing them could expose worktree/ledger contents to Git. |
| 2 | Parser/serializer tests match arbitrary-label and atomic-import rules | Produces types/parser/serializer used by Tasks 3–11 | Clean; pure label `0` remains valid and trailing `0` ambiguity follows spec. |
| 3 | Geometry tests exercise clamp, move, eight handle axes, fit and invertibility | Produces bbox/coordinate functions for Tasks 5–8 | Clean; move argument is a delta and viewport state never enters bbox state. |
| 4 | Reducer tests cover transactions, dirty state, redo clearing and monotonic IDs | Context/reducer consumed by Tasks 5–10 | Clean; nextAnnotationNumber is intentionally outside undo snapshots so IDs are not reused. |
| 5 | File tests cover partition/decode and App tests cover atomic imports | Creates shell and file helpers modified later | Clean; image-after-label rejection and image-before-label clamping are distinct, specified paths. |
| 6 | Viewport tests assert original SVG coordinates and cursor-anchored zoom | Viewport handle and transform behavior consumed by Tasks 7, 8 and 11 | Clean; test-only transform attributes expose state but do not bypass transforms. |
| 7 | Pointer tests use inverse transformed coordinates; dialog rules are explicit | Extends Viewport/App used by Tasks 8–11 | Clean; one pointer state machine and reducer transaction align. |
| 8 | Card tests cover immediate label preview, validation and numeric atomic update | Panel/card behavior used by Tasks 9–11 | Clean; identity and lookup remain ID-based. |
| 9 | Save tests cover picker, fallback and cancellation; shortcut test verifies behavior | File APIs/toolbar/App used by Tasks 10–11 | Clean; retained handle exists only for picker path and fallback remains local download. |
| 10 | Accessibility/clamp/stress tests align with visual and performance implementation | Fixtures and semantic selectors feed Task 11 | Clean; fixture contains exactly 24 lines and first two are duplicate `person` labels. |
| 11 | E2E flow covers the complete spec and startup script isolation | Final task consumes all earlier interfaces | Clean; project-local browser/cache paths and start command match user constraint. |

## Pre-flight shared-file and interface scan

| Tasks | Producer → consumer / shared surface | Finding |
|---|---|---|
| 1 → 5 | `App`, `App.test`, React/Vitest foundation → shell/file loading | Clean; Task 5 intentionally replaces the minimal shell. |
| 1 → 10 | `styles.css`, `App` → visual system | Clean; Task 10 refines, not duplicates, base styling. |
| 1 → 11 | package scripts/config and `.gitignore` → E2E/startup | Clean subject to Task 1 `.gitignore` ruling above; Task 11 must preserve all ignore entries. |
| 2 → 3 | `BBox`, `ImageBounds` → bbox/coordinate domain | Clean; exact type names agree. |
| 2 → 5 | parser/types → atomic file import | Clean; App rejects any non-empty issues array. |
| 2 → 9 | serializers → Save/Save As/Export | Clean; TXT always normalizes a trailing `0`, JSON preserves IDs. |
| 2 → 10 | parser and IDs → 500-box stress test | Clean; labels with numeric words remain arbitrary strings before reserved zero. |
| 2 → 11 | output formats → browser download assertions | Clean; file names and metadata align. |
| 3 → 5 | clamp helpers → import boundary handling | Clean; invalid-after-clamp is rejected atomically. |
| 3 → 6 | coordinate transforms → Viewport fit/zoom/pan | Clean; formulas and type names agree. |
| 3 → 7 | bbox move/resize/draw helpers → pointer state machine | Clean; all mutations return image-space bboxes. |
| 3 → 8 | bbox clamp/validation → numeric fields | Clean; inputs commit through one helper path. |
| 4 → 5 | `EditorProvider`, state/actions → App shell/import | Clean; App owns exactly one provider. |
| 4 → 7 | transaction actions and monotonic counter → canvas edits/new IDs | Clean; interaction preview and commit names match union. |
| 4 → 8 | transaction/atomic update actions → text/numeric edit | Clean; text uses preview transaction, numeric uses atomic update. |
| 4 → 9 | Undo/Redo/dirty/mark-saved → shortcuts/save | Clean; selection and viewport remain non-historic. |
| 4 → 10 | editor state → status/accessibility/stress rendering | Clean; derived values do not create second state. |
| 5 → 6 | App/Toolbar/StatusBar → Viewport integration | Clean; Task 6 extends named controls and status props. |
| 5 → 8 | temporary rows/App sidebar → AnnotationPanel | Clean; Task 8 explicitly replaces temporary rows. |
| 5 → 9 | `fileIO`, App, Toolbar → progressive save/open | Clean; picker and hidden-input branches converge on the same reader/parser. |
| 5 → 10 | App/components/error shell → polish/error boundary | Clean; Task 10 adds semantics without changing file rules. |
| 6 → 7 | Viewport and Toolbar → editing interactions/mode | Clean; private AnnotationBox is deliberately extended in the same file. |
| 6 → 8 | `ViewportHandle.centerAnnotation` → panel locate | Clean; selection and camera movement stay separate. |
| 6 → 10 | viewport/component markup → visual styles | Clean; non-scaling stroke and handle scale remain mandatory. |
| 6 → 11 | SVG selectors/transform state → E2E | Clean; Task 11 may add attributes but cannot bypass coordinates. |
| 7 → 8 | App selection and draft flows → panel field editing | Clean; both dispatch the same reducer actions. |
| 7 → 9 | Escape/Delete interaction state → global shortcuts | Clean; editable-target guard prevents field deletion. |
| 7 → 10 | dialog/handles/modes → accessibility and styling | Clean; semantic names required by E2E are compatible. |
| 7 → 11 | bbox/handle/draw controls → pointer E2E | Clean; tests derive screen geometry from rendered elements. |
| 8 → 9 | AnnotationPanel/App → Delete and save state | Clean; deletion is undoable and no confirmation is required. |
| 8 → 10 | cards/panel → responsive and selected styles | Clean; 380 px desktop panel and narrow drawer are additive. |
| 8 → 11 | card labels/IDs/inputs → E2E locators | Clean; `data-annotation-id` and accessible field names agree. |
| 9 → 10 | notices/error handling → polished feedback | Clean; Task 10 centralizes visual treatment only. |
| 9 → 11 | save/export APIs and package → browser download tests | Clean; direct picker is progressive, download is deterministic test path. |
| 10 → 11 | 24-line fixtures/semantic UI → final E2E | Clean; dimensions, IDs and expected count agree. |

Pre-flight complete: one setup-induced plan conflict ruled above; no unresolved or load-bearing conflicts.

Ruling: the available subagent API does not expose a model-selection parameter, so dispatches identify the intended tier in their brief but run on the platform-selected model — explicit cost-tier enforcement is impossible in this harness — if wrong, execution may cost more than the skill's preferred routing but correctness and review gates are unchanged.

Task 1: Ruling: the plan-mandated Vite 6.3.5, Vitest 3.1.3, and Playwright 1.52.0 versions conflict with the design's requirement for a dependable runnable tool because npm audit identifies reachable high/critical development-tool vulnerabilities — upgrade to Vite 6.4.3, Vitest 3.2.7, and `@playwright/test` 1.62.1, regenerate the lockfile without `--force`, and retain all other Task 1 constraints — if wrong, a minor-version compatibility regression may require reverting or adapting configuration, while retaining old versions would expose local files or browser provisioning.

Task 1: fix round 1/5 (3 addressed, 0 open — upgraded vulnerable Vite, Vitest, and Playwright toolchain; commits 3967d82..1249bc5)
Task 1: complete (commits b76c380..1249bc5, review clean)

Task 2: minor (deferred): parser tests do not yet lock CRLF plus blank-line numbering, finite overflow via `1e309`, or repeated internal whitespace preservation; final review must triage.
Task 2: minor (deferred): serializer tests do not yet assert every JSON field/null shape, integer padding, or pure-label-`0` round-trip; final review must triage.
Task 2: Ruling: the plan's literal `Number.toFixed(2)` snippet conflicts with the design's unconditional two-decimal TXT contract because accepted finite coordinates at magnitude `>= 1e21` serialize in exponent notation — replace it with a deterministic exponent-expanding fixed formatter and add the `1e21` boundary test; also mix a valid line into the atomic-failure test — if wrong, the formatter may need extra extreme-number work, while keeping `toFixed` would emit format-incompatible TXT.

Task 2: fix round 1/5 (2 addressed, 0 open — fixed large-coordinate TXT formatting and atomic mixed-line regression; commits 88c34da..4c92dd8)
Task 2: complete (commits 1249bc5..4c92dd8, review clean; 2 deferred minors retained for final review)

Task 3: Important: `resizeAxis` assumes the starting bbox already spans at least 1 px; accepted positive subpixel boxes at an image edge can therefore resize out of bounds or remain below the required 1 px minimum.
Task 3: Ruling: preserve the plan's normal fixed-side resize behavior for boxes already at least 1 px, but treat an accepted subpixel starting axis as a broken interaction invariant that `resizeBBox` must repair deterministically inside image bounds before applying the named handle — an unnamed subpixel axis may be expanded only as the unavoidable invariant repair; add both-edge, both-axis, all-eight-handle regressions — if wrong, subpixel imports would require rejection or normalization in later import/numeric-edit tasks instead, but leaving the helper unchanged can persist negative coordinates during a valid edit.
Task 3: fix round 1/5 (1 addressed, 0 open — repaired accepted subpixel axes within bounds for all eight resize handles; commits 5083035..691ef58)
Task 3: complete (commits 4c92dd8..691ef58, review clean)

Task 4: minor (deferred): unchanged or missing-ID atomic actions currently create a no-op history entry and clear redo; later UI integration must avoid these dispatches or final review should add a fingerprint no-op guard.
Task 4: minor (deferred): unrelated atomic/history actions during an active preview transaction can discard its original base; Tasks 7–9 must define and test an explicit commit/cancel/ignore policy before global shortcuts are wired.
Task 4: minor (deferred): undo/redo can retain a `selectedId` absent from the restored annotations; later consumers must tolerate it or reducer history restoration should clear dangling selection.
Task 4: complete (commits 691ef58..8da3157, approved with 3 deferred minors)

Task 4: reopened: the interrupted original reviewer returned after the replacement review and independently classified the same three findings as Important. Controller ruling: accept the stricter severity because active preview + global Undo is explicitly reachable in Task 9, undoing a newly selected add is explicitly reachable in Tasks 7/9, and a subsequent missing-ID delete can destroy the only redo entry; the prior completion line is superseded pending a fix round — if wrong, the reducer gains defensive semantics beyond the narrow Task 4 happy path, but leaving it unchanged risks corrupting normal planned UI history.
Task 4: Ruling: resolve an active changed transaction before an interleaved atomic/history action rather than snapshotting its preview as the prior atomic state; true atomic no-ops must preserve history/future despite the plan's shorthand “every atomic edit pushes” because an unchanged fingerprint is not an edit; undo/redo must clear only selections absent from the restored annotation snapshot. Preserve all existing normal-flow behavior and add explicit transition regressions.
Task 4: fix round 1/5 (3 addressed, 0 open — resolve-then-action transaction policy, valid restored selection, and atomic no-op guards; commits a209dca..9028718)
Task 4: complete (implementation commit 8da3157 plus fix commit 9028718; strict re-review clean; the three earlier deferred-minor entries are resolved and superseded)

Task 5: Important: overlapping async imports close over stale editor state, allowing older completions to overwrite newer choices or install annotations never clamped against the current image.
Task 5: Important: accepted and pending image object URLs are not fully reclaimed across concurrent replacement or component unmount.
Task 5: Important: image `onload` accepts non-finite/zero decoded dimensions and can place invalid bounds in editor state.
Task 5: minor: descendant `dragleave` can clear drop guidance while the pointer remains inside the workspace.
Task 5: Ruling: use a single global import generation with latest-started-request-wins semantics; every still-current completion reconciles its new file(s) with a latest-state ref, stale completions may update neither document nor notices/errors, and every stale/post-unmount successful image URL is revoked. Centralize accepted URL ownership in a ref with unmount cleanup. Extend the reducer with one atomic import action that applies the validated image plus optional annotation baseline in one transition, despite Task 4's originally closed action union — if wrong, an explicit serialized import queue may be preferable, but retaining two stale-state dispatch paths can violate the image/annotation invariant.
Task 5: fix round 1/5 (3 Important + 1 Minor addressed, 0 open — generation-gated atomic imports, centralized URL ownership, dimension validation, and drag-depth handling; commits 9028718..b113157)
Task 5: complete (implementation commit a209dca plus fix commit b113157; scoped re-review clean)

Task 6: complete (commit 53af981; focused 39/39, full 112/112, typecheck/build clean; task-scoped spec and quality review approved with 0 Critical, 0 Important, 0 Minor)

Task 7: Important: a pending draw dialog can survive an image/label import and later commit its old-image bbox against the new document.
Task 7: Important: dialog Escape handling is scoped to bubbling events inside the dialog, while the aria-modal shell does not actually make background controls inert.
Task 7: minor: resize/draw movement tracking is not sticky, so an away-and-back drag can leak the synthesized click.
Task 7: Ruling: any accepted image/label import request cancels the pending draft immediately, returns to Select mode, and clears any pending-center request; the mounted dialog owns a window Escape listener; movement suppression remains sticky for the lifetime of a gesture. Add focused regressions before fixes and preserve Task 5 latest-request/import URL behavior — if wrong, a true native modal with focus trapping could instead make import unreachable, but the current DOM does not provide that guarantee.
Task 7: fix round 1/5 (2 Important + 1 Minor addressed, 0 open — import cancels stale draft, window-level Escape, sticky movement suppression; commits ac0e361..555a1e4)
Task 7: complete (implementation ac0e361 plus fix 555a1e4; focused 92/92, full 148/148, typecheck/build clean; scoped re-review approved with no new breakage)

Task 8: Important: a focused expression editor and a canvas move/resize can share the reducer's singleton transaction, merging undo units or leaving the card's local editing flag stale.
Task 8: Important: live search filtering can unmount a focused card as its preview label stops matching, leaving its expression transaction open (including an invalid empty canonical preview).
Task 8: Ruling: before starting a canvas move or resize, synchronously blur the active HTML field so its React blur handler commits/cancels before `BEGIN_TRANSACTION`; verify real reducer action/history ordering in an integration harness. AnnotationPanel owns an actively-editing ID reported by cards and temporarily retains that exact card in source order until blur/Enter/Escape resolves, while the displayed match count continues to count only actual query matches — if wrong, transaction ownership would need promotion into a larger editor coordinator, but explicit browser focus resolution plus retained focused-card lifetime is the smallest sufficient cross-component contract.
Task 8: fix round 1/5 (2 original Important addressed, but 1 new Important open — broad active-HTMLElement blur commits a focused numeric draft, then the canvas gesture starts from the stale pre-commit bbox; commits 0bec312..63999a4)
Task 8: Ruling: mark only the Expression input as the owner of the reducer preview transaction and blur only that explicit owner before canvas move/resize. A focused numeric draft remains focused and local through the canvas transaction; nonfocused coordinates synchronize from the moving bbox, then the numeric draft commits separately on its eventual blur against the latest bbox — if wrong, numeric editing would require its own explicit coordinator, but broad blur violates the existing per-field draft preservation contract.
Task 8: fix round 2/5 (new Important addressed, 0 open — expression-only transaction-owner blur preserves numeric drafts; commits 63999a4..fdd8363)
Task 8: complete (implementation 0bec312 plus fixes 63999a4 and fdd8363; focused 102/102, full 178/178, typecheck/build clean; round-2 scoped re-review approved with no new breakage)

Task 9: implementation commit d4a0f3f (focused 93/93, full 222/222, typecheck/build clean)
Task 9: Important: concurrent saves to one retained handle can commit out of order (older snapshot may win on disk while UI reports saved).
Task 9: Important: an unblurred numeric-coordinate draft is invisible to dirty UI and beforeunload protection.
Task 9: Ruling: serialize writes per retained handle so the newest requested snapshot is always the last disk commit, and recover the queue after write/close failures; surface pending coordinate-draft IDs to effective dirty state with cleanup on commit, reset, import, and unmount — if wrong, a save-generation token per handle would be needed instead, but leaving the ordering gap risks silent data loss.
Task 9: fix round 1/5 (2 Important addressed, 0 open — per-handle write queue with failure recovery, effective-dirty coordinate drafts with lifecycle cleanup; commit 6ea4225; focused fileIO 27/27, full 242/242 on Windows Node 22, typecheck/build clean)
Task 9: residual minors carried into final review: export menu keyboard pattern, fallback-download explanation surfaced only after save, real-Chromium permission prompt verified manually via E2E run.
Task 9: complete (implementation d4a0f3f plus fix 6ea4225; independent reviewer was spawned but stalled, controller performed scoped re-review of the full fix diff and all new regressions)

Task 10: complete (commit 904c6a3; fixtures public/examples/rec-aerial-scene.{svg,txt} with 24 valid in-bounds lines; token stylesheet with fixed header/status, 380px scrolling panel, ≤900px drawer, reduced-motion; error boundary, polite live notices, focus-trapped error dialog restoring trigger focus; annotation ID/label exposed for automation; 500-box stress test; full 242/242, typecheck/build clean)
Task 10: notes: Add Box renamed to "Add box" per approved plan selectors; delete button accessible name "Delete annotation"; @types/node added as pinned dev dependency and tsconfig now covers tests/.

Task 11: complete (commit 09b6d29; playwright.config.ts with project-local webServer on 127.0.0.1:4173; Chromium E2E covers import → duplicate selection → toolbar/wheel zoom → Space pan → viewport resize without drift → pointer move/resize → draw dialog → delete/undo/redo → TXT/JSON export assertions; start.sh with lockfile-hash stamp and isolated npm cache; README with quick start, workflow, shortcuts, format ambiguity, tests, troubleshooting; verified dev server returns HTTP 200 on 0.0.0.0:5173; screenshots reviewed at 1440×900, 1024×768, and 800×700 drawer)
Task 11: notes: start.sh could not be executed on this Windows machine (no POSIX shell/WSL distro); its exec target (`npm run dev -- --host 0.0.0.0 --port 5173`) was verified end to end and the script is `bash -n`-clean logic mirroring the approved plan.
