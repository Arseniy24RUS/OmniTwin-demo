# Явная активация V2 в Firebase

Это процедура для владельца **после** visual gate и публикации проверенного
immutable-пакета. Она не изменяет секреты, их версии, OpenRouter key/caps/models,
квоты 6/30/100, Firestore, service identity, runtime memory/scaling или endpoint.
Локальный `city-activation.json` подготовлен для проверенного публичного V2-пакета
`ce6d7497828079f55a2c74f45d95f3bdcffffdae5d24163e31e7051ce7199abe`.
Нормализованный activation SHA:
`35319bb7b4068e6b7e8c281f6eb45ec70ca2be80c83c516460160f226938cbf9`.
9 сентября 2026 года функция обновлена с `chatapi-00001-sup` до
`chatapi-00002-zup`. Read-back в 14:10:27 UTC подтвердил `ACTIVE`, `GEN_2`,
этот activation SHA и весь traffic на latest revision. Две разрешённые live
проверки legacy/V2 завершились успешно в 14:12:19 UTC. Подробные результаты и
SHA исходных receipts: [переносимое evidence](../../docs/evidence/firebase-live-activation-20260909.json).

Сохранились Node 22, 256 MiB, CPU `0.1666`, timeout 30 секунд, min/max 0/2,
concurrency 1, service identity, ingress `ALLOW_ALL` и ссылки на версии 1
обоих секретов. Значения секретов при read-back не читались. Оба `/chat` дали
HTTP 200, `source:llm` и разрешённую модель `qwen/qwen3-235b-a22b-2507`;
имя, занятие и контекст `baseline/2026/10:00` совпали с каноническими
профилями из проверенного локального resolver. Запросов `/chat` было ровно
два, без retry/replay; чужой Origin отклонён. Это bounded behavioral smoke,
не криптографическая аттестация личности и не проверка всех персонажей.

Штатный CLI 15.29.0 после `Successful update` завершился с кодом 1.
Исходное сообщение намеренно не сохранено фильтром безопасного вывода.
Наиболее вероятная причина — последующая проверка очистки build-артефактов:
metadata `gcf-artifacts` показала 0 cleanup policies и отсутствие opt-out,
а точная ветка CLI с `--non-interactive` воспроизведена офлайн с exit 1.
Причина классифицирована по исходникам и metadata, а не по утраченному
сообщению. Повторного deploy, `--force`, изменения cleanup policy или IAM
не выполнялось. Успех обновления подтверждает отдельный read-back новой
ревизии, а не код завершения CLI. Этот checkpoint относится к API;
публикация Pages и браузерная проверка новой версии остаются отдельными gates.

## Контракт и граница доверия

Единственный источник deployment pins — `city-activation.json`, версия 1,
`projectId:omnitwin-demo`. `v2` — либо `null`, либо объект ровно из четырёх ключей:

```text
V2_POPULATION_MANIFEST_URL
V2_POPULATION_MANIFEST_SHA256
V2_SPATIAL_MANIFEST_URL
V2_SPATIAL_MANIFEST_SHA256
```

Оба URL принадлежат одному exact prefix
`https://storage.googleapis.com/omnitwin-demo-city-assets/packs/<64 lowercase hex>/`;
пути — `demo-v2/manifest.json` и `demo-v2/spatial/manifest.json`. SHA содержат
ровно 64 lowercase hex символа. Credentials, query, fragment, другой project,
bucket, port, неканонический URL, лишние ключи и частичный tuple запрещены.

Staging валидирует конфигурацию и создаёт `approved-city-assets.mjs` с полным
tuple либо пустым объектом. Firebase template использует этот модуль, а не
`process.env.V2_*`. Старый утверждённый legacy manifest остаётся в пакете в
обоих режимах. В `stage-evidence.json` сохраняются только публичные pins, mode,
activation hash, labels и хеши файлов; `deployed:false` остаётся неизменным.
Нельзя редактировать generated `functions/` вручную.

Хеш конфигурации вычисляется из канонически упорядоченного валидированного
объекта, не из его форматирования. Firebase labels `omnitwin-city-mode`,
`omnitwin-city-pin-a` и `omnitwin-city-pin-b` переносят mode и две половины SHA
в metadata той же функции; разделение сохраняет предел длины label 63 символа.
Это проверка согласованности конфигурации, а не криптографическая аттестация
исполняющегося кода и не доказательство доступности assets/LLM.

