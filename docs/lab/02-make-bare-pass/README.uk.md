[English](README.md) · **Українська**

# Вправа 2: хай bare пройде

Потрібна модель, локальна чи в хмарі. Спершу прочитайте
[Безпеку](../README.uk.md#безпека-перед-будь-якою-вправою-з-моделлю). Близько 20–40 хвилин.

Почніть із `bare` під власною назвою, `lab-start`, і змінюйте його, доки `bench` з ним не пройде.

## Стартовий файл

У теці, де вже запускали `serve`, є `harnesses/bare.json`:

    cp harnesses/bare.json start.json

Інакше завантажте його:

    curl -fLO https://raw.githubusercontent.com/bambooplanedev/llm-harness-builder/main/docs/lab/02-make-bare-pass/start.json

Ці два файли відрізняються лише `name` і `description`.

## Правило

Змінюйте лише `start.json`. Жодних інших файлів і жодних прапорців `bench`, крім наведених нижче.

## Перевірка

    npx llm-harness-builder bench start.json --task slug --n 3 --timeout 600

У контейнері, коли Ollama на хості, додайте `--base-url http://host.docker.internal:11434`.

У хмарі ([Підготовка](../README.uk.md#у-хмарі)) запустіть контейнер із `-e OPENROUTER_API_KEY`,
щоб ключ був у ньому, і додайте чотири прапорці:

    npx llm-harness-builder bench start.json --task slug --n 3 --timeout 600 \
      --kind openai --base-url https://openrouter.ai/api/v1 \
      --api-key-env OPENROUTER_API_KEY --model nvidia/nemotron-3-super-120b-a12b:free

Хмарний API відхиляє `backend.think`, тож файл, який його задає, там не запуститься. Три прогони до
15 ходів кожен плюс один запит попередньої перевірки `bench` — це близько 46 запитів, майже 50 на
день безкоштовного тарифу.

Вправу зараховано, якщо з трьох прогонів PASS щонайменше два. Три прогони — це шум: для 2 з 3
інтервал Вілсона (95%) — 0.21–0.94, тож успіх каже, що ваш файл може спрацювати, а не як часто.

**Час.** Щонайбільше 30 хвилин: три прогони, кожен не довше 600 с. Прогін, що дійшов до 600 с,
зупиняється і рахується як FAIL (`aborted`). Чому 600, а не 1800 за замовчуванням: єдиний успішний
прогін `bare` у прикладі бенча тривав 252 с (qwen3:8b на Ollama, ноутбук з RTX 4070, n = 2: ця
модель на цій задачі), тож 600 лишає запас на повільний успіх, а найгірший випадок — пів години
замість півтори.

## Підказки

<details>
<summary>Підказка 1</summary>

Чим закінчився прогін із вправи 1? Бідою було невдале редагування чи відповідь, яка так і не
надійшла?

</details>

<details>
<summary>Підказка 2</summary>

Порівняйте `start.json` з [`tuned-nothink.json`](../../../harnesses/tuned-nothink.json) або натисніть
`⇄` у прикладі бенча. Які з ручок, що відрізняються, стосуються однієї відповіді моделі, а не
інструментів?

</details>

<details>
<summary>Підказка 3</summary>

Один ключ `backend` обмежує довжину однієї відповіді. Знайдіть його в таблиці
[Файл харнесу](https://github.com/bambooplanedev/llm-harness-builder/blob/main/README.uk.md#файл-харнесу)
в README. Чи задає його `start.json`?

</details>

Розв'язок: `solution.uk.md` (ще не написаний: чекає на замір).
