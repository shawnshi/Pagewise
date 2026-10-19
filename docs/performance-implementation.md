# Pagewise performance implementation status

Parent acceptance: **LOCAL_REVIEWED_SLICE_INTEGRATED**. The corrected delivered slice passed independent review and has been integrated into the main working directory with the pre-existing dirty work preserved. This is **not five-stage completion or physical-device performance acceptance**. Subsequent 1.1.0 installation/startup acceptance is recorded at the end of this document.

## Baseline and scope

Original goal: 根据分析建议分步完成5个阶段修改，根据需要使用多个subagen.

The baseline is `baa1d761981dbb0e3e58287a262b9b5db46f866f` **plus the original dirty files**, frozen locally in `.cache/performance-20261019/baseline/` and `baseline.json`. Comparing with HEAD alone incorrectly includes existing user work. The local recovery checkpoint is `.cache/performance-20261019/recovery-1/checkpoint.json`.

The review packet, exact task-only patch, final raw-byte snapshots, endpoint hashes, preservation checks, and validation receipts are under the integration worktree’s `.cache/performance-20261019/`. `review-packet.json` is the review entry point. Original receipts and failed measurements remain unchanged.

## Five-stage status

| Stage | Delivered and locally validated | Remaining acceptance |
|---|---|---|
| 0: baseline | Dirty-source snapshot, actual browser readiness oracles, deterministic synthetic fixtures, default and explicit eink profiles | Old-APK/original-dirty-baseline equivalence remains unproven; hash-bound 1.1.0 installation is a separate follow-up, not a retroactive baseline |
| 1: native, folder, library | Sealed native serial-owner/durability changes and Kotlin/JVM receipts; independently reconstructed folder binary patch and source-bound Node/Kotlin/JVM receipts; cached library normalization and session order; committed-route reader activity pauses deferred scans | Android TTS/media/SAF behavior and provider cancellation on the physical device are not accepted by host tests |
| 2: PDF | Production-built raster Worker, revision cancellation, bounded scheduling/resource budgets, geometry/search contracts, actual reader browser tests | **PERF-01 is partial**: main-thread PDFium open, interaction, and text work remain; cold/open costs and real scanned-PDF/image quality remain unresolved |
| 3: text and reader | TXT metadata avoids ZIP conversion; large text conversion uses a bounded Worker with explicit failure/cancellation; byte-equivalent EPUB payloads; layout/font/anchor witness avoids only redundant readiness waits; synthetic BOOX detection; nonanimated turn readiness and close/replacement ownership | Worker conversion trades additional elapsed time for UI responsiveness; real-device book-open/frame readiness and model/UA behavior are not accepted by basic Activity startup checks; no SDK or new speech-hash cache added |
| 4: regression and review | Original 122 scoped tests/paginator/six-run receipts retained; three review findings fixed and independently re-reviewed with PASS; 42 reviewed files integrated; parent reran 37 unit/contracts, four actual PDF Worker/browser cases, TypeScript and built EPUB/TXT/PDF eink-profile smoke successfully | Candidate installation/startup is now verified below; Android page-turn distributions, physical-panel latency/clarity/ghosting and representative real-book acceptance remain open; stage 2 PDF work is not closed |

## Recovery changes

Folder import used only the sealed candidate, not live lane files. The importer checked original frozen baselines, all artifact hashes and passing validation bindings, applied the byte-preserving binary patch into an independent directory, compared every reconstructed endpoint, and copied exact candidate bytes. Receipt: `finish-folder-import-receipt.json`.

App is the single reader-activity owner. The committed route epoch covers EPUB/TXT/PDF entry, restored routes, cancelled exits, reader replacement, stale reader failure, failed opening, exit, and disposal. Readers report failure only for their captured epoch. Folder scheduling remains responsible for coalescing and preserving confirmed writes.

