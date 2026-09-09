# Неизменяемая публикация городских пакетов

Утилита относится только к проекту `omnitwin-demo` (`projectNumber=679501553916`) и выделенному bucket `omnitwin-demo-city-assets`. Она не создаёт bucket, не меняет IAM/ACL/CORS, не читает секретные файлы и не запускает авторизацию через CLI. Без `--execute` работает только локальная проверка. **Успешная загрузка не означает публичную доступность или готовность браузера.**

## Проверяемый состав

Три корня внутри `apps/web/public`:

- `city-v2/manifest.json`;
- `demo-v2/manifest.json`;
- `demo-v2/spatial/manifest.json`.

Включаются только следующие семейства текущих manifest-дескрипторов:

- Город: `boundaries`, `buildingIndex`, `roadIndex`, `buildingPages`, `cells`.
- Население: `personShards`, `householdShards`, `summaries`, `queryIndex`, ссылка `spatial.buildingIndex`.
- Присутствие: `targetShards`, `roleShards`, вложенные `contexts` и `householdTripMasks`, `bindingShards`, `candidateCells`.
- Опциональный `spatial.movementIndex`: точный raw/gzip-дескриптор вложенного `DemoMovementIndexManifestV2`, затем обязательные `cells[].context` и `cells[].pages[]` относительно каталога этого manifest. Внутри page/context находятся данные, а не новые ссылки на assets; произвольный рекурсивный импорт JSON не разрешён.
- Для каждого дескриптора сохраняются канонический URL и явный `.gz`-псевдоним, если он указан.

Дерево каталогов НЕ обходится. Старые поколения, неупомянутые файлы, научные/raw-данные, `.env` и файлы вне `city-v2/` / `demo-v2/` не читаются и не загружаются. `sourceLedger`, внешние лицензии и provenance/compiler/source-hash ссылки остаются текстовой атрибуцией внутри manifest; исходные URL по ним не скачиваются. Эти исключения явно перечислены в dry-run. Новый неизвестный локальный asset-дескриптор вызывает ошибку, а не молча неполную публикацию.

Проверяются SHA-256 и размер каждого локального объекта, соответствие gzip исходному содержимому, взаимные ссылки трёх manifest и building/road индексов. Пустые `.bin`-компаньоны допустимы только с точным SHA/размером; отсутствие не трактуется как пустой файл. Переходы через symlink/junction и за границы разрешённых каталогов запрещены.

Если `movementIndex` указан, его bytes/SHA проверяются **до** разбора JSON и открытия дочерних путей. Проверяются contract/dataset/representation, counts, canonical population/geography/building/codec lineage, уникальные cell keys, страницы в возрастающих непересекающихся person ranges и равенство суммы page counts числу членов ячейки. `sourceHashes.baseSpatialManifest` вычисляется ровно как SHA компактного parent spatial JSON с удалённым `movementIndex` плюс newline: это исключает циклическую ссылку на финальный parent hash. `codec`/`compiler` остаются provenance hashes, не разрешением читать или публиковать исходники. Совпадение с реально исполняемым codec дополнительно проверяется runtime/offline verifier.

Отсутствующий optional pointer сохраняет старую closure. Pointer `null`, отсутствующий context/page, битый hash/gzip, другая lineage, выход дочернего URL из каталога movement manifest или неизвестное семейство дескрипторов останавливают plan до auth/network. Старые `candidateCells` продолжают включаться, пока parent manifest на них ссылается; утилита не удаляет их ради уменьшения размера.

## Dry-run до любых облачных действий

Из корня репозитория:

```powershell
node tools/publish-firebase-city-assets.mjs
```

Можно явно указать другой подготовленный публичный корень:

```powershell
node tools/publish-firebase-city-assets.mjs --public-root "PATH_TO_REVIEWED_PUBLIC_DIRECTORY"
```

