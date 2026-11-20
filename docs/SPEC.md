# devflow — спецификация v0.1

Статус: **черновик на ревью**. Дата: 2026-11-17.

## 1. Зачем

devflow ведёт задачу разработки через несколько ролей, каждой из которых
назначена своя модель и свои права. Он закрывает три слабых места
промптового пайплайна, где всё держится на честном слове одной модели в
одной сессии:

1. **Контекст копится.** Каждая роль стартует со свежим контекстом и
   получает только свои входы.
2. **Правила не принуждаются.** Зона правок, порядок этапов и лимиты попыток
   проверяет код, а не промпт.
3. **Проверяющий совпадает с автором.** Verify выполняет модель, которая не
   планировала и не писала код. Пустые тесты ловит скрипт отката, а не модель.

Чем devflow **не** является:

- не трекер задач (TaskFrame, Jira, OpenProject подключаются потом адаптерами);
- не замена OpenSpec;
- не собственный агентный цикл: правки и запуск команд делают официальные
  CLI моделей.

## 2. Принципы

- **Независимость.** devflow не плагин OpenSpec и не зависит от него. Проекты
  без OpenSpec работают так же.
- **Один источник правды для плана: формат OpenSpec.** devflow всегда пишет
  план как change-папку OpenSpec (`openspec/changes/<id>/`), есть OpenSpec в
  проекте или нет. Для OpenSpec наше изменение выглядит родным. На машине без
  devflow его можно исполнить обычным `/opsx:apply`.
- **Расширение, а не замена.** Наши добавки (зона, тест-план) пишутся
  разделами внутри родных файлов. Отдельно хранится только машинное и
  производное состояние.
- **Подписки, а не API-ключи.** Роли исполняют официальные CLI: `claude -p`
  (подписка Claude) и `codex exec` (подписка ChatGPT). devflow сам LLM не вызывает.
- **Детерминированный оркестратор.** «Какой этап следующий» решает state
  machine, а не модель.
- **Минимум зависимостей.** Рантайм: Node 22+, `@modelcontextprotocol/sdk`, `zod`.

## 3. Архитектура

```
            ┌──────────────── входы ────────────────┐
            │ CLI `devflow`   плагин Claude Code   MCP-сервер │
            └───────────────┬───────────────────────┘
                            ▼
   ┌──────────────────── ядро ────────────────────────┐
   │ state machine этапов · конфиг ролей · ворота     │
   │ (check-zone, rollback-check, validate, лимиты)   │
   └──────┬───────────────────┬───────────────────────┘
          ▼                   ▼
   раннеры моделей      хранилище изменений
   claude -p            openspec-формат (всегда)
   codex exec           + openspec CLI, если установлен
                        + .devflow/ (машинное состояние)
                            ▼
                     адаптеры трекеров (позже)
```

Ядро не знает о входах, раннерах и трекерах. Они подключаются через
интерфейсы (`Runner`, `ChangeStore`, `Tracker`).

## 4. Этапы и уровни задач

### 4.1 Этапы

| # | Этап | Роль (по умолчанию) | Вход | Выход |
|---|---|---|---|---|
| 1 | explore | Haiku | формулировка задачи, `openspec/specs/`, код (только чтение) | `.devflow/runs/<id>/facts.md` |
| 2 | design | Opus | задача, facts.md, specs | change-папка: proposal, design (с зоной и тест-планом), tasks, дельты спек |
| — | **gate: plan** | человек + код | change-папка | `openspec validate` OK, зона распарсена, **человек одобрил план** |
| 3 | implement | Sonnet | change-папка, код | изменения кода и тестов, отмеченные пункты tasks.md |
| — | **gate: code** | код | diff | check-zone OK, rollback-check OK, тест-команда зелёная |
| 4 | verify | codex | критерии (сценарии), diff, результат ворот. **Без** design-рассуждений и логов implement | вердикт PASS / REWORK / HUMAN |
| 5 | done | человек | вердикт PASS | коммит/PR по решению человека, затем archive |

REWORK возвращает в implement с замечаниями verify. Провал gate: code тоже
возвращает в implement. Счётчик попыток implement ограничен `limits.implement`
(по умолчанию 3). Когда он исчерпан, задача переходит в `HUMAN`.

### 4.2 Уровни

