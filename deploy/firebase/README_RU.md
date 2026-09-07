# Firebase: исходники чат-сервиса

Этот каталог — проверяемый **source-ready пакет**. Его локальная сборка сама по
себе не доказывает работу облачного сервиса; текущие live-проверки указаны ниже.
Сборка и тесты не авторизуются в Firebase, не читают облачные ключи,
не вызывают LLM и не меняют адрес API в браузере. `stage-evidence.json` всегда
содержит `deployed: false` и `liveInferenceVerified: false`; отдельное live-evidence
создаётся только после фактической проверки владельцем.

## Состояние на 7 сентября 2026 года

В отдельном проекте `omnitwin-demo` (номер `679501553916`) активен сохранённый
владельцем платёжный аккаунт **My Billing Account**, необходимые API включены.
Firestore `(default)` создана в `europe-west1`, Native mode, с включённой защитой
от удаления. Клиентские deny-all rules развёрнуты; TTL
`demo_chat_state.expiresAt` подтверждён в состоянии ACTIVE.

Runtime identity — `omnitwin-chat-runtime@omnitwin-demo.iam.gserviceaccount.com`:
`roles/datastore.user` на этом проекте и `roles/secretmanager.secretAccessor`
отдельно на каждом из двух секретов, без project-wide secretAccessor.
У `OPENROUTER_API_KEY` и `SESSION_SIGNING_SECRET` версия 1 имеет состояние
ENABLED; значения переданы через memory-only REST, не через CLI debug logging.

Deploy функции подтверждён: **ACTIVE**, ревизия `chatapi-00001-sup`, Node 22,
256 MiB, CPU `0.1666`, min/max 0/2, concurrency 1. Runtime identity и ссылки на
обе secret versions 1 совпадают с конфигурацией. По явному решению владельца
только у Cloud Run сервиса `chatapi` включён `roles/run.invoker` для `allUsers`;
source policy обновлена до `invoker: public`. Ревизия не изменилась: старые
deploy metadata содержат первоначальный private invocation, но effective IAM
уже публичен, что подтверждено реальными запросами. Передеплой для этой смены
IAM не потребовался.

Владелец явно отказался от отдельного cap $5: существующий ключ с `limit: null`
сохранён. Баланс $8 и отсутствие автопополнения — **сообщение владельца**, не
независимая проверка настроек аккаунта. Ни лимит, ни настройки аккаунта, ни
автопополнение, ни сам ключ при включении не менялись.

Проверены Pages preflight 204, холодный `/session` 200 за 5294 мс и один `/chat`
200 за 4687 мс с `source: llm`, моделью `qwen/qwen3-235b-a22b-2507`.
Идентичный повтор дал 409 `already_processed`, без второго inference.
Четыре Firestore record содержат только `expiresAt`/`value`, без диалогов;
чужой Origin получил 403 без разрешающего CORS-заголовка. Ключи не передаются
браузеру. Pages/runtime config опубликован; реальная браузерная проверка
диалога прошла на desktop и mobile-размере. Подробности и ограничения ниже.
Подробный checkpoint: [статус миграции](../../docs/FIREBASE_MIGRATION_STATUS_RU.md).

## Локальная сборка