Вывод содержит число объектов, сумму реально сохраняемых байтов, число gzip-псевдонимов, проверенный локальный объём, SHA всех трёх корней и `dependentManifestHashes` вложенных manifests. В нём нет токена или локальных абсолютных путей.

`releaseId` / `bundleSHA` — SHA-256 от фиксированного контракта доставки и SHA трёх корневых manifest. Префикс всегда `packs/<bundleSHA>/`; под ним сохраняются исходные `city-v2/` и `demo-v2/` пути, без переписывания JSON. База для интеграции:

```text
https://storage.googleapis.com/omnitwin-demo-city-assets/packs/<bundleSHA>/
```

Любое изменение manifest меняет bundleSHA. После нового source freeze нужно заново выполнить dry-run; предыдущие диагностические размеры и SHA не являются разрешением на публикацию новой версии. Утилита не обновляет frontend/runtime-конфигурацию и не объявляет какую-либо версию активной.

Movement manifest и все его leaf hashes транзитивно закреплены дескриптором в spatial root. Изменение nested bytes без обновления pointer — ошибка SHA; согласованное обновление pointer меняет spatial hash и bundleSHA. Порядок вложенности не требует четвёртого независимого root pin. Во время активной компиляции dry-run не запускается: atomic pointer заменяется компилятором только после завершения пакета.

### Проверенный локальный snapshot 2026-09-08

После сообщения компилятора о финальном freeze выполнен **один** полный offline dry-run, exit 0. Проверены 38 920 файлов / 6 671 881 534 локальных байта, включая raw и gzip; сохраняемый объём — 1 926 910 051 байт. План содержит 19 224 canonical gzip objects и 19 224 opaque gzip aliases. Пределы 40 000 объектов / 8 GiB не превышены.

```text
bundleSHA: ce6d7497828079f55a2c74f45d95f3bdcffffdae5d24163e31e7051ce7199abe
city-v2/manifest.json: e8e1627801eb79ac353e9a1bf37419519980ad48d071d9c1f9b67318c2f3f62a
demo-v2/manifest.json: 646bef9ee30c2f061f80b1ce26cd9d7ca2c7da170c6d55c086dea24d2d95bca1
demo-v2/spatial/manifest.json: ec886d770baa1bbb83afab4973b857a6d50d9a1eac0135c1f90508a88557567d
movement/manifest-ca147b34c2a644ff.json: ca147b34c2a644ff769c1eba90d00f5e5c707500a9986a591613ad9edd0138c7
```

Это проверка локальной closure, **не** upload receipt, подтверждение публичного CORS/IAM или разрешение активировать V2. Новое изменение любого manifest/asset требует нового согласованного freeze и dry-run; существующие облачные объекты этой проверкой не читались и не изменялись.

## Два представления gzip

| URL | Сохраняемые байты | Content-Type | Content-Encoding | Проверка потребителя |
| --- | --- | --- | --- | --- |
| `file.json` | Проверенный `file.json.gz`, если указан | `application/json; charset=utf-8` | `gzip` | SHA/bytes исходного JSON после HTTP-декодирования |
| `file.bin` | Проверенный `file.bin.gz`, если указан | `application/octet-stream` | `gzip` | SHA/bytes исходного binary после HTTP-декодирования |
| `file.json.gz` / `file.bin.gz` | Те же проверенные gzip-байты | `application/gzip` | отсутствует | SHA/bytes сжатого дескриптора, затем ограниченная распаковка |

Если gzip не указан, канонический файл передаётся без Content-Encoding. Корневые manifest сохраняются в точности как локальные JSON. Генерации gzip и двойного сжатия нет. Отключить `.gz`-псевдонимы в текущем контракте нельзя.

Объекты получают `Cache-Control: public, max-age=31536000, immutable, no-transform`. Это директива кеширования, **не выдача прав доступа**. Пользовательские metadata содержат SHA/bytes исходного представления и реально сохранённого тела; `md5Hash` задаётся для проверки GCS. У псевдонима исходное HTTP-представление само является gzip, поэтому его raw/stored значения совпадают.

