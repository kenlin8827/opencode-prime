# Review-tiering benchmark fixtures

These descriptors provide deterministic inputs for the routing table in `prompts/build.md`.
They model the diff stat and changed paths a dispatcher would obtain before invoking a reviewer.
They are intentionally not an automated review harness and do not claim to be real review runs.

| Fixture | Synthetic diff | Expected route | Required evidence |
|---|---:|---|---|
| `f1-docs` | 2 Markdown files, 38 lines | L0 | No reviewer dispatch |
| `f2-small-logic` | 2 files, 100 lines | L1 | `code-review-fast` |
| `f3-sensitive` | 2 files, 64 lines, `auth/` path | L3 | `code-review`; seed finding at `auth/login.js:5` |
| `f4-large` | 8 files, 800 lines, 3 modules | L2 | `code-review-fast`, split into file batches |

The large fixture materializes all eight payload files and 800 lines; the sensitive fixture
contains an executable seed test that fails on the intentional fallback-token bug. This
repository has no runtime dispatcher that executes reviewer agents, so run this manual smoke
before claiming end-to-end behavior: give each descriptor's changed paths and line count to
`@build`, record the first-line `Review tier:` marker and selected agent, and confirm f3 reports
`auth/login.js:5`. Record provider usage separately; the fixture files do not prove it.

The implementation plan labels f2 as L2 in §2, but its normative threshold in §1 and §7
routes two files and 100 lines to L1. This fixture follows the deterministic threshold.
