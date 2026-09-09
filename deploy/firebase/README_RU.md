# Firebase: исходники чат-сервиса

Этот каталог — проверяемый **source-ready пакет**. Его локальная сборка сама по
себе не доказывает работу облачного сервиса; текущие live-проверки указаны ниже.
Сборка и тесты не авторизуются в Firebase, не читают облачные ключи,
не вызывают LLM и не меняют адрес API в браузере. `stage-evidence.json` всегда
содержит `deployed: false` и `liveInferenceVerified: false`; отдельное live-evidence
создаётся только после фактической проверки владельцем.

## Обновление на 9 сентября 2026 года

V2 backend активирован: `chatapi-00002-zup`, `ACTIVE/GEN_2`, весь traffic на
новой ревизии, activation SHA
`35319bb7b4068e6b7e8c281f6eb45ec70ca2be80c83c516460160f226938cbf9`.
Read-back до/после подтвердил сохранение Node 22, 256 MiB, CPU `0.1666`, timeout
30 секунд, min/max 0/2, concurrency 1, service identity, ingress и обеих secret
version references 1. Значения секретов не читались и не менялись.

Две live проверки `/chat` — legacy и V2 — прошли: HTTP 200, `source:llm`,
модель `qwen/qwen3-235b-a22b-2507`, канонические имя/занятие и контекст
`baseline/2026/10:00` совпали с pinned offline resolver. Запросов было ровно
два, без повторов; чужой Origin отклонён. Это серверный smoke, не полноценная
проверка новой Pages-версии. [Evidence](../../docs/evidence/firebase-live-activation-20260909.json)
сохраняет исходные SHA и границы утверждений; [процедура активации](CITY_ACTIVATION_RU.md)
описывает отдельные deployment/read-back/browser gates.

CLI после успешного обновления функции завершился с кодом 1. Вероятная причина
— отсутствующая cleanup policy `gcf-artifacts`: metadata показала 0 policies
без opt-out, а точная noninteractive-ветка CLI воспроизведена офлайн. Сырой текст
ошибки не сохранялся, поэтому причина остаётся выводом из этих свидетельств.
Read-back новой ревизии и обе проверки API прошли независимо; повторного deploy,
изменения cleanup policy, секретов или IAM для исправления exit code не было.

## Историческое состояние на 7 сентября 2026 года

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

В пакет попадают только восемь модулей `config`, `handler`, `quota`, `sessions`,
`openrouter`, `firestore`, `firebase-http`, `population-resolver`, Firebase
entrypoint/runtime/policy, общие чистые profile/population/spatial модули и
утверждённый публичный legacy manifest профилей.
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

Размещение двух секретов, завершение deploy и серверный LLM smoke подтверждены.
Исторический Pages→API acceptance 7 сентября описан ниже; для новой версии
9 сентября публичная браузерная проверка фиксируется отдельно от серверного smoke.
Секреты имеют только имена `OPENROUTER_API_KEY` и `SESSION_SIGNING_SECRET`.
Повторно добавлять версии при продолжении этой миграции не нужно. Для будущих
согласованных операций требуется проверенная процедура REST, удерживающая auth
и значения только в памяти, без логирования request body, stdout, транскриптов
и debug-файлов.

Не использовать необследованные CLI-команды для переноса секретов: у проверенной
Firebase CLI 15.29.0 JSON-вывод списка login включает credentials, а путь
добавления версии секрета может отправлять request body в debug logger.
Даже обычный deploy без `--debug` открывает debug-файл; при OAuth fetch error
туда может попасть тело refresh-запроса. Обновление 9 сентября выполнено через
проверенную обёртку штатного CLI: файловый/debug logger отключён до импорта,
вывод ограничен фиксированными статусами, auth/permission gates не заменены.
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

## Канонические V2-профили — контракт и подтверждённый серверный smoke