| Уровень | Этапы |
|---|---|
| small | implement → gate: code → done. Change-папка не создаётся (как и рекомендует OpenSpec для фиксов без смены поведения). Зона задаётся при старте (`--zone`), без неё ворота zone пропускаются с предупреждением |
| medium | все этапы |
| complex | все этапы. design по умолчанию на сильнейшей модели (`roles.design_complex`). Verify можно запускать двумя раннерами |

Уровень по умолчанию выбирает devflow (см. 4.4). Человек может задать его
явно через `--tier` или поменять в любой момент.

### 4.4 Выбор уровня и эскалация

**Начальный уровень.** Если `--tier` не задан, первым идёт короткий triage
(роль `explore`, дешёвая модель). Он отвечает в `.devflow/runs/<id>/triage.json`
по фиксированной схеме: ожидаемые файлы, затронуты ли поведение и спеки,
миграции, публичные API. Правило в коде, а не мнение модели, переводит это
в уровень. Например: меняется поведение или больше N файлов → medium;
миграции, ядро или публичный API → complex; иначе small.

**small** исполняет одна модель (`roles.small`, по умолчанию Sonnet), но
ворота zone, rollback и tests обязательны всегда: они бесплатные.

**Эскалация вверх идёт автоматически**, потому что добавляет только проверки
и стоимость. Триггеры (все детерминированные):

| Триггер | Действие |
|---|---|
| ворота code упали `limits.escalate_after` раз подряд (по умолчанию 2) | уровень +1 |
| implement пытался писать вне зоны | уровень +1 |
| diff вышел за ожидаемые в triage файлы | small → medium |
| verify вернул REWORK дважды | medium → complex |
| на complex исчерпан `limits.implement` | HUMAN |

Эскалация не трогает рабочее дерево (решено в изменении `add-gates`: откат
к базе разрушителен). При переходе small → medium задача идёт с этапа explore,
explore и design видят уже сделанные изменения. При переходе medium → complex
план пересматривается моделью `design_complex`.

Реализовано (`add-gates`): эскалация по повторным провалам ворот
(`gates_failed_repeatedly`), нарушению зоны (`zone_violation`) и второму REWORK
на medium (`rework_repeated`); на complex вместо эскалации HUMAN. Сбои
окружения (`blocked`) эскалацию не вызывают. Триггер «diff вышел за файлы из
triage» и verify двумя раннерами ещё не реализованы.

**Вниз** уровень меняет только человек. Каждая эскалация пишется в
`state.json` с причиной и показывается в `status`.

### 4.3 Состояния

`NEW → EXPLORED → DESIGNED → PLAN_APPROVED → IMPLEMENTED → GATES_PASSED → VERIFIED → DONE`.
Плюс `REWORK` (обратно в implement) и `HUMAN` (ждёт решения).
Переходы задаёт только ядро. `devflow next <id>` возвращает следующий этап
и его входы. Этап, запущенный не по `next`, ядро отклоняет.

## 5. Роли, модели, раннеры

Роль = раннер + модель + права + промпт роли.

### 5.1 Раннеры

| Раннер | Команда | Подписка | Права |
|---|---|---|---|
| `claude` | `claude -p --model <m> --allowedTools <...> --output-format json` | Claude | allowlist инструментов + хуки проекта (PreToolUse) |
| `codex` | `codex exec --model <m> --sandbox <read-only\|workspace-write>` | ChatGPT | песочница codex |
| `command` | шаблон команды из конфига, например `opencode run --model {model} --file {prompt_file}` | любая / своя | только то, что даёт сам инструмент; ворота devflow действуют всегда |

**Локальные модели** (Ollama, LM Studio) подключаются без нового раннера:
через `codex` с локальным провайдером (`codex exec --oss` или
`model_provider` в конфиге codex) либо через `command` с любым агентным CLI,
который умеет работать с локальной моделью. Голую модель без агентного
CLI роль использовать не может: ей нечем читать файлы и править код.

**Модели вызывает devflow, а не модель-оркестратор через свои MCP.**
Причины: (1) ответ одной модели не проходит через контекст другой, поэтому
нет лишних токенов и пересказа, и независимость verify сохраняется;
(2) работает одинаково из любого клиента, не нужно настраивать codex MCP в
каждом; (3) ворота и лимиты применяет код, а не модель, которая решает,
звать ли codex. Модель в Claude App или Claude Code только просит devflow
запустить этап и показывает результат.

Требования к раннеру (реализованы в изменении `add-runners`, детали в `openspec/specs/runners`):