## 1. Зафиксировать проверенные исходники и опубликованный pack

Из корня репозитория, локально, без inference:

```powershell
node server/chat/scripts/verify-population.mjs
node --test --test-concurrency=1 server/chat/test/*.test.mjs
node tools/publish-firebase-city-assets.mjs
```

Использовать SHA из свежего dry-run/успешного upload receipt и фактических
публичных байтов, не перепечатывать старые hashes из отчётов. Uploader описан в
[отдельной инструкции](../../tools/PUBLISH_FIREBASE_CITY_ASSETS_RU.md).
Проверить публичное чтение/CORS и оба gzip-представления; upload receipt с
`publicReady:false` сам по себе недостаточен. Изменение codecs/manifests после
этой проверки требует повторного freeze, verifier и согласования pins.

## 2. Явно записать полный несекретный tuple

Дальнейшие команды — из `deploy/firebase/`. Значения ниже — **placeholders**;
подставляются только из проверенного пакета. Не подставлять сюда credentials.

```powershell
$cityArgs = @(
  '--project', 'omnitwin-demo',
  '--pack-base-url', 'https://storage.googleapis.com/omnitwin-demo-city-assets/packs/<BUNDLE_SHA>/',
  '--population-sha256', '<POPULATION_MANIFEST_SHA>',
  '--spatial-sha256', '<SPATIAL_MANIFEST_SHA>'
)
$cityPreview = node scripts/configure-city.mjs @cityArgs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'City activation preview failed' }
$cityPreview
```

Preview ничего не пишет и не обращается к сети. Владелец сверяет оба exact URL,
SHA, project и next hash. Только после этой сверки:

```powershell
node scripts/configure-city.mjs @cityArgs --write --expect-current $cityPreview.currentActivationSha256
if ($LASTEXITCODE -ne 0) { throw 'City activation write failed' }
git diff -- city-activation.json
node --test --test-concurrency=1 tests/*.test.mjs
npm run stage
```

`--write` требует hash прежней конфигурации из preview, отказывает при её
изменении и заменяет только один обычный JSON-файл через временный файл в том
же каталоге. Symlink/junction-пути запрещены. Использовать одного оператора;
не менять исходники между stage, deploy и read-back. Файл не содержит секретов
и пригоден для Git-review. Никакой deploy/активации Pages эта команда не делает.

## 3. Развернуть только существующий chat codebase

После разрешения владельца, с уже существующей авторизацией CLI, проверенная
обёртка передаёт штатному CLI только эту команду и точный каталог проекта:

```powershell
firebase deploy --only functions:demo-chat --project omnitwin-demo --non-interactive
```

