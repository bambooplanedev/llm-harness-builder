[English](README.md) · **Українська**

# Вправа 1: чому він упав

Модель не потрібна. Близько 10–20 хвилин.

Прогін `d63e9548` ішов із харнесом `bare` і впав. Знайдіть, чому, і що в `tuned-nothink` цьому
запобігає. Прогін `059867d3` — це `tuned-nothink`, що проходить ту саму задачу на тій самій моделі.

## Як підступитися

**Інтерфейс.** Запустіть `npx llm-harness-builder serve` у порожній теці (див.
[Підготовка](../README.uk.md#підготовка)). У **Почніть звідси** (або в **Examples**) відкрийте
прогін FAIL `d63e9548` з `bare` і прогін PASS `059867d3` з `tuned-nothink`. Потім відкрийте приклад
бенча й натисніть `⇄`, щоб порівняти прогін `bare` з прогоном `tuned-nothink`: ручки, що
відрізняються, ідуть першими.

**Термінал.** Завантажте обидва трейси в поточну теку (або в `./runs`, тоді досить самого id):

    curl -fLO https://raw.githubusercontent.com/bambooplanedev/llm-harness-builder/main/example-runs/d63e9548.jsonl
    curl -fLO https://raw.githubusercontent.com/bambooplanedev/llm-harness-builder/main/example-runs/059867d3.jsonl
    npx llm-harness-builder analyze ./d63e9548.jsonl ./059867d3.jsonl

Файли обох харнесів — [`bare.json`](../../../harnesses/bare.json) і
[`tuned-nothink.json`](../../../harnesses/tuned-nothink.json).

## Питання

1. Чим закінчився `d63e9548` і через скільки часу?
2. Яким був його останній хід і що повернулося?
3. Що відбувалося на ходах перед ним?
4. Які налаштування `tuned-nothink` зупинили б це?

Запишіть свої відповіді, тоді порівняйте: [розв'язок](solution.uk.md).
