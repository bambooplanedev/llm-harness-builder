**English** · [Українська](install.uk.md)

# Installation

Nothing to install for a try — `npx` fetches it (pin a version with `npx llm-harness-builder@0.5.1`):

    npx llm-harness-builder --help

Or install it globally:

    npm install -g llm-harness-builder

Or as a dev dependency of a project, then run it with `npx`:

    npm i -D llm-harness-builder@0.5.1
    npx llm-harness-builder

Without the npm registry, from the archive on the [GitHub release](https://github.com/bambooplanedev/llm-harness-builder/releases) page:

    npm i -g https://github.com/bambooplanedev/llm-harness-builder/releases/download/v0.5.1/llm-harness-builder-0.5.1.tgz

In a container, for the CLI only — the commands the model runs then run inside the container, not on
your machine:

    docker run --rm -it -v "$PWD":/work -w /work node:22.12-slim npx llm-harness-builder …

A model server on the host is reached at `http://host.docker.internal:11434` (on Linux add
`--add-host=host.docker.internal:host-gateway`), not 127.0.0.1. The UI is not reachable from a container: `serve` listens on 127.0.0.1. From source, see
[Development](development.md).