Серверный resolver должен проверять точный размер и SHA декодированного потока: `Content-Length` сжатого ответа не обязан совпадать с размером исходного файла. Frontend может проверять непрозрачный `.gz`-ответ и самостоятельно ограниченно распаковывать его. Подробности: [gzip transcoding](https://docs.cloud.google.com/storage/docs/transcoding).

## Явный запуск после проверки владельцем

Доступ передаётся доверенным callback `getAccessToken`, либо заранее установленной доверенным секрет-провайдером переменной `FIREBASE_CITY_ASSET_ACCESS_TOKEN`. Токен нельзя передавать аргументом, сохранять в репозитории, печатать или включать в отчёты. Утилита не ищет credential-файлы и не вызывает `gcloud` / Firebase CLI.

```powershell
node tools/publish-firebase-city-assets.mjs --execute --bucket omnitwin-demo-city-assets --expected-release "SHA_FROM_REVIEWED_DRY_RUN"
```

Без точного SHA текущего dry-run выполнение отклоняется. Перед первым обращением к auth/network повторно проверяются ВСЕ файлы плана; непосредственно перед каждой загрузкой проверяется отправляемое тело. Через read-only bucket metadata проверяются точное имя и `projectNumber`. Одного совпадения имени проекта или bucket недостаточно.

Минимальные права оператора: чтение metadata выбранного bucket, чтение объектов и создание объектов только нужного `packs/<bundleSHA>/` префикса. Delete/update/IAM-права утилите не нужны. Конкретный principal и разрешения на выделенный bucket определяет владелец.

API для доверенного orchestration-кода:

```javascript
import {planFirebaseCityAssets, summarizeFirebaseCityPlan, publishFirebaseCityAssets}
  from './tools/publish-firebase-city-assets.mjs';

const plan = await planFirebaseCityAssets({publicRoot});
const review = summarizeFirebaseCityPlan(plan); // сохранять только несекретный отчёт
// После явного разрешения владельца на review.releaseId:
const receipt = await publishFirebaseCityAssets(plan, {
  projectId: 'omnitwin-demo', bucket: 'omnitwin-demo-city-assets',
  getAccessToken: trustedTokenProvider, signal,
});
```

Plan является замороженным объектом текущего процесса. Загружать произвольный сериализованный JSON-план нельзя: после перезапуска выполняется новая локальная проверка. `fetchImpl` подставляется только доверенным кодом / offline-тестами. Callback может обновлять краткоживущий токен между запросами; его ошибки и сетевые исключения не печатают секретный текст.

Callback получает `{signal}`. Общий deadline 30 секунд на запрос охватывает получение токена, HTTP и чтение metadata; внешний AbortSignal также прекращает ожидание зависшего callback. Ошибки потока и отмены ненужного тела не раскрывают upstream-текст.

## Неизменяемость, прерывание и resume

Используется JSON API: metadata GET и multipart POST с `ifGenerationMatch=0`. Предусловие разрешает создание только при отсутствии live-объекта: [Objects.insert](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert). ACL-параметры, PATCH, DELETE и безусловные повторы отсутствуют.

Resume пропускает объект только при совпадении GCS `size`, вычисленного GCS `md5Hash`, пользовательских SHA/bytes raw/stored, release/source metadata и Content-Type/Encoding/Cache-Control. Одних пользовательских metadata недостаточно. Несовпадение останавливает выполнение; существующий объект не исправляется и не перезаписывается. При HTTP 412 после конкурентного создания выполняется повторная проверка metadata; несовпадение также является ошибкой. Документация: [Objects.get](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get).

Максимум две параллельные загрузки; ошибка прекращает постановку новых и отменяет текущие запросы. Уже успешно созданные неизменяемые объекты остаются. Неопределённый исход запроса требует нового запуска с GET-проверкой; автоматического повтора POST нет. Receipt после полного завершения содержит `uploaded`, `skipped`, bucket/prefix, URL manifest и `publicReady:false`.

Сначала загружаются/проверяются все leaf assets (максимум две параллельно), затем movement manifest и его opaque gzip alias (последовательно), затем три корня (последовательно, spatial последним). Manifest не опережает зависимости даже когда другая загрузка ещё выполняется. При ошибке leaf ни movement manifest, ни корни не создаются.

Локальные пределы: корневой manifest 32 MiB, movement manifest 12 MiB, movement page/context 8 MiB, один прочий asset 64 MiB, максимум 40 000 файлов и **8 GiB** manifest-достижимых локальных байтов (raw и gzip считаются отдельно), metadata-ответ 64 KiB. Повышение только суммарного cap с 4 до 8 GiB явно разрешено владельцем для новой конечной closure: опубликованные compiler stats — 8 528 pages и 2 312 contexts, 3 458 074 071 raw bytes и 605 712 602 gzip bytes плюс nested manifest. Вместе с прежними 17 238 объектами это ожидаемые 38 920 объектов, не разрешение на рекурсивную публикацию или непроверенный размер. Финальные объём и bundleSHA устанавливает отдельный свежий dry-run. Per-object, memory, 40 000 objects и concurrency=2 не увеличивались. Проверка файлов потоковая; multipart удерживает не более двух ограниченных отправляемых тел и их конвертов. Это ограничения ресурсов, не обещание скорости.

## Отдельный план публичного чтения и CORS — НЕ выполняется утилитой

Владелец отдельно создаёт/проверяет только `omnitwin-demo-city-assets`, его публичное чтение и применимость uniform bucket access. Публичные ACL/IAM для всего проекта, function-source buckets и другие bucket не изменяются. Не путать публичный доступ с CORS: нужны обе проверки.

Для канонического XML download endpoint `storage.googleapis.com/BUCKET/OBJECT` пример целевого CORS-плана выделенного bucket:

```json
[{"origin":["https://arseniy24rus.github.io"],"method":["GET","HEAD"],"responseHeader":["Content-Type","Content-Encoding","Content-Length","ETag","x-goog-hash"],"maxAgeSeconds":3600}]
```

Это только план для отдельного подтверждения, не команда изменения bucket. Нет `*`, browser-write методов или разрешений на прочие origins. `storage.cloud.google.com` для браузерного CORS не подходит; [официальная документация CORS](https://docs.cloud.google.com/storage/docs/cross-origin).

После загрузки владелец отдельно проверяет публичные GET/HEAD с нужным Origin, фактические заголовки, оба gzip-представления, SHA/bytes клиента/сервера, исходные manifest pins и отсутствие поломанной относительной ссылки. При наличии movement index включить в эту проверку сам nested manifest, один context и одну page в обоих представлениях. Тот же exact origin/GET/HEAD CORS применяется к ним без новых разрешений; `.json.gz` остаётся opaque `application/gzip` без Content-Encoding. Только после этого можно менять `cityAssets.baseUrl`, `populationManifestSha256`, `spatialManifestSha256`. Этот инструмент не выполняет такой rollout.

## Offline-тесты

```powershell
node --test --test-concurrency=1 tools/tests/publish-firebase-city-assets.test.mjs
```

Тесты используют маленький вымышленный пакет во временном каталоге и поддельный транспорт. Проверяются scope, неизвестные семейства, SHA/размеры/gzip, нулевые binary-компаньоны, реальный symlink/junction escape, целевой проект/bucket, условное создание, конкурентное создание/resume, native MD5 и заголовки, предел параллелизма, публикация manifest последними, отмена зависшей авторизации и отсутствие секрета в ошибках чтения/отмены потока. Movement-тесты проверяют полную nested closure, относительные paths, baseSpatial lineage, обязательные context/pages, изменение pack hash, corruption/missing leaf, topological publication/resume и отказ до auth при смене файла после plan. Они не подтверждают реальное IAM/CORS, размещение данных или работоспособность облачной доставки.
