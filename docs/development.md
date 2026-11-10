**English** · [Українська](development.uk.md)

# Development

    git clone https://github.com/bambooplanedev/llm-harness-builder
    cd llm-harness-builder
    npm install

    npm test               # vitest, no model needed
    npm run typecheck      # tsc and vue-tsc
    npm run build          # dist/ and web/dist/
    npm run cli -- demo    # the CLI from source
    npm run dev:server     # serve from source, and in another terminal:
    npm run dev:web        # the page with hot reload

The CLI and the server are TypeScript in `src/`, the page is Vue 3 in `web/src/`, and the tests in
`tests/` run against fake backends. Issues and pull requests are welcome; a change to a knob should
come with a test, and a claim about what a knob does with the bench and traces behind it.

Before a release, `scripts/launch-check.sh <tgz>` runs the checklist in its header on the packed
tarball, in a `node:22.12-slim` container (Docker needed). Keys go in by name only; a step whose key
is not set is `SKIP`, and a run with a skip is not green. The release:

    npm ci && npm pack --pack-destination ..    # in a fresh clone of the release commit
    scripts/launch-check.sh ../llm-harness-builder-X.Y.Z.tgz
    git tag -a vX.Y.Z && git push origin vX.Y.Z
    gh release create vX.Y.Z ../llm-harness-builder-X.Y.Z.tgz
    npm publish ../llm-harness-builder-X.Y.Z.tgz    # 2FA
    npm view llm-harness-builder@X.Y.Z dist.shasum    # equals the sha1 the check printed
