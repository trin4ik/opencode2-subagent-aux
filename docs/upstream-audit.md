# Сверка с OpenCode V2

## OpenCode 2.0.12 — 2026-09-22

Целевой release commit: `2670273ff17da96f85c5826ced57aa1b368754fa`. Зависимости `@opencode/plugin`,
`@opencode/schema` и `@opencode/client` закреплены на 2.0.12; Effect остаётся 4.0.0-rc.112.
Штатный subagent, `session.move`, публичный Effect Session API и профильные session events побайтно
совпадают с уже проверенной реализацией 2.0.8. Runtime version guard не добавляется.

## Label / durable RPC — 2026-09-18, перепроверено на 2.0.12

Для согласованного `label?: string | null` проверен точный commit OpenCode 2.0.12:
`2670273ff17da96f85c5826ced57aa1b368754fa`.

- [Tool.Progress](https://github.com/anomalyco/opencode/blob/2670273ff17da96f85c5826ced57aa1b368754fa/packages/schema/src/session-event.ts#L513-L520)
  ephemeral. [Message updater](https://github.com/anomalyco/opencode/blob/2670273ff17da96f85c5826ced57aa1b368754fa/packages/core/src/session/message-updater.ts#L322-L376)
  сохраняет input сразу, но metadata child — лишь при terminal. Parent messages не обеспечивают cold attach во время foreground.
- [Plugin storage](https://github.com/anomalyco/opencode/blob/2670273ff17da96f85c5826ced57aa1b368754fa/packages/core/src/plugin/host.ts#L584-L609)
  имеет namespace по plugin ID, общий для всех Location одной БД OpenCode. Move не требует переноса журнала.
- RPC registrations относятся к Location; [HTTP handler](https://github.com/anomalyco/opencode/blob/2670273ff17da96f85c5826ced57aa1b368754fa/packages/server/src/handlers/rpc.ts#L8-L14)
  ожидает активацию плагинов. Публичный контракт: [RPC API](https://opencode.ai/v2/docs/build/plugins/rpc).

`trin4ik.subagent-labels.list({ sessionID })` возвращает `{ changes }`; событие `changed` содержит одну запись:
`{ id, sessionID, parentSessionID, at, label, afterIdle? }`. Input/output описаны JSON Schema в `src/rpc.ts`;
копия переносимого контракта в TUI сверяется smoke совместно установленных tarball.

Каждый explicit string/null записывается отдельным ключом `label.v1/<child>/<parent>/<message>/<call>`;
сегменты экранируются. Omission не создаёт запись. ID — составной parent/message/call; повтор сохраняет исходную запись.
Порядок: directory placement → durable label → уведомление/штатный progress → prompt. Сбой до записи ничего не меняет,
после commit отката нет. Сбой ephemeral уведомления логируется; durable чтение остаётся источником восстановления.

`at` — серверное время применения. `afterIdle` — последний известный idle ребёнка, не execution ID.
Публичный API не предоставляет атомарный current-execution anchor: session.get и запись не атомарны с завершением child.
Одинаковые миллисекунды разрешаются стабильным порядком ID; конкурирующим внешним управляющим не обещается атомарность.
Новых busy-запретов/сериализации нет. Закрытые Run в TUI ограничивают применимые изменения своим временем завершения.

Smoke дополнен строкой/null/omission, чтением RPC до завершения foreground-вызова, live-событием,
afterIdle, сохранённым raw input и совместной работой label+directory.

## OpenCode 2.0.8 и удаление version guard — 2026-09-18

По явному решению пользователя удалены `supportedVersion` и сравнение с `ctx.app.version`.
Новый номер хоста сам по себе больше не запрещает загрузку; version allowlist не применяется.
Зависимости остаются pinned на 2.0.7 / Effect 4.0.0-rc.112 для воспроизводимости.

Точный commit 2.0.8: `7673ed6bd6547ee0dcb81aab55f1392fb751d652`. С релизом 2.0.7 побайтно совпадают:

- [Штатный subagent](https://github.com/anomalyco/opencode/blob/7673ed6bd6547ee0dcb81aab55f1392fb751d652/packages/core/src/tool/plugin/subagent.ts#L200-L213), включая ожидаемый progress перед prompt.
- [Session move](https://github.com/anomalyco/opencode/blob/7673ed6bd6547ee0dcb81aab55f1392fb751d652/packages/core/src/session/move.ts).
- [Session implementation](https://github.com/anomalyco/opencode/blob/7673ed6bd6547ee0dcb81aab55f1392fb751d652/packages/core/src/session/session.ts).
- [Публичный Effect Session API](https://github.com/anomalyco/opencode/blob/7673ed6bd6547ee0dcb81aab55f1392fb751d652/packages/plugin/src/effect/session.ts).

После удаления guard прошли `npm run check`, `npm run format:check` и существующий `npm test`
с `OPENCODE_BIN`, указывающим на изолированный бинарник `@opencode/cli-linux-x64@2.0.8`.
Smoke установил tarball плагина, подтвердил статус active и все четыре сценария:
native default, native `model#variant`, относительный `directory`, абсолютный `directory` вместе с моделью.
Первый запрос ребёнка получил инструкции, скилл и агента назначения; относительное чтение и загрузка скилла
выполнились там же. Использовались изолированные config/data/home и локальный провайдер.

Проверки реального контракта инструмента, включая конфликт собственного `directory` со штатной схемой,
сохраняются. Ниже — исторические состояния плагина на момент предыдущих аудитов.

## OpenCode 2.0.7 — 2026-09-18

Целевой commit `ca27d3328fcd0d470588149c902a963452f1abaf`. Точные `subagent.ts` и `session/move.ts`
совпадают с проверенными для 2.0.5; native schema уже содержит `model`, но не `directory`.
Directory-only wrapper сохраняет native policy и ожидаемый progress → move → prompt.
При миграции зависимости и точный runtime guard были переведены на 2.0.7. Подготовка 2.0.5 ниже была проверена изолированно,
но её внедрение пользователь отменил; фактическая миграция плагина — с 0.2.0 на 0.3.0 под 2.0.7.
HTTP-диагностика использует `/api/info`, а не удалённый `/api/health`.

## OpenCode 2.0.5 — 2026-09-17

Целевой commit: `79169fe966d58fb0e0a5e41133716184a0ab4ca6`. Плагин версии 0.3.0 добавляет только `directory`.
Собственные model/effort, `selection.ts`, обращения к удалённому `ctx.catalog` и переключение модели удалены.
Штатный `model: provider/model#variant` проходит через wrapper без изменений; его schema и политика принадлежат Core.

- [subagent.ts:200–213](https://github.com/anomalyco/opencode/blob/79169fe966d58fb0e0a5e41133716184a0ab4ca6/packages/core/src/tool/plugin/subagent.ts#L200-L213):
  ожидаемый `progress` по-прежнему предшествует prompt, включая продолжение child.
- [subagent.ts:75–98](https://github.com/anomalyco/opencode/blob/79169fe966d58fb0e0a5e41133716184a0ab4ca6/packages/core/src/tool/plugin/subagent.ts#L75-L98):
  native override проверяется по моделям вызывающей Location до переноса. Каталог назначения не подменяется.
- [session/move.ts](https://github.com/anomalyco/opencode/blob/79169fe966d58fb0e0a5e41133716184a0ab4ca6/packages/core/src/session/move.ts):
  сохранены очередь control и wake; требуется подтверждать директорию, а не ждать общего idle.
- [Effect context](https://github.com/anomalyco/opencode/blob/79169fe966d58fb0e0a5e41133716184a0ab4ca6/packages/plugin/src/effect/plugin.ts):
  `catalog` заменён доменами `provider`/`model`; directory-only плагину они не нужны.

Зависимости pinned на 2.0.5, Effect остаётся 4.0.0-rc.112. Проверка `supportedVersion` включена для 2.0.5.
В smoke удалён `plugin.awaitActivation`; применяется клиент 2.0.5, знающий новый experimental HTTP-путь wait.
Сохранён один интеграционный smoke с tarball и четырьмя короткими вызовами, включая native model passthrough.

## Исторический аудит beta-19381

Следующие разделы описывают прежнюю реализацию с model/effort, заменённую directory-only в 0.3.0.

Аудит выполнен 2026-09-09 субагентом `openai/gpt-5.6-sol#medium` и проверен при исправлении кода.
Целевая версия: `0.0.0-beta-19381`, commit `d461154a8d2b24c4ad24a89b589069cf08ab168c`.

## Источники

- [Разработка плагинов V2](https://opencode.ai/v2/docs/build/plugins/)
- [Effect plugin API](https://opencode.ai/v2/docs/build/plugins/effect/)
- [Загрузка плагинов](https://opencode.ai/v2/docs/plugins/)
- [CONTRIBUTING.md](https://github.com/anomalyco/opencode/blob/d461154a8d2b24c4ad24a89b589069cf08ab168c/CONTRIBUTING.md)
- [Upstream style guide](https://github.com/anomalyco/opencode/blob/d461154a8d2b24c4ad24a89b589069cf08ab168c/AGENTS.md)
- [Core tool architecture и error policy](https://github.com/anomalyco/opencode/blob/d461154a8d2b24c4ad24a89b589069cf08ab168c/packages/core/src/tool/AGENTS.md)
- [Точный штатный subagent.ts](https://github.com/anomalyco/opencode/blob/d461154a8d2b24c4ad24a89b589069cf08ab168c/packages/core/src/tool/plugin/subagent.ts)

Документация плагинов задаёт публичный контракт. `CONTRIBUTING.md` и `AGENTS.md`
описывают работу внутри upstream-репозитория; его PR-процедуры и монорепозиторные
команды не являются дополнительными требованиями к внешнему npm-плагину.

## Контракт и принятые conventions

| Область                                 | Реализация                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Default export с `id` и `effect`        | `Plugin.define` в `src/index.ts`.                                                                            |
| Публичные API и совместимые зависимости | `@opencode/plugin`, `@opencode/schema`, `effect`; Core не импортируется.                                     |
| Синхронный transform                    | `ctx.tool.transform` только собирает новое определение инструмента.                                          |
| Замена вложенной schema целиком         | `tool.input = extended.input`.                                                                               |
| Lifecycle                               | Registration принадлежит plugin scope; отдельный disposer не нужен.                                          |
| Проверка установленного пакета          | Интеграционный тест использует `npm pack` и отдельную установку tarball.                                     |
| Code style                              | Prettier 3.6.2, `semi: false`, `printWidth: 120`, как в проверенном upstream.                                |
| Effect style                            | Именованные `Effect.fn`, синхронная чистая логика выбора отдельно от эффектов, Schema на границах.           |
| Error policy                            | Штатные defects/interruption не превращаются в ошибки модели; собственные failures помечены отдельным типом. |
| Совместимость исполнения                | Проверка точной runtime-версии и smoke старого/нового вызова на реальном OpenCode.                           |

`private: true` допустим для текущей локальной установки. Перед публикацией npm-пакета
нужно отдельно подготовить release metadata и убрать этот флаг.

## Что означает «оригинал + добавки»

`src/subagent.ts` является обёрткой над уже зарегистрированным штатным executor.
Он не является текстовой копией Core-файла. Вся штатная orchestration выполняется
самим оригинальным кодом: permissions, глубина, владение child, agent switch,
создание сессии, jobs/recovery, background, уведомления и отмена.

Наши добавки:

1. Три необязательных аргумента: `model`, `effort`, `directory`, и описание их использования.
2. Проверка пути и модели/variant до вызова штатного executor; при указанном назначении каталог моделей берётся оттуда.
3. `session.move` и подтверждение фактической директории, затем `session.switchModel` внутри invocation-local `progress` до отправки prompt.

При отсутствии новых аргументов возвращается непосредственно штатный Effect.
При наличии overrides возвращается тот же объект результата без дополнительной metadata.

Буквальная копия Core-файла требует приватных `Session.Service`, `Job.Service`,
`Permission.Service`, `Config.Service`, `Agent.Service`, `SubagentJob` и
`SubagentCompletion`. Публичный plugin context этих сервисов не предоставляет.
Для минимального текстового diff поддерживаемый путь — изменение самого OpenCode Core
или добавление туда публичного invocation-local before-child-prompt hook.

## Исправленная регрессия

Прежний blanket `Effect.catchDefect` превращал любой defect штатного executor в
`Tool.Error`. Это ломало намеренную передачу `Permission.DeclinedError` через defect:
обычный отказ пользователя мог стать видимой модели ошибкой и продолжить её работу.

Теперь только failures нашего progress adapter помечаются `OverrideFailure` и
переводятся обратно в typed error. Остальные defects повторно передаются через
`Effect.die` без замены объекта; interruption не перехватывается.
При исправлении регрессия была проверена на настоящем `ask → reject` с feedback и
без него. По согласованному объёму постоянный тестовый набор сокращён до одного
smoke: установка плагина и создание субагентов старым и расширенными вызовами.

## Directory: проверка 2026-09-09

Плагин переименован в `opencode2-subagent-aux`, ID — `trin4ik.subagent-aux`.
Проверены исходники того же commit:

- [session/move.ts](https://github.com/anomalyco/opencode/blob/d461154a8d2b24c4ad24a89b589069cf08ab168c/packages/core/src/session/move.ts):
  `move` проверяет назначение, ставит control в inbox и будит обработчик; не ждёт применения переноса.
- [session/runner/llm.ts](https://github.com/anomalyco/opencode/blob/d461154a8d2b24c4ad24a89b589069cf08ab168c/packages/core/src/session/runner/llm.ts):
  control обрабатывается на границе шага; `Moved` заставляет обработчик войти в новое location.
- [session/context.ts](https://github.com/anomalyco/opencode/blob/d461154a8d2b24c4ad24a89b589069cf08ab168c/packages/core/src/session/context.ts):
  агент заново разрешается по сохранённому ID в новом location вместе с tools и инструкциями.
- [session/session.ts](https://github.com/anomalyco/opencode/blob/d461154a8d2b24c4ad24a89b589069cf08ab168c/packages/core/src/session/session.ts):
  `wait` ожидает общий idle и не подходит для подтверждения одного переноса работающей сессии.

Обёртка читает `session.get().location.directory` каждые 50 мс, до совпадения с нормализованным
назначением, с лимитом две минуты и сохранением Effect interruption. Только после подтверждения
штатный executor получает управление для отправки нового задания. Рабочая директория родителя не меняется.
Занятость ребёнка не запрещает перенос; отдельная сериализация конкурирующих вызовов не добавляется.
Автоматического отката нет, queued move после таймаута может примениться позже.

Разовый стенд в `/tmp/opencode/subagent-aux-stage` использовал копию плагина, настоящий сервер
beta-19381, установку tarball и локальный детерминированный провайдер. Проверены:

- старый вызов, отдельные `model/effort`, отдельный `directory`, совместное применение;
- локальный `AGENTS.md`, доступность скилла и переопределение агента в назначении;
- перенос существующего ребёнка в соседний каталог вне исходного проекта с сохранением истории;
- перенос работающего ребёнка: ответ провайдера удерживался, API inbox подтверждал queued move
  и отсутствие нового задания; после освобождения ответа перенос и новое задание завершились успешно;
- ошибка отсутствующего каталога без смены расположения ребёнка.

В постоянном единственном smoke оставлены четыре коротких вызова. Для directory проверяются
первый outgoing request с локальными инструкциями/скиллом/агентом, относительное чтение файла
и фактическая загрузка скилла. Разовая диагностика продолжения не добавлена в постоянную матрицу.
