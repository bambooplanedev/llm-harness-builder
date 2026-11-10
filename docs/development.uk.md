[English](development.md) · **Українська**

# Розробка

    git clone https://github.com/bambooplanedev/llm-harness-builder
    cd llm-harness-builder
    npm install

    npm test               # vitest, no model needed
    npm run typecheck      # tsc and vue-tsc
    npm run build          # dist/ and web/dist/
    npm run cli -- demo    # the CLI from source
    npm run dev:server     # serve from source, and in another terminal:
    npm run dev:web        # the page with hot reload

CLI і сервер написані на TypeScript у `src/`, сторінка — на Vue 3 у `web/src/`, а тести в `tests/`
працюють проти фейкових бекендів. Issues і pull requests вітаються; зміна ручки має йти з тестом, а
твердження про те, що робить ручка, — з бенчем і трейсами за ним.

Перед релізом `scripts/launch-check.sh <tgz>` проганяє чекліст зі свого заголовка на запакованому
tarball у контейнері `node:22.12-slim` (потрібен Docker). Ключі передаються лише за іменем; крок, чий
ключ не задано, — `SKIP`, а прогін зі skip не зелений. Реліз:

    npm ci && npm pack --pack-destination ..    # in a fresh clone of the release commit
    scripts/launch-check.sh ../llm-harness-builder-X.Y.Z.tgz
    git tag -a vX.Y.Z && git push origin vX.Y.Z
    gh release create vX.Y.Z ../llm-harness-builder-X.Y.Z.tgz
    npm publish ../llm-harness-builder-X.Y.Z.tgz    # 2FA
    npm view llm-harness-builder@X.Y.Z dist.shasum    # equals the sha1 the check printed
