# Как работает devflow

Это руководство для разработчика, который меняет devflow или разбирает остановившийся запуск. Начните с `devflow status <id> --json` и `devflow next <id>`. Поле `status` показывает последнюю сохранённую точку. Следующее действие находится в поле `next` команды `status` и в поле `stage` команды `next`. Поле `reason` объясняет ожидание. Например, `DESIGNED` и `stage: null` обычно означают, что план готов к решению. Завершение задачи подтверждает `status: DONE`. Поле `done: true` в последней строке `run` означает, что завершился этот вызов команды.

## Кто принимает решения

| Участник | Какие сведения получает | Какой результат передаёт дальше |
|---|---|---|
| `explore` | Описание задачи и доступ к проекту | Записывает результаты исследования для проектировщика. |
| `design` | Исследование, постановку задачи, контекст спецификаций и обратную связь при пересмотре | Готовит OpenSpec change с требованиями, зоной изменений, тестовым планом и нумерованными задачами. На `complex` выбирается `design_complex`, если он настроен. Декомпозиция входит в работу этой роли. |
| Человек или делегированная роль `review` | Ревизию плана. Модель получает отдельную копию плана | Принимает план или возвращает его с причиной. По умолчанию решает человек. Для делегирования служит `delegate-approval <id> --to model`. Модель выбирается в порядке `review`, `design_complex`, `design`. Поддерживаются Claude и Codex. |
| `implement` | Принятый план, зону, замечания прошлых попыток | Меняет рабочее дерево, добавляет тесты, сообщает о блокировке или конфликте плана. Для `small` запускается настроенная роль `small`. |
| `gates` | Базовый коммит, рабочее дерево, зону, правила тестирования | Выполняет проверки программно. Возвращает `pass`, `fail` или `blocked` с доказательствами. |
| `verify` | Изолированную копию результата, требования и контекст проверки. Из копии удаляется внутреннее состояние devflow и проектный `design.md` текущего change | Возвращает `VERDICT: PASS`, `VERDICT: REWORK` либо `VERDICT: HUMAN`. Повторный раунд фокусируется на серьёзных дефектах и регрессиях уже найденных проблем. |

Роль выдаёт артефакт или заключение. Оркестратор проверяет его и предлагает событие. Функция `transition` вычисляет допустимое новое состояние. Запись результата стадии сверяет сохранённый `updatedAt` с тем, на котором стадия начиналась. Для делегированного решения отдельно сверяются полномочия, ревизия и содержимое плана. Назначения моделей видны через `devflow roles`. [Маршрутизация](../src/lifecycle.ts) · [Запуск стадий](../src/stages.ts) · [Проверка делегированного решения](../src/review.ts)

## Как читать переходы

| Сохранённый статус | Следующее штатное действие | Что открывает следующий переход |
|---|---|---|
| `NEW` | На `small` сразу `implement`, на `medium/complex` — `explore` | Успешная реализация ведёт в `IMPLEMENTED`, исследование — в `EXPLORED`. |
| `EXPLORED` | `design` | A valid plan advances to `DESIGNED`. Plan rejections and automatic escalations from `medium` to `complex` return here for a revision. |
| `DESIGNED` | Ожидание решения по плану, при делегировании `run` вызывает `review` | Одобрение даёт `PLAN_APPROVED`. Отклонение создаёт новую ревизию и возвращает в `EXPLORED`. |
| `PLAN_APPROVED` | `implement` | Успех даёт `IMPLEMENTED`. Конфликт может вернуть план в проектирование. |
| `IMPLEMENTED` | `gates` | При успехе `small` завершается в `DONE`, остальные переходят в `GATES_PASSED`. |
| `GATES_PASSED` | `verify` | `PASS` на актуальном снимке даёт `DONE`. `REWORK` запускает цикл исправления или эскалацию. `HUMAN` передаёт решение человеку. |
| `HUMAN` | Оператор читает `humanReason` и историю | После устранения причины `approve <id> --resume` сбрасывает попытки implement/verify и возвращает к реализации. Для конфликта плана доступен отдельный возврат в design по номеру ревизии. |
| `DONE` | Автоматический цикл завершён | История и доказательства остаются доступны для разбора. |