Команда выше описывает selector; для CLI 15.29.0 её не следует запускать
напрямую без проверенного logging bootstrap. CLI создаёт debug-файл даже без
`--debug`, а ошибка OAuth fetch может сериализовать тело запроса. В выполненном
deploy файловый/debug logger отключён до импорта CLI, обычные auth/permission
gates сохранены; stdout/stderr фильтровались до фиксированных статусов без
сырых тел. SHA обёртки записаны в evidence. Не запускать login listing, secret access/set, HTTP/debug logging или
необследованные auth helpers. `firebase.json` повторяет staging с флагом
`--firebase-predeploy`; в этом режиме обязан присутствовать
`GCLOUD_PROJECT=omnitwin-demo`, который передаёт Firebase CLI. Прочие проекты
и отсутствие project ID завершаются ошибкой **до записи staged-файлов**.
Обычный offline `npm run stage` не требует окружения Firebase.
[Переменные predeploy](https://firebase.google.com/docs/cli#predeploy_and_postdeploy_hooks).

Runtime проверяет только публичный project ID: документированный JSON
`FIREBASE_CONFIG.projectId` и project env, если они присутствуют. Отсутствие
именно `GCLOUD_PROJECT` не ломает современный runtime с `FIREBASE_CONFIG`.
Противоречащие project IDs, отсутствие всех IDs, path вместо JSON и некорректный
JSON дают безопасный отказ до secrets/Admin SDK; конфигурационные файлы и ADC
эта проверка не читает. [Автоматический Firebase config](https://firebase.google.com/docs/functions/config-env#automatically_populated_environment_variables).

Локальные V2 env не нужно устанавливать и нельзя считать способом переноса
pins в облако. Повторное развёртывание rules/indexes/IAM или секретов для этой
активации не требуется и в процедуру не входит.

## 4. Read-back без чтения секретов

Получить только перечисленные metadata-поля существующей функции, без
`environmentVariables`, secret values, полного API response и auth diagnostics:

```powershell
gcloud functions describe chatApi --v2 --project=omnitwin-demo --region=europe-west1 --format='json(name,state,environment,labels,serviceConfig.revision,serviceConfig.uri,serviceConfig.allTrafficOnLatestRevision)' --verbosity=error --no-log-http | node scripts/verify-deployment.mjs
if ($LASTEXITCODE -ne 0) { throw 'Deployment read-back failed; do not activate Pages' }
```

`verify-deployment.mjs` сам не авторизуется и не обращается к сети. Он принимает
ограниченный stdin JSON, сверяет свежий local stage receipt с текущим activation,
exact project/function, `ACTIVE`, `GEN_2`, URI существующего API, непустую
revision, `allTrafficOnLatestRevision:true` и все три labels. Отсутствующее поле
не трактуется как успех. Вывод содержит только revision/mode/hash и
`configurationVerified:true,liveInferenceVerified:false`. При использовании
владельцем memory-only REST можно передать тот же отфильтрованный объект.
Этот verifier проверяет labels/revision; сохранение runtime-политики требует
дополнительного сравнения metadata **до и после** deploy: runtime, memory/CPU,
timeout, min/max, concurrency, service identity, ingress и два secret version
references. `secretEnvironmentVariables` содержит ссылки, не значения;
`environmentVariables` и secret-value access в эту проверку не входят.
[Functions describe](https://docs.cloud.google.com/sdk/gcloud/reference/functions/describe),
[семантика latest traffic](https://docs.cloud.google.com/functions/docs/reference/rest/v2/projects.locations.functions#ServiceConfig).

Read-back не запускает `/session`, Firestore или LLM и не доказывает, что
pins совпадают с публичными файлами. Сохранить deployment operation/revision
и stage receipt; затем провести отдельно разрешённый bounded live smoke:
legacy ID и V2 ID в согласованном scenario/year, канонические имя/занятие,
настоящий `source:llm`, разрешённую модель и rejected Origin. Бюджет — максимум
два `/chat` POST, по одному на выбранного человека; ошибка формата или LLM
фиксируется без повторной платной попытки. Live replay не выполнять:
deduplication проверяется отдельно офлайн. Не печатать sessionToken/историю/ключи. Существующие
секреты и их версии должны сохраниться, иначе старые sessions перестанут работать.

## 5. Pages и rollback

Только после этих gates сначала опубликовать полный `cityAssets` tuple в Pages
с legacy default, проверить явную V2-ссылку; затем одним изменением того же
runtime-config установить V2 default с неизменным tuple/API URL. Не публиковать
частичный конфиг: его parse-gate может блокировать даже legacy links.

Для отката default достаточно вернуть frontend legacy default, сохраняя
совместимый V2 backend и immutable pack: уже открытые V2-вкладки продолжают
использовать их. Удаление V2 backend допустимо лишь отдельным решением после
учёта старых ссылок/вкладок. Явное отключение серверной V2-конфигурации также
требует preview, `--write --expect-current`, stage/deploy/read-back:

```powershell
$legacyPreview = node scripts/configure-city.mjs --project omnitwin-demo --legacy | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Legacy preview failed' }
node scripts/configure-city.mjs --project omnitwin-demo --legacy --write --expect-current $legacyPreview.currentActivationSha256
```

Это не live-switch и не автоматический rollback. Новую ревизию данных нельзя
незаметно подменять под тем же V2 datasetId: старые вкладки сохраняют provider,
а запрос пока не передаёт pack revision. Любой pin/code skew, ошибочная доставка,
неуспешный live legacy/V2 smoke или визуальный gate — условие остановки.