Из `deploy/firebase/`, с Node.js 22 и npm:

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run stage
```

Зависимости закреплены отдельным lockfile: `firebase-functions@7.3.2` и
`firebase-admin@14.3.0` (версии сверены через npm registry). Корневой npm проекта
не используется. Файлы `template/` — исходники; `functions/` — игнорируемый
генерируемый каталог. Вручную его не редактировать. `firebase.json` повторяет
allowlist-сборку перед deploy. Не запускать `npm install` внутри `functions/`:
локальные зависимости находятся уровнем выше, облачная сборка устанавливает
production dependencies из включённого lockfile.

В пакет попадают только семь модулей `config`, `handler`, `quota`, `sessions`,
`openrouter`, `firestore`, `firebase-http`, Firebase entrypoint/runtime/policy,
чистый генератор вымышленного профиля и утверждённый публичный manifest профилей.
SHA-256 профилей проверяется при сборке и при runtime-инициализации. YDB SDK,
metadata-auth, Yandex runtime, операторские скрипты, `.env`, ключи, тесты и
`node_modules` в исходный пакет не копируются. Неизвестный файл или ссылка
в staging останавливает сборку; сборщик ничего рекурсивно не удаляет.

Проверки включают импорт настоящего Firebase export с пустым окружением и
запрещённой сетью, ответ 503 без ключей, digest-gate профилей, ограниченный срок
инициализации, повтор после ошибки, отказ неизвестным файлам/ссылкам и декларации
rules/TTL. Это не заменяет проверку Firestore/IAM в облаке.

## Что разворачивает владелец

`chatApi` — HTTP Functions v2 функция с текущим `invoker: public`
в `europe-west1`: Node 22,
256 MiB, `cpu: gcf_gen1`, 0–2 экземпляра, concurrency 1, timeout 30 секунд.
Инициализация и запрос делят прикладной deadline 25 секунд. Import/discovery не
разрешает secrets и не инициализирует Admin SDK; ошибки не содержат SDK diagnostics.
Fractional CPU здесь намеренно отключает обработку нескольких одновременных
запросов одним экземпляром. [Настройки Firebase](https://firebase.google.com/docs/functions/manage-functions).

Проект, биллинг, регион Firestore и runtime service account уже выбраны и указаны
в checkpoint выше. Нельзя применять эти deny-all rules
к посторонней базе с действующими клиентами. Браузерных Firebase SDK, Analytics,
App Check или пользовательского Firebase Authentication этот пакет не добавляет.

Размещение двух секретов, завершение deploy и серверный LLM smoke подтверждены;
браузерный Pages→API acceptance пока не завершён.
Секреты имеют только имена `OPENROUTER_API_KEY` и `SESSION_SIGNING_SECRET`.
Повторно добавлять версии при продолжении этой миграции не нужно. Для будущих
согласованных операций требуется проверенная процедура REST, удерживающая auth
и значения только в памяти, без логирования request body, stdout, транскриптов
и debug-файлов.

Не использовать необследованные CLI-команды для переноса секретов: у проверенной
Firebase CLI 15.29.0 JSON-вывод списка login включает credentials, а путь
добавления версии секрета может отправлять request body в debug logger.
Этот README намеренно не предлагает команды `functions:secrets:set` или
`functions:secrets:access`; факт интерактивного ввода сам по себе не доказывает
отсутствие записи значения в лог. Не выводить полный auth/API response.

Не помещать значения в аргументы команд, Git, `.env`, логи, screenshots или чат.
Session secret — независимо созданный
криптографически случайный секрет не менее 32 байт. Для текущей демонстрации
используется существующий OpenRouter-ключ без отдельного cap по явному решению
владельца. Сообщённые владельцем $8 предоплаты и отсутствие автопополнения не
превращаются в обещание абсолютного ограничения облачного счёта. Самостоятельно
менять настройки аккаунта или устанавливать лимит нельзя.
Secret params явно привязаны только к `chatApi`; после смены версии требуется
передеплой. [Приватные секреты Firebase](https://firebase.google.com/docs/functions/config-env).

### Ограниченный helper приватных секретов

`scripts/private-secrets.mjs` — импортируемая операторская библиотека, не CLI и
не часть развёртываемого Functions package. `createPrivateSecretsOperator`
принимает `accessToken` и доверенный `fetchImpl` только из приватного состояния
памяти вызывающего процесса. Проект и его номер жёстко ограничены указанной
демонстрацией; разрешены только два имени секретов.

- `inspectSecret(name)` читает только metadata и список версий, не значение
  секрета. Наличие версии требует отдельной проверки её состояния.
- `ensureOpenRouterKey(value)` использует существующий ключ, переданный приватно
  в памяти; `ensureSessionSigningSecret()` генерирует независимый случайный
  signing secret внутри helper. Оба метода отказываются добавлять версию, если
  любая версия уже существует, включая DISABLED/DESTROYED.
- Перед любой разрешённой записью вызывающая сторона сохраняет долговечный
  **несекретный** marker попытки. Работает только один оператор. При неизвестном
  исходе нельзя автоматически повторять операцию или перезапускать её в новом
  процессе: сначала сверить marker и metadata. Внутрипроцессный guard не заменяет
  защиту от повторного запуска и eventual consistency списка версий.
- Разрешено показывать только ограниченный результат (`status`, имя, versionId,
  `needsVerification`); нельзя показывать объект оператора, fetch options,
  auth/API response или значения. Helper не читает значения секретов, не пишет
  файлы и не использует CLI; memory-only не гарантирует стирания неизменяемых
  JavaScript-строк или отсутствия данных в crash dump.

Текущие версии 1 уже созданы: для этого checkpoint допустима сверка metadata,
а не повторный `ensure*`. Ротация существующих версий не входит в этот helper.

Для будущих согласованных обновлений — отдельные операторские шаги после сверки
фактического состояния, не выполняемые сборщиком. Текущий deploy уже завершён;
повторять его только ради уже применённой IAM-смены не требуется:

```text
firebase deploy --only firestore:rules,firestore:indexes --project omnitwin-demo
firebase deploy --only functions:demo-chat --project omnitwin-demo
```

Этот selector разворачивает единственный локальный codebase `demo-chat`,
экспортирующий только `chatApi`; посторонние codebases не входят в него.
[Изоляция codebases](https://firebase.google.com/docs/functions/organize-functions).
Проверить эффективные runtime IAM-права к Firestore и только двум secrets.
Admin SDK использует ADC service identity и **обходит Firestore Security Rules**;
`allow read, write: if false` запрещает именно клиентский доступ, не заменяя IAM.
[Граница Rules/IAM](https://firebase.google.com/docs/firestore/security/get-started).

## Квоты, хранение и расходы

Коллекция `demo_chat_state` хранит только счётчики, хешированные идентификаторы,
SHA-256 fingerprint запроса, status и `expiresAt` типа Timestamp. Тексты запросов,
ответов, история, raw IP, биографии и секреты приложением не сохраняются и не
логируются. Платформа может хранить служебные HTTP-метаданные; не включать body
logging и ограничить доступ/срок хранения. OpenRouter и выбранный провайдер
получают отправленный пользователем текст — это не обещание нулевого retention.

Транзакция резервирует максимум 6 попыток в минуту и 30 в UTC-сутки на сессию,
100 в UTC-сутки глобально до вызова LLM. Вызов LLM не находится внутри повторяемой
транзакции. Ошибочные/неопределённые попытки не возвращают квоту; in-memory
fallback отсутствует. Повтор того же requestId не запускает повторный inference
в пределах действующего 48-часового idempotency record.

`firestore.indexes.json` включает TTL `demo_chat_state.expiresAt` без индекса
поля. Очистка асинхронна, а срок действия проверяется кодом независимо от неё.
TTL уже подтверждён ACTIVE в текущем checkpoint; после будущих изменений его
состояние сверяется снова. TTL-удаления тарифицируются.
[Поведение TTL](https://firebase.google.com/docs/firestore/ttl).

Единственный origin — `https://arseniy24rus.github.io`, без path. CORS и HMAC
сессия не являются аутентификацией посетителя: вне браузера Origin подделывается.
Проверка body 8192 байта действует до JSON parsing и quota/provider work нашего
кода; Functions framework уже мог прочитать/разобрать тело до обработчика.