The reproduced nonanimated paginator defect dropped the second action after the first committed turn because a fixed 100 ms lock tail remained active. Lock release now follows awaited scroll/section readiness in `finally`. A navigation epoch prevents late close/replacement work from navigating, publishing loaded content, moving the new session, or unlocking a newer turn. View destruction removes its pending iframe load listener, settles the owner, disconnects observers, and suppresses late expansion. Selection/direction behavior and the `VAL-LIFECYCLE-001` style callback guard are retained. Inputs while a genuinely in-flight turn is locked retain the existing no-queue policy.

## Review-0 corrections

All three findings were reproduced before production edits, with red receipts retained as `review-fixes-unit-red` and `review-fixes-browser-red`. Only `PdfReaderView.vue`, `libraryQuery.ts`, their regressions and this status document changed in this round. Accepted lane endpoints outside these two production files, the original checkpoint, sealed patches and receipts remain intact.

- **PERF-REVIEW-001:** a genuinely prefetched scroll page 3 lost its pin on becoming visible and was removed/zeroed by subsequent raster pressure. Viewport visibility now refreshes pins and LRU recency for all intersecting page groups before either the already-rendered fast path or neighbor prefetch. The real browser regression changes from `pinned=false, visibleSurvivedPressure=false` to both `true`, within the unchanged 96 MiB budget.
- **PERF-REVIEW-002:** three occurrences on a 350,000-character page rebuilt oversized geometry three times. A lazily held invocation-local model now serves all accepted occurrences; no-match pages still extract no geometry, and the global 8 MiB LRU admission/budget is unchanged. The regression observes one extraction, not three.
- **PERF-REVIEW-003:** normalized-empty format/language/status Sets now impose no filter; supplied whitespace scalar facets still select normalized-empty metadata as the frozen implementation did. Regressions cover absent, empty, whitespace and full-width whitespace inputs.

Affected checks: `review-fixes-unit-green` (37/37), `review-fixes-browser-green` (4/4, including production-built Worker pixels/geometry, paged and scroll pressure, rapid navigation/search/close, and explicit Worker failure), `review-fixes-types`, and `review-fixes-smoke` all exit 0. Tests write new browser/build reports under `review-fixes/`, not over accepted artifacts. `review-fixes-default-pdf` and `review-fixes-eink-pdf` each complete 100 turns against the freshly built source with no page errors. Exact commands, environment, log hashes, source endpoints and task-only reconstructed patch are in the refreshed review packet.

LSP could not fully confirm this round: the Vue file exceeds its 5,000-line limit, three paths were push-only/inconclusive, and an existing browser-test URL callback generated an auxiliary unchecked-call finding. Physical `vue-tsc`, Node and real browser checks above are the type/runtime evidence; no clean LSP result is claimed.

## Actual local validation (original checkpoint receipts)

Commands below ran from the integration workspace with per-call timeouts at most 180 seconds; the gate wrapper caps its child at 170 seconds. Full command arrays, exit codes, elapsed times, and physical logs are in `finish-*-receipt.json`.

- `node node_modules/vue-tsc/bin/vue-tsc.js -b`: exit 0 (`finish-types`). TypeScript output stays in the worktree’s `.cache/typescript`.
- `node --test scripts/test-paginator-turn.mjs`: original source failed all three regression assertions; final source passes (`finish-turn-red-fixed`, `finish-turn-green`, and final `finish-contracts-fixed`). The initial test fixture deadlocked and was corrected; it is not a production failure or a passing run.
- `node --test scripts/test-paginator-lifecycle-browser.mjs`: exit 0 (`finish-paginator-browser-fixed`). Actual iframe rendering: 100 committed rapid turns, reverse turn, selection, delayed section replacement, pending iframe close settlement, animated close, and zero page errors. The first fixture cancelled before its deferred loader started; that fixture failure is retained.
- `node --experimental-strip-types --test --test-concurrency=1 ...`: exit 0, 122/122 (`finish-contracts-fixed`). Exact script list is in its receipt. Covers folder/storage, route activity, text Worker, PDF unit/lifecycle/production-built Worker, reading modes, typography, and negative performance oracles.
- The first integrated contract invocation failed because the PDF baseline fixture was not at the test’s default path. The successful invocation explicitly supplied `PDF_BASELINE_VIEW=<project>/.cache/performance-20261019/baseline/reader/src/views/PdfReaderView.vue`. No production fix or weakened assertion was used; the failed receipt is retained.
- `node --experimental-strip-types scripts/perf-five-stage.mjs --quick --profile default --port 4411 --report .cache/performance-20261019/finish-smoke.json`: exit 0, actual integrated production build plus EPUB/TXT/PDF smoke.
- Six separate invocations of the same runner with `--skip-build --samples 100 --format epub|txt|pdf --profile default|eink --port 4411 --report .cache/performance-20261019/finish-{profile}-{format}.json`: all exit 0. Stale build rejection remains enabled and all six source manifests match.

