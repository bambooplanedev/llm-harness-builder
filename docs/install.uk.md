[English](install.md) · **Українська**

# Встановлення

Щоб спробувати, нічого встановлювати не треба — `npx` завантажить сам (версію можна закріпити:
`npx llm-harness-builder@0.5.1`):

    npx llm-harness-builder --help

Або встановіть глобально:

    npm install -g llm-harness-builder

Або як dev-залежність проєкту, а запускайте через `npx`:

    npm i -D llm-harness-builder@0.5.1
    npx llm-harness-builder

Без реєстру npm — з архіву на сторінці [релізу на GitHub](https://github.com/bambooplanedev/llm-harness-builder/releases):

    npm i -g https://github.com/bambooplanedev/llm-harness-builder/releases/download/v0.5.1/llm-harness-builder-0.5.1.tgz

У контейнері, лише для CLI — тоді команди, які запускає модель, виконуються всередині контейнера, а
не на вашій машині:

    docker run --rm -it -v "$PWD":/work -w /work node:22.12-slim npx llm-harness-builder …

Сервер моделі на хості доступний за `http://host.docker.internal:11434` (на Linux додайте
`--add-host=host.docker.internal:host-gateway`), а не 127.0.0.1. Інтерфейс із контейнера недоступний: `serve` слухає 127.0.0.1. Із вихідного коду — див.
[Розробка](development.uk.md).