- промпт идёт в stdin, после чего stdin закрывается: `codex exec` с не-терминальным stdin иначе ждёт ввода бесконечно;
- окружение ребёнка собирается по белому списку (системные переменные плюс `runners.env.pass`). Токены сессии и чужие секреты до модели не доходят; ключи API вендора вырезаются, чтобы шла подписка (`runners.<runner>.use_api_key` возвращает их);
- `claude` никогда не запускается с `--bare`: этот режим не читает OAuth, то есть отключает подписку;
- на Windows `.cmd`-шимы (`codex.cmd`) запускаются через `cmd.exe /d /v:off /s /c` с двойными кавычками, а аргументы с `"%!^&|<>` отклоняются;
- результат роли проверяется по файлам: ожидаемый выход должен быть новым или изменённым (хэш до и после), непустым и внутри проекта;
- лог пишется в `.devflow/runs/<id>/logs/<роль>-<n>.log` (или `.devflow/logs/`), создаётся эксклюзивно, токены маскируются.

### 5.2 Права по ролям

| Роль | Чтение | Запись |
|---|---|---|
| explore | весь репо | только `.devflow/runs/<id>/` |
| design | весь репо | только `openspec/changes/<id>/` и `.devflow/runs/<id>/` |
| implement | весь репо | только файлы из зоны + `tasks.md` своего изменения |
| verify | change-папка (без design.md, см. ниже), diff, тесты | только `.devflow/runs/<id>/verdict.json` |

Для раннера `claude` запись ограничивает хук PreToolUse (`devflow hook
pre-tool-use`), который devflow подключает к каждому запуску через `--settings`:
он проверяет путь против прав текущего этапа, и разрешающие правила самого
пользователя его не обходят (проверено вживую 2026-11-18). Важно:
агенты из плагина игнорируют `hooks` и `permissionMode` во frontmatter, поэтому
хук регистрируется в `hooks/hooks.json` плагина или в `.claude/settings.json`
проекта.

Для verify из `design.md` в промпт передаётся только раздел `Test plan`.
Рассуждения автора verify не видит намеренно.

### 5.3 Модели по умолчанию

```json
{
  "roles": {
    "explore":        { "runner": "claude", "model": "haiku" },
    "small":          { "runner": "claude", "model": "sonnet" },
    "design":         { "runner": "claude", "model": "opus" },
    "design_complex": { "runner": "claude", "model": "fable" },
    "implement":      { "runner": "claude", "model": "sonnet" },
    "verify":         { "runner": "codex",  "model": "gpt-5-codex" }
  }
}
```

Только Claude: `verify` → `{ "runner": "claude", "model": "opus" }`.
Только Codex: все роли на `codex`. Одна строка на роль.

## 6. Совместимость с OpenSpec

### 6.1 Где что лежит

```
openspec/
  specs/<capability>/spec.md          # живые спеки (ведёт OpenSpec / archive)
  changes/<id>/
    proposal.md                       # родной формат
    design.md                         # родной формат + наши разделы
    tasks.md                          # родной формат
    specs/<capability>/spec.md        # дельты: ADDED/MODIFIED/REMOVED, сценарии
.devflow/
  config.json                         # конфиг проекта (коммитится)
  .gitignore                          # создаёт `devflow init`, содержит `runs/`
  runs/<id>/                          # машинное состояние (не коммитится)
    state.json  facts.md  zone.json  verdict.json  logs/
```

### 6.2 Правила

1. Содержательный план живёт **только** в `openspec/changes/<id>/`.
2. Наши добавки это разделы `## Impact zone` и `## Test plan` в `design.md`.
   Для OpenSpec это обычный текст дизайна.
3. `## Impact zone` содержит список путей и glob-шаблонов, по одному на
   строку, в формате `- path`. `zone.json` **генерируется** из этого раздела
   при каждом запуске gate. Руками его не правят. Файлы тестов из тест-плана
   тоже должны входить в зону.
4. id задачи трекера (например `GF-123`) указывается строкой в начале `proposal.md`.
5. Сценарии в дельтах спек (`#### Scenario:` с WHEN/THEN) являются критериями
   приёмки для verify и основой тест-плана.
6. Если установлен `openspec` CLI, gate: plan вызывает `openspec validate <id> --strict`.
   Если не установлен, срабатывает встроенная минимальная проверка структуры.
7. Archive: при наличии CLI это `openspec archive <id>`. Без него devflow
   выполняет упрощённое слияние дельт и сообщает об этом.