Accepted untouched native/library evidence was reused, not redeveloped. Folder sealed receipts include physical Kotlin compile and JVM scheduler tests. Native `parent-native-acceptance.json` and integration `stage1-native`, `native-compile`, and `native-host-fixed` receipts remain available. Compilation and host fault injection are not physical Android acceptance.

## Measurements and limits

The six-run table below is retained **pre-review-fix checkpoint evidence**, not a claim that every old source-manifest hash still matches the corrected candidate. EPUB/TXT production endpoints and their accepted contracts were not edited; the fresh integrated smoke covers those formats. Only affected PDF full sampling was repeated. Fresh corrected-candidate PDF page-turn p50/p95/p99 are **59.4/63.1/63.4 ms** (default) and **59.2/62.8/63.9 ms** (explicit eink), 100 samples each. Open medians are 335.4/217.6 ms cold/warm (default) and 454.8/286.5 ms (eink), three opens each: exploratory only, not evidence that the prior warm-open regression is resolved. Raw current-source reports and long tasks are `review-fixes/default-pdf.json` and `review-fixes/eink-pdf.json`; the packet distinguishes these from historical reports. No panel/device or universal speedup claim is made.

Synthetic Windows Edge 156.0.4314.30, Node v25.9.0, Ryzen AI 9 H 365, viewport 992 × 1323, DPR 1.875, CPU throttle 1. Fresh isolated contexts, strict loopback port, blocked external HTTP, and generated EPUB/TXT/PDF only. The six original checkpoint reports have identical fixture hashes, source binding `529e2bee40a3797838990e93c3b2f2d0a29d25d869e8d5b7b78beb94068282d9`, and empty page-error arrays. Readiness is committed position/content/bitmap plus two browser frames, **not panel scanout**.

Event-to-readiness milliseconds, nearest-rank percentiles, 100 samples per listed operation:

| Profile | Format / operation | p50 | p95 | p99 |
|---|---|---:|---:|---:|
| default | EPUB same section | 343.7 | 360.3 | 361.2 |
| default | EPUB chapter | 152.4 | 181.8 | 195.5 |
| default | TXT same section | 344.0 | 360.5 | 363.0 |
| default | TXT chapter | 93.5 | 109.2 | 111.6 |
| default | PDF page | 58.7 | 65.3 | 70.7 |
| eink | EPUB same section | 27.8 | 43.6 | 44.0 |
| eink | EPUB chapter | 118.0 | 142.2 | 152.6 |
| eink | TXT same section | 40.5 | 44.4 | 46.4 |
| eink | TXT chapter | 105.1 | 110.7 | 123.6 |
| eink | PDF page | 58.5 | 64.6 | 71.7 |

Default EPUB/TXT turns intentionally include the configured animation. They are not a nonanimated BOOX compute baseline. No preference is silently forced. Original baseline-eink EPUB/TXT runs failed after an incomplete action: they have **no valid full percentile distribution or speedup ratio**. The retained baseline-eink PDF run passed. The recovery closes the failed-action condition, not a claimed percentage improvement.