`minInstances:0`, maxInstances 2 и 100 LLM попыток/сутки **не являются абсолютным
лимитом облачного счёта**. Остаются расходы функций, запросов Firestore, TTL,
Secret Manager, логов, сборок и артефактов, включая отклонённый трафик. Нужны
бюджетные уведомления и операторский способ отключить endpoint; бесплатность
не гарантируется.

Локальный `npm audit --omit=dev --audit-level=high` на 2026-09-07: 0 high/critical,
7 moderate dependency paths, связанные с `uuid<11.1.1`
([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)).
Автоматическое major-downgrade Firebase SDK или непроверенный transitive override
не применялись. Этот остаточный dependency risk должен учитываться при release;
lockfile не означает отсутствие уязвимостей. Последний подтверждённый прогон:
48 серверных и 20 Firebase тестов на Node 24.19. Production manifest требует
Node 22; реальный холодный `/session` уже проверен за 5294 мс. Локальный Express → настоящий
Firebase `onRequest` smoke проверил HTTP-контракт с тестовой конфигурацией, без
облачных обращений и реальных ключей; это не live-инференс.

## Проверка публичного интерфейса

Лимит $5 не является текущим gate: владелец явно разрешил режим без cap.
Effective invocation публичен, серверный LLM smoke и последовательный повтор
requestId уже проверены. API `https://chatapi-avypjak2xq-ew.a.run.app` использует
суффиксы `/session` и `/chat`; секреты остаются только на сервере.

Публикация подтверждена: Pages commit `ca1d377`, workflow `34151483986` success.
Реальный headed Playwright прошёл открытие профиля и один LLM-диалог на каждом
из двух размеров: desktop 1920×1080 и mobile 390×844, последовательно одним worker.
Настоящие API и responses без подмены: HTTP 200, `source: llm`, ответ виден без
маркировки локальной демореплики; browser errors/warnings отсутствуют.
После desktop reload выбор человека сохранился без нового inference.
Все PNG открыты; after-кадры приняты. Единичные ответы заняли 2,7/2,1 с —
это smoke-замеры, не гарантия задержки. Физический телефон не проверялся.
Серверная проверка Origin не заменяет этот браузерный CORS. Последовательный repeat
409 не является concurrent/load test; производительность под нагрузкой не
заявляется. `/session` 200 сам по себе не проверяет Firestore, но уже выполненный
`/chat` прошёл квоту и сохранил только служебные записи.

Если вкладка была открыта до публикации, обновить её: runtime config хранится
в памяти модуля. Старые scripted-only e2e предполагают отключённый API и не
должны автоматически расходовать реальные токены. Ключевые команды проверки:
`node --test --test-concurrency=1 tests/*.test.mjs` в Firebase package и
`npm test` из корня frontend; отдельный временный live Playwright script
использовал реальные `page.goto`, `getByRole().click`, `waitForResponse`,
`reload`, `screenshot`, без `page.route`, HAR или записи sessionToken.
Персонажи остаются вымышленными; ответы
LLM не являются наблюдениями или научной валидацией модели.