`review` — действие в точке одобрения, `REWORK` — исход проверки. Список статусов, выбор роли и правила переходов заданы в одном модуле. История и счётчики попыток сохраняются в `.devflow/runs/<id>/state.json`. Старое состояние проходит валидацию при чтении. [Схема и переходы](../src/lifecycle.ts) · [Хранилище](../src/store.ts) · [Тесты переходов](../test/lifecycle.test.ts)

## Что делать при остановке

| Наблюдение | Как принято решение | Следующее действие |
|---|---|---|
| `awaiting_plan_approval` | Автоматическое исполнение дошло до точки одобрения | Прочитать change и номер ревизии из `devflow nodes <id>`, затем одобрить просмотренную ревизию либо вернуть замечания. После трёх модельных отклонений полномочие возвращается человеку. |
| `PLAN CONFLICT: [2.1/test] …` от исполнителя | Для принятого плана оркестратор распознаёт ключ проблемы и существующий ID узла. Первый конфликт отправляет план в design. Второй конфликт с тем же ключом в учитываемой последовательности ведёт к `plan_conflicts_limit`. | Проверить формулировку узла и зависимые требования. Из `HUMAN` по этой причине можно вернуть узел через `approve --revision … --reject … --node …`. |
| `stale`, `plan_changed` или `snapshot_changed` | Устаревший ответ рецензента отбрасывается. Изменение одобренного плана требует повторного одобрения, изменение уже проверенного снимка — повторных gates. Третья инвалидация приводит к `HUMAN`. | Сверить ревизию, снимок и историю перед следующим запуском. |
| Gate `fail` | A zone violation escalates immediately. Other failures return to implementation until `limits.escalate_after` is reached. At `complex`, a gate escalation goes to `HUMAN`. | Review the failed gate, its reason and its recorded evidence. |
| `blocked` при gates или `BLOCKED: …` от исполнителя | Проверку или работу невозможно выполнить в текущих условиях. Задача переходит в `HUMAN`. Событие блокировки роли не расходует попытку реализации. | Устранить причину из журнала. Учесть, что `--resume` открывает реализацию даже после остановки на другом этапе. |
| `VERDICT: REWORK` | The attempt counts toward the verify and rework limits. The second `REWORK` on `medium` escalates to `complex` and starts a plan revision. | Review the latest verify findings. The designer receives them with the current plan and the escalation reason. |

An automatic escalation from `medium` to `complex` increments `planRevision` once, clears the approval digest and gates snapshot, and records the trigger and `revision <N>` in history. The designer receives the current plan and a binding request naming the tier change and trigger. The context includes the triggering stage outcome and any recorded reason, including for outcomes entered with `devflow complete`. For `rework_repeated`, a verify run also supplies its verdict. For `zone_violation` or `gates_failed_repeatedly`, a gate run supplies its failed gate report, even if verify has yet to run. Detailed evidence is saved with the escalation that it triggered.

After a failed design, run the task again to retry the same revision with the same escalation context. Design can retain valid plan files and spec deltas. Once design succeeds, approve the new revision at `DESIGNED`, or let `run` invoke the delegated reviewer when delegation is enabled. Approval using the old revision returns `plan_moved`.

`run --once` выполняет до одного действия оркестратора. Обычный `run` может выполнить несколько стадий за вызов. В основном цикле `fail` и `blocked` завершают вызов с кодом 1. Ожидание решения, некоторые человеческие и устаревшие результаты допускают код 0. Для интеграции читайте `outcome`, `next.status` и `next.reason` из JSON. [Цикл](../src/stages.ts) · [CLI](../src/cli.ts) · [Интеграционные сценарии](../test/run.test.ts)

## Где искать причину конкретного решения