Default integrated PDF cold/warm open medians are 417.2/286.2 ms, versus the earlier default validation baseline’s 349.1/95.2 ms. These are only three opens per mode and host scheduling is uncontrolled; the observed warm-open regression is not dismissed. PDF Worker responsiveness does not prove lower CPU cost or faster cold opening. The final text Worker comparison likewise measured 49.6 ms baseline versus 132.9 ms Worker elapsed for 3.35 MB, with 36 UI heartbeat ticks and identical generated EPUB contents.

Raw reports retain every action, open observation, and long-task entry. Final-document long-task counts were default EPUB/TXT/PDF 95/4/0 and eink 5/1/0; maximum observed durations across retained observations were 324/125/0 ms and 220/76/0 ms, respectively. Document clocks reset on reload: these counts are not whole-session totals, and zero observed PDF entries does not establish zero main-thread work.

Device reference remains NoteX3Pro, 1860 × 2480, 300 dpi, Android 12/API 32, WebView 146.0.7680.178. At the child-recovery checkpoint, the installed old APK was not proven equivalent to this source. That child performed no signing, installation, device UI/private-data operations, dependency changes, staging, commit, push or deployment. Subsequent parent integration and 1.1.0 installation are separate checkpoints, recorded below. The child recovery itself did not promote code; subsequent parent integration is recorded below. Physical-device acceptance remains open.

## Parent integration and acceptance

- Independent corrected-slice review: `.cache/performance-20261019/recovery-1/review-1.md`, **VERDICT: PASS**; this approves inspected local code, not physical performance or installation.
- Parent verified the final review packet, exact patch, all 42 sealed/live candidate hashes, every target's original dirty baseline, unchanged out-of-scope source and unchanged Git index before/after exact patch application. Backups and raw-byte promotion receipt: `.cache/performance-20261019/parent-promotion/`.
- Post-promotion unit invocation initially failed to locate the frozen baseline because the new benchmark used a worktree-depth-specific relative import. `test-library-performance.mjs` now resolves the common Git directory or explicit `PAGEWISE_PERF_BASELINE`; no production implementation changed. The original failed log is retained. Corrected main-worktree run: **37/37 passed**, no skips (`unit-fixed.log`).
- Parent main-worktree TypeScript check: exit **0** (`types.log`). Actual production Worker/browser cases: **4/4 passed** (`worker-browser.log`), including deliberately unsupported Worker behavior. Those intentional error logs are not unexpected runtime failures.
- Fresh main-worktree production build and quick EPUB/TXT/PDF smoke with explicit `eink` profile: **PASSED**, no page errors (`smoke-eink.json/log`). Five actions per operation and one open per kind are smoke coverage only, not new reliable tail-performance measurements. No fixed timing subtraction or physical-panel claim.
- Parent follow-up edits are limited to benchmark baseline-path portability and this factual status update; all reviewed production endpoints remain unchanged. The local integrated slice is accepted. Stage 2 remaining engine/open costs and stage 4 physical Android/e-ink acceptance still prevent five-stage DONE.

## 1.1.0 installation follow-up — 2026-10-19

Release `io.pagewise.reader` and independent Debug `io.pagewise.reader.debug`, both 1.1.0 / 1001000, were subsequently built, verified and installed. Release retained its existing certificate, UID, first-install timestamp and data-directory inode; no uninstall, data clear or real-book export/copy occurred. Staged Gradle tasks all completed successfully with hash-bound Rust inputs; temporary generated signing configuration and JNI links were restored.

Both builds completed actual Activity startup and native/frontend numeric probe handshakes. The per-launch probe was explicitly disabled after checking; no reading UI or real-book content was inspected. These checks do not establish book-open/page-turn distributions, long-running SAF/TTS behavior or physical-panel performance. Current APK identities and remaining acceptance are in [the 1.1.0 deployment record](deployment-1.1-status.md). Local logs, frozen dirty baselines and APKs are intentionally excluded from the source repository.