Allowlist теперь также включает `src/population-resolver.mjs` и точные копии
`shared/demo-population/index.mjs`, `spatial.mjs` в `data/demo-population/`.
Старый утверждённый manifest профилей остаётся в пакете для legacy datasetId.
Данные миллиона жителей **не** загружаются целиком в память и **не** создаются
как документы Firestore: база по-прежнему хранит только квоты/idempotency.

V2 теперь включается только через проверяемый **несекретный** файл
`city-activation.json`. По умолчанию `v2:null` сохраняет legacy. После проверки
frontend и immutable Storage assets оператор явно записывает сразу четыре pins;
staging помещает их в `approved-city-assets.mjs` внутри той же Functions-ревизии.
Локальные или оставшиеся облачные `V2_*` env не активируют и не переопределяют
пакет. Частичный tuple, чужой проект/bucket, смешанные pack-prefix и некорректные
SHA отклоняются до staging. Predeploy проверяет выбранный `GCLOUD_PROJECT`;
runtime также отказывает в постороннем проекте до чтения secret bindings.

Разрешены только пути `demo-v2/manifest.json` и `demo-v2/spatial/manifest.json`
в `https://storage.googleapis.com/omnitwin-demo-city-assets/packs/<bundleSHA>/`,
**не Pages**. SHA — от точных опубликованных JSON-байтов. `/session` ничего из V2
не скачивает. Конфигурация, команды preview/write/deploy, проверка ревизии и
rollback описаны в [CITY_ACTIVATION_RU.md](CITY_ACTIVATION_RU.md). Source-ready
механизм и успешный read-back labels не заменяют live V2 chat gate.

Сервер после проверки сессии и структуры `/chat` принимает только datasetId,
personId (`demo2-p-` и семь цифр), сценарий, год и визуальное время. Он проверяет
SHA обоих manifests, связь пространственного пакета с population/geography и
версиями общих модулей; затем лениво проверяет person/household/target shards,
обратные связи домохозяйства и членство в выбранном году/сценарии. Профиль
вычисляет тот же `profileFor`, присутствие — тот же `presenceFor`, что у клиента.
Клиентские биография, присутствие, URL и инструкции в запросе запрещены.
Пути поездки/адреса не выводятся из одних endpoint-индексов.

LRU ограничен 32 shards / 8 MiB бинарных данных; manifests — 2 MiB каждый,
shards — 2 MiB каждый. Одна резолюция ограничена 32 загрузками / 12 MiB,
10 секундами и двумя параллельными резолюциями на экземпляр. Общий deadline
запроса остаётся 25 секунд; лимиты памяти не описывают весь Node-процесс и
сохранённый legacy manifest. Ошибка данных даёт безопасный
`profile_unavailable` до платного inference; неизвестный/неактивный персонаж —
`invalid_input`. В fingerprint включена соответствующая ревизия данных/codec.

До любого V2 manifest/shard I/O существующая транзакционная квота резервирует
попытку по известному локально pinned fingerprint. Исчерпанная квота, повтор
requestId или сбой Firestore не вызывают загрузку профиля. После синтаксической
проверки неизвестный/неактивный V2-ID или ошибка assets расходуют эту попытку,
без inference и без возврата; повтор не скачивает данные снова. Значения
6/30/100 остаются прежними. Это одобренная смена порядка admission для V2,
а не новая квота или изменение старого локального legacy validation.

Проверки исходников сами по себе не доказывают live V2-работу. Для ревизии
`chatapi-00002-zup` отдельные read-back и два серверных live запроса подтверждены
evidence от 9 сентября выше; это не заменяет frontend→Firebase gate новой Pages
версии. Обновление сохранило secret version references, существующий
OpenRouter-ключ, модели, Firestore-квоты, concurrency и endpoint. Настройки
OpenRouter-аккаунта, включая ранее согласованный `limit: null`, в ходе обновления
не менялись и заново не запрашивались. Исторические receipts остаются историческими;
локальный `stage-evidence.json` по-прежнему не является live receipt.
