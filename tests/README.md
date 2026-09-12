# Tests

Deterministic, dependency-free tests for `index.html`.

```sh
node --test 'tests/*.test.js'      # requires Node 18+; CI runs Node 22
```

## How it works

The app is a single `index.html` with no build step, so there is nothing to
import. `harness.js` reads the file, slices out the `<script>` block, and
evaluates it in a `node:vm` context against a minimal DOM and `localStorage`
stub. **Tests therefore exercise the shipped code, not a copy of it.**

Two details worth knowing before adding tests:

- **Page-boot side effects are not executed.** The harness stops at the `INIT`
  banner, then appends the handful of function declarations that appear below
  it (so callers like `loadActiveDate()` resolve). Without this, every test
  would start from whatever state boot happened to leave behind.

- **Module state is lexical, not global.** `dhikrItems`, `habits` and friends
  are declared with `let`, so they are *not* properties of the sandbox object.
  Assigning `app.habits = [...]` silently does nothing and leaves the renderer
  with empty input — a test written that way passes without proving anything.
  Drive state through the app's own functions instead (`app._addDhikrItem(…)`,
  `app.addHabit()`), and assert that rendered output is non-empty.

Values built inside the VM carry that realm's prototypes, so
`assert.deepStrictEqual` rejects them against host-realm literals. Wrap them in
`plain()` from the harness.

## Files

| File | Covers |
| --- | --- |
| `storage.test.js` | C-4 — a failed write is never reported as a save; corrupt history is quarantined |
| `escaping.test.js` | H-5 — user-supplied names cannot reach `innerHTML` as markup |
| `backup.test.js` | H-1 — every data store is exported; imports are validated and merge safely |
| `invariants.test.js` | Structural guards against reintroducing the above |

Findings are numbered as in the Phase 0 audit report.