| Что посмотреть | Какой вопрос это проясняет |
|---|---|
| `devflow next <id>`, `devflow status <id> --json` | Что может выполниться сейчас, кто получит работу и какая попытка будет следующей? |
| `.devflow/runs/<id>/state.json` | Какие события уже записаны, какой `base` выбран, какой снимок был проверен и почему возник `HUMAN`? |
| `openspec/changes/<id>/`, `devflow nodes <id>` | Какие требования, тесты и узлы предъявлены к одобрению и к какой ревизии они относятся? |
| `.devflow/runs/<id>/facts.md`, `review.md`, `verdict-round<N>.md` и `logs/` внутри каталога запуска | Какие факты получил проектировщик, что ответил рецензент, какие замечания оставил проверяющий и какую команду исполнили? Файлы появляются по мере прохождения соответствующих стадий. |

Для фонового запуска используйте `devflow run <id> --detach` и `devflow log <id> --follow`. Соперничающие запуски одной задачи проверяют блокировку; активная блокировка даёт `run_active`. Если во время стадии состояние успело измениться, `record` проверяет его перед записью и может вернуть `state_changed`. Проверка версии и атомарная замена файла отвечают за разные операции. [Блокировка запуска](../src/background.ts) · [Запись состояния](../src/store.ts) · [Тесты фонового запуска](../test/background.test.ts)

## Как пересмотреть один узел OpenSpec

Единица одобрения — весь каталог `openspec/changes/<id>/`. В `tasks.md` узел имеет стабильный ID, например `- [ ] 2.1 Проверить ошибку тайм-аута`. В задаче стоит указать наблюдаемый результат, зависимость от других узлов и тест, по которому определяется готовность.

1. Посмотрите состояние задачи. В выводе `devflow nodes <id>` поле `revision` содержит текущую ревизию, а `nodes` — список задач. Сверьте узел с требованиями и соседними задачами.
2. Для локального уточнения выполните, например, `devflow approve export-csv --revision 3 --reject "Указать результат для пустого файла" --node 2.1`. Номер в команде должен соответствовать просмотренной ревизии.
3. При следующем design проектировщик видит контекст всего плана и пишет кандидат отдельно. Devflow проверяет один незакрытый узел с тем же ID и его отступы, сверяет отметку обновления состояния и хеш плана, затем заменяет фрагмент. Остальные задачи сохраняются. Если меняется общее требование, зона или несколько зависимых задач, верните весь план, опустив `--node`.
4. Повторно проверьте весь change и одобрите новую ревизию. Решения по замечаниям verify привязаны к номеру раунда и ID вида `F1`. Verify группирует замечания в разделе `## Findings`. Нумерация в разделе о запуске тестов независима. Для старых вердиктов поддерживается список перед первым Markdown-заголовком. При `fix` исполнитель получает исходную формулировку замечания и одобренное указание по исправлению. Дублирующийся ID в вердикте даёт `invalid_verdict_findings`, пропущенное решение в плане — `invalid_plan_nodes`. Действие `fix` ссылается на существующий узел, `defer` и `dismiss` указывают `-` и объясняют причину.

