# kyuby.com

This is the public distribution mirror of the private kyuby.com project. It contains curated website and browser-only Eva source, not the private development history, internal documentation, tests, or credentials.

## Build

Use Node.js 22.x (`.nvmrc` pins the major, not a patch):

```sh
npm ci
npm run check
npm run build
npm run deploy:dry-run
```

The production service-worker integration is included because it is required by the Astro build. Model files are hosted separately and are not distributed in this repository.

## Releases

Snapshots sync directly to public `main` from clean private `main`, after matching freshly fetched `origin/main` and verifying successful private CI run, check-suite, and `gates` results for that exact commit. Private PRs and branch protection are not export prerequisites under the 2026-09-16 trunk-based owner decision. The full unit and browser suites also run in the local DevPod before export, without duplicate host validation. There is no second public pull request or merge. The public `gates` job validates installation, static checks, build, and deployment dry-run; it does not claim to run the private tests. Preview URLs are reported in the Actions job summary. Production requires a separate manual workflow dispatch and environment approval.

Changes should be proposed to the maintainers for inclusion upstream. Public snapshot history is independent of private history. Metadata identifies the vetted upstream commit and its source tree; only allowlisted files are distributed, never private Git history or uncommitted changes.