8. В проектах коллег схема OpenSpec по умолчанию и `openspec/config.yaml` не меняются.

### 6.3 Гарантия совместимости

В репо devflow есть тест: сгенерированное изменение-фикстура проходит
`openspec validate --strict` на зафиксированной версии OpenSpec
(devDependency). Если формат OpenSpec сменится, первым упадёт этот тест.

**Проверить при сборке:** точные требования `validate` к proposal/tasks/дельтам
актуальной версии и то, что лишние разделы в `design.md` не вызывают
предупреждений.

## 7. Ворота

| Ворота | Проверка | Как |
|---|---|---|
| plan | структура изменения, зона распарсена, одобрение человека | `openspec validate` или встроенная проверка; одобрение фиксирует `devflow approve <id>` |
| zone | `git diff --name-only` относительно базы задачи ⊆ зона ∪ {tasks.md изменения} | без модели |
| rollback | новые и изменённые тесты падают без прод-изменений и проходят с ними | см. 7.1 |
| tests | тест-команда проекта зелёная | `config.test.command` |
| verify | вердикт привязан к sha256 текущего diff | устаревший вердикт (diff изменился) недействителен |

### 7.1 rollback-check

1. Разделить diff задачи на тесты (`config.test.paths`) и прод-код (всё остальное в зоне).
2. Во временном git worktree от базы задачи применить **только** тестовую часть.
   Запустить тест-команду и ожидать падения новых тестов.
3. Применить прод-часть и ожидать прохождения.
4. Тест, который проходит без прод-изменений, помечается как «ничего не
   проверяет» и роняет ворота.

Рабочее дерево пользователя не трогается: всё делается в отдельном worktree.

### 7.2 Статус реализации (`add-gates`, детали в `openspec/specs/gates`)

Реализованы zone, tests и rollback (`devflow gate <id> [zone|tests|rollback|all]`).
У каждых ворот три исхода: `pass`, `fail` (изменение плохое) и `blocked`
(проверить не удалось: нет git или базы, упали setup/baseline, таймаут, не
удалось убрать worktree). `blocked` уводит задачу к человеку без эскалации.
Перед baseline в worktree выполняется `test.setup` (например `npm ci`),
повторно — если изменение затронуло файлы зависимостей. Ворота plan и
привязка verify к хэшу diff — в следующих изменениях.

Ограничения: «красный» считается на уровне всего прогона (в том числе ошибка
компиляции из-за ещё не написанного кода — законный TDD-красный, но не
доказательство, что каждый тест падает); запись в игнорируемые git пути
зона не видит.

## 8. Входы

### 8.1 CLI

Статус (`add-stage-run`): реализованы `run [--once] [--detach]`, `log [--follow]`,
`approve --reject`; план всегда в `openspec/changes/<id>/`, verify в изолированном
worktree, привязка плана (отпечаток при approve) и доказательств (снимок кода) —
см. `openspec/specs/stage-execution` и `change-artifacts`. Актуальный список
команд — в README.

```
devflow init                      # создать .devflow/config.json, проверить раннеры
devflow start <id> "<задача>" [--tier small|medium|complex] [--tracker GF-123]
devflow next <id>                 # следующий этап и входы (JSON)
devflow run <id> [--stage x]      # исполнить следующий этап раннером
devflow approve <id>              # одобрить план (gate: plan)
devflow gate <id> [zone|rollback|tests|all]
devflow status [<id>]
devflow archive <id>
devflow hook pre-tool-use         # вызывается хуком Claude Code
```

### 8.2 Плагин Claude Code

- Команды `/devflow:start`, `/devflow:next`, `/devflow:status`, `/devflow:approve`.
- Хук `PreToolUse` → `devflow hook pre-tool-use`.
- Режим работы: главная сессия спрашивает `devflow next` и запускает этап через
  `devflow run`. Раннер `claude` запускается отдельным процессом с нужной
  моделью. Встроенные сабагенты не используются, чтобы права и модель
  гарантированно соответствовали конфигу.

**Открытый вопрос:** не запускать ли роли с раннером `claude` как сабагенты
(`model:` во frontmatter), чтобы их было видно в UI? Минус: права агентов
плагина урезаны (см. 5.2). Решаем после прототипа.

### 8.3 MCP-сервер

Запуск `node <path>/dist/mcp.js` (не `npx`). Инструменты:

