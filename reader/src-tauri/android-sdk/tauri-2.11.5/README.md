# Tauri Android 2.11.5 lifecycle compatibility

This is a version-pinned, project-owned source overlay, not a dependency upgrade.
`prepare-tauri-lifecycle.mjs` verifies every upstream source hash before producing the generated module; it never writes the Cargo registry. `native-settings.gradle` keeps one `:tauri-android` module and points it at the generated copy. A distinct project-local build directory avoids reusing incremental output from the original source root.

Changes:

- Recreate Activity-bound plugin instances for a new Activity, retaining plugin names and configuration. Application-level stores/jobs retain their existing owners.
- Register each ActivityResult request under a fresh key. Same-kind concurrent requests are rejected, never substituted. Old/double results cannot claim a new slot.
- Abandon old window chooser requests explicitly; do not attach their results to a new window. Already accepted business writes are not cancelled or replayed.
- Settle each SDK response once. A response crossing an Activity epoch becomes `activity_changed_outcome_unknown`, not success or definite cancellation. The existing native-state client retains that exact mutation envelope and requires explicit receipt reconciliation, without replaying it into a new Activity; its pre-existing handling of other error codes is unchanged. SDK picker failure notification releases only the matching directory-plugin admission before rejecting; it never fabricates an Android cancellation result. Old event channels cannot send into a new Activity.
- Keep JNI and existing public method signatures, dependency versions, database schemas and application wire formats unchanged.

`upstream.json` pins the unmodified SDK sources and lists replacement/extra sources and the small owner accessor edit. Preserve the upstream Apache-2.0/MIT notices. Do not replace the pinned input with a newer SDK without a separate source/supply-chain review.

The pure Kotlin fence tests are not device or full lifecycle acceptance. Required native checks include font-scale recreation, management pages, a newly opened file chooser, an old chooser during recreation, retained data/anchors, and unresolved-write boundaries. No production-device installation, publication, account access or private books are authorized by this overlay.
