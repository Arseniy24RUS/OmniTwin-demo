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
- Для каждого дескриптора сохраняются канонический URL и явный `.gz`-псевдоним, если он указан.

Дерево каталогов НЕ обходится. Старые поколения, неупомянутые файлы, научные/raw-данные, `.env` и файлы вне `city-v2/` / `demo-v2/` не читаются и не загружаются. `sourceLedger`, внешние лицензии и provenance/compiler/source-hash ссылки остаются текстовой атрибуцией внутри manifest; исходные URL по ним не скачиваются. Эти исключения явно перечислены в dry-run. Новый неизвестный локальный asset-дескриптор вызывает ошибку, а не молча неполную публикацию.

Проверяются SHA-256 и размер каждого локального объекта, соответствие gzip исходному содержимому, взаимные ссылки трёх manifest и building/road индексов. Пустые `.bin`-компаньоны допустимы только с точным SHA/размером; отсутствие не трактуется как пустой файл. Переходы через symlink/junction и за границы разрешённых каталогов запрещены.

## Dry-run до любых облачных действий

Из корня репозитория:

```powershell
node tools/publish-firebase-city-assets.mjs
```

Можно явно указать другой подготовленный публичный корень:

```powershell
node tools/publish-firebase-city-assets.mjs --public-root "PATH_TO_REVIEWED_PUBLIC_DIRECTORY"
```

Вывод содержит число объектов, сумму реально сохраняемых байтов, число gzip-псевдонимов, проверенный локальный объём и SHA всех трёх manifest. В нём нет токена или локальных абсолютных путей.

`releaseId` / `bundleSHA` — SHA-256 от фиксированного контракта доставки и SHA трёх корневых manifest. Префикс всегда `packs/<bundleSHA>/`; под ним сохраняются исходные `city-v2/` и `demo-v2/` пути, без переписывания JSON. База для интеграции:

```text
https://storage.googleapis.com/omnitwin-demo-city-assets/packs/<bundleSHA>/
```

Любое изменение manifest меняет bundleSHA. После нового source freeze нужно заново выполнить dry-run; предыдущие диагностические размеры и SHA не являются разрешением на публикацию новой версии. Утилита не обновляет frontend/runtime-конфигурацию и не объявляет какую-либо версию активной.

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

Три корневых manifest публикуются последовательно и только после успешной загрузки либо точной remote-проверки всех остальных объектов. При неполном первом запуске manifest не опережают свои зависимости.

Локальные пределы: manifest 32 MiB, один asset 64 MiB, максимум 40 000 файлов и 4 GiB manifest-достижимых локальных байтов, metadata-ответ 64 KiB. Проверка файлов потоковая; multipart удерживает не более двух ограниченных отправляемых тел и их конвертов. Это ограничения ресурсов, не обещание скорости.

## Отдельный план публичного чтения и CORS — НЕ выполняется утилитой

Владелец отдельно создаёт/проверяет только `omnitwin-demo-city-assets`, его публичное чтение и применимость uniform bucket access. Публичные ACL/IAM для всего проекта, function-source buckets и другие bucket не изменяются. Не путать публичный доступ с CORS: нужны обе проверки.

Для канонического XML download endpoint `storage.googleapis.com/BUCKET/OBJECT` пример целевого CORS-плана выделенного bucket:

```json
[{"origin":["https://arseniy24rus.github.io"],"method":["GET","HEAD"],"responseHeader":["Content-Type","Content-Encoding","Content-Length","ETag","x-goog-hash"],"maxAgeSeconds":3600}]
```

Это только план для отдельного подтверждения, не команда изменения bucket. Нет `*`, browser-write методов или разрешений на прочие origins. `storage.cloud.google.com` для браузерного CORS не подходит; [официальная документация CORS](https://docs.cloud.google.com/storage/docs/cross-origin).

После загрузки владелец отдельно проверяет публичные GET/HEAD с нужным Origin, фактические заголовки, оба gzip-представления, SHA/bytes клиента/сервера, исходные manifest pins и отсутствие поломанной относительной ссылки. Только после этого можно менять `cityAssets.baseUrl`, `populationManifestSha256`, `spatialManifestSha256`. Этот инструмент не выполняет такой rollout.

## Offline-тесты

```powershell
node --test --test-concurrency=1 tools/tests/publish-firebase-city-assets.test.mjs
```

Тесты используют маленький вымышленный пакет во временном каталоге и поддельный транспорт. Проверяются scope, неизвестные семейства, SHA/размеры/gzip, нулевые binary-компаньоны, реальный symlink/junction escape, целевой проект/bucket, условное создание, конкурентное создание/resume, native MD5 и заголовки, предел параллелизма, публикация manifest последними, отмена зависшей авторизации и отсутствие секрета в ошибках чтения/отмены потока. Они не подтверждают реальное IAM/CORS, размещение данных или работоспособность облачной доставки.