- `devflow_start`, `devflow_next`, `devflow_status`, `devflow_approve`;
- `devflow_run`: запускает этап в фоне и **сразу** возвращает `run_id`. Долгих
  MCP-вызовов нет;
- `devflow_run_status(run_id)`, `devflow_log(run_id, tail)`.

Так devflow работает из чата Claude desktop, OpenCode и любых других MCP-клиентов.

## 9. Конфиг проекта `.devflow/config.json`

```json
{
  "roles": { "...": "см. 5.3" },
  "limits": { "implement": 3, "verify": 2, "escalate_after": 2 },
  "test": {
    "command": "python manage.py test",
    "paths": ["**/tests/**", "**/test_*.py"]
  },
  "openspec": { "cli": "auto" },
  "logs": { "keep": 20 }
}
```

Валидируется через `zod`. Неизвестные поля являются ошибкой.

The optional `test.focused` is a command template with exactly one `{files}` placeholder (and no other `{...}`). It is read from the base commit, like `build.generate`. When it is set, the implement, small and verify roles get it instead of the full `test.command`. The Claude hook allows only the template filled with one or more files separated by single spaces (at most 64). Each file is a relative path made of `[A-Za-z0-9_./-]`, has no `.` or `..` segment, does not start with `-`, and matches `test.paths`. Any other text is denied. Prompt placeholders: `{{focusedCommand}}`, `{{implementTests}}`, `{{verifyTests}}`. Verify does not rerun the full suite: the gate results are for the same snapshot (the hash is re-checked before PASS), and the verdict marks each piece of evidence as "confirmed by gates" or "checked additionally". The gates still run the full `test.command`.

## 10. Стек

TypeScript, Node 22+, сборка `tsc` без бандлера, тесты `node:test`.
Зависимости рантайма: `@modelcontextprotocol/sdk`, `zod`.
devDependency: `@fission-ai/openspec` (зафиксированная версия) для теста совместимости.

## 11. План сборки

| Шаг | Что | Готово, когда |
|---|---|---|
| 1 | Ядро: конфиг, state machine, `start/next/status/approve` | юнит-тесты переходов, включая отказ «этап не по next» |
| 2 | Ворота `zone`, `rollback`, `tests` | тесты на фикстурном git-репо, включая «тест ничего не проверяет» |
| 3 | ChangeStore в формате OpenSpec + парсер `Impact zone` + тест совместимости с `openspec validate` | фикстура проходит `--strict` |
| 4 | Раннеры `claude`, `codex` (Windows-шимы, логи, проверка выходных файлов) | ручной прогон обоих на подписках |
| 5 | Хук PreToolUse | правка вне зоны отклоняется в реальном `claude -p` |
| 6 | Плагин Claude Code | установка из git-маркетплейса во второй проект |
| 7 | MCP-сервер | этап запускается из чата Claude desktop |
| 8 | Пилот: 3–5 реальных задач | замер токенов/лимитов и числа пойманных пустых тестов |

## 12. Риски и открытые вопросы

- **Лимиты подписок.** Роли делят лимиты с обычной работой, параллельные
  прогоны быстрее в них упираются.
- **Правила подписки** ([Claude Code: Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
  devflow запускает **немодифицированный** бинарь `claude`, в который каждый
  пользователь входит **своей** подпиской через штатный вход Anthropic. Это
  разрешено. devflow никогда не читает, не хранит и не передаёт токены
  claude.ai. Запрещено: встраивать вход Claude.ai в своё приложение, гонять
  чужие запросы через свою подписку (общий сервер, CI для команды),
  перепродавать доступ. Лимиты Pro/Max рассчитаны на «обычное индивидуальное
  использование». Есть сторонние сообщения (не подтверждено) о том, что
  headless `claude -p` может расходовать отдельный пул лимитов. Проверить на пилоте.
  Для Codex/ChatGPT проверить аналогичные условия OpenAI.
- **Codex через локальный прокси.** У автора codex MCP ходит через
  `127.0.0.1:3456`. Для `codex exec` по подписке прокси не нужен, проверить.
- **Формат OpenSpec** меняется (классический workflow и OPSX). Защита: тест
  совместимости и фиксированная версия.
- **Сабагенты против отдельных процессов** для раннера `claude` (см. 8.2).
- **Стоимость.** Прогноз: на medium-задачу столько же или до 40% дешевле
  одной сессии Opus, выигрыш в качестве. Подтвердить пилотом.