[Формат и пример решений](../README.md#revising-one-part-of-an-openspec-plan) · [Замена узла](../src/plan-nodes.ts) · [Тесты границ замены](../test/plan-nodes.test.ts) · [Проверка OpenSpec-артефактов](../src/artifacts.ts)

## Откуда берётся доказательство готовности

1. По умолчанию при старте в Git фиксируется текущий HEAD как `base`. В обычном маршруте одобрение связывает ревизию с хешем плана. Отметки выполнения чекбоксов и окончания строк в `tasks.md` нормализуются для хеша плана. Зона берётся из плана. Правила тестов, setup и генерации gates читают из конфигурации базового коммита. Если там конфигурации нет, изменённая в рабочем дереве конфигурация вызывает `untrusted_config`.
2. `zone` сопоставляет изменённые пути с разрешёнными шаблонами и объявленными результатами генерации. Каталог OpenSpec текущей задачи допускается отдельно. У `small` отсутствующая зона даёт предупреждение `no_zone`, у остальных это блокирует проверку.
3. `tests` запускает настроенную команду в рабочем дереве. `rollback` создаёт временное дерево на `base`: сначала тесты должны пройти, затем изменённые тесты без реализации должны упасть допустимым образом, а после наложения полного изменения — пройти. Так обнаруживаются тесты, которые уже были зелёными на старом коде. Один вызов `gate <id> tests` даёт диагностику. Переход записывает полный `gate <id> all`, когда ожидается стадия gates.
4. После gates сохраняется хеш снимка. Перед принятием `PASS` оркестратор повторно сверяет его с рабочим деревом. Ручное принятие gates или verify требует `--override` с причиной, которая попадает в историю.

5. Roles do not repeat the full test suite. When the base-commit config has `test.focused`, implement, small and verify get only that command (a template with `{files}`). The Claude hook allows it only with files that match `test.paths` ([matcher](../src/focused.ts)). Verify relies on the gate results for the same snapshot and runs focused tests only for a concrete question the gates did not answer. The verdict separates evidence "confirmed by gates" from evidence "checked additionally".

[Проверки](../src/gates.ts) · [Хеши](../src/snapshot.ts) · [Тесты rollback](../test/gates.test.ts)

## Два примера запуска

Для проекта с настроенным devflow, рабочей тестовой командой и доступными исполнителями:

```sh
devflow start csv-empty "Обработать пустой CSV" --tier small --zone "src/**" --zone "test/**"
devflow run csv-empty
devflow status csv-empty --json

devflow start export-csv "Экспортировать отфильтрованные записи в CSV" --tier medium
devflow run export-csv
devflow nodes export-csv
devflow status export-csv --json
# После чтения первой ревизии плана:
devflow approve export-csv --revision 1
devflow run export-csv
devflow next export-csv
```

## Изменение в разработке — `run-robustness`

В рабочем варианте этого change распознанный лимит провайдера оставляет статус и номер попытки прежними. В состоянии появляется `pause` с полями `stage`, `runner`, `reason`, `at` и, при наличии, `reset`. При делегированном одобрении возможна пара `next.stage: null` и `pause.stage: "review"`. Вызов `run`, который зарегистрировал такую паузу, завершается кодом 75. Повторная команда `run` пробует действие снова. Change также сохраняет хеши путей, уже изменённых к началу первой реализации, в `dirtyAtImplement` для проверки зоны. При разборе запуска сверяйте версию исполняемого CLI: эти поля относятся к реализации данного change.

В ревизии 3 запланирован следующий шаг: узел 7.3 должен показывать `next.stage: "review"` при паузе делегированного рецензента. Узел 7.4 предусматривает повторную очистку временной копии. Здесь существенен контракт `removeDetached`: функция удаляет и копию, и её временный родительский каталог. При восстановлении из `pendingCleanup` вызывающий код должен подтвердить принадлежность обоих путей данной задаче до вызова очистки. [Создание и удаление временных копий](../src/git.ts)

## Как изменить сам devflow

1. Для изменения поведения сформулируйте наблюдаемый сценарий, добавьте тест и запустите его до правки кода. Убедитесь, что он упал по ожидаемой причине. Тесты переходов находятся в `test/lifecycle.test.ts`, решения по плану — в `test/review.test.ts` и `test/plan-nodes.test.ts`, а полный путь через фиктивного исполнителя — в `test/run.test.ts`.
2. Измените слой, который владеет решением. Чистые переходы находятся в `src/lifecycle.ts`, работа с артефактами и запуском — в `src/stages.ts`, CLI и MCP являются точками входа. Проверьте повторный запуск и ранее сохранённое состояние, если меняли формат.
3. Обновите JSDoc и эту таблицу переходов в том же изменении, если изменился контракт. Для изменений требований обновите OpenSpec и выполните строгую валидацию соответствующего change.
4. В репозитории используется Node.js 22+. Установите зависимости через `npm ci`. `npm run build` компилирует TypeScript. Для запуска одного набора после сборки годится `node --test dist/test/lifecycle.test.js`. Пересоберите поставляемые плагины через `npm run build:plugins` и выполните `npm test`, включая проверку актуальности сборок.

[Обязательное правило документирования](../.agents/instructions/DOCUMENTATION.instructions.md) · [Спецификация проекта](SPEC.md) · [Открытые задачи](TODO.md)
