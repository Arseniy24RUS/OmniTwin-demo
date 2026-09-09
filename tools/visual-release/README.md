# Неизменяемая публикация визуального каталога

`tools/publish-city-visual-assets.mjs` готовит точную closure от одного
`city-visual-v1/manifest.json`. По умолчанию это локальная проверка без auth,
сетевых запросов, копирования ресурсов или изменения активной конфигурации.
Инструмент относится к существующему проекту `omnitwin-demo`
(`projectNumber=679501553916`) и bucket `omnitwin-demo-city-assets`.

```powershell
node tools/publish-city-visual-assets.mjs --report-dir .cache/city-visual-publication-v1
```

Можно передать `--visual-root PATH_TO_FROZEN_VISUAL_DIRECTORY`. Запускать после
завершения компиляции и фиксации root manifest. Флаг
`--allow-partial-dry-run` разрешает только осмотр неполного каталога;
публикация такого плана запрещена до auth.

## Состав и проверка

Разрешены только объявленные связи:

1. Root manifest: fallback `tileset`, `semantics`, `assets`, `textureAssets`,
   optional `materialLibrary` и обязательный `visualCatalog`.
2. Catalog: `cells[].manifest` и optional общий `materialLibrary`.
3. Cell manifest: те же GLB/tileset/semantics/material families, без вложенного
   каталога. Каталог и ячейка имеют одинаковую source lineage и canonical IDs.
4. GLB: только встроенные buffers и точные объявленные image URI. Canonical IDs
   из GLB feature ranges сверяются с manifest, semantics и REPLACE-деревом:
   дочерние узлы образуют непересекающееся полное разбиение родителя.

Каждый файл проверяется по SHA-256 и размеру до включения в план; MD5 вычисляется
для транспортной проверки GCS. Повторяющийся путь не создаёт второй объект.
Выход за корень, symlink/junction, повреждение, пропущенный asset, конфликт
дескрипторов, неизвестный URI/URL asset family и неполное canonical ownership
вызывают ошибку. Это bounded integrity/closure gate, а не проверка качества
графики, научных данных, GPU-декодирования или публичного браузера.

Каталоги файлов не обходятся. Старые поколения, compiler receipts, source
ledger, provenance/license URLs, population/raw-данные и bundled Pages actor
assets не публикуются. `license.sourceLedger` — явно разрешённая текстовая
атрибуция исходников, а не дополнительный download inventory. Новые семейства
ресурсов требуют явного изменения planner и тестов.

Лимиты: 4 096 ячеек, 200 000 canonical building IDs, 40 000 объектов и 20 GiB
суммарно; root/cell manifest 1 MiB, catalog 8 MiB, tileset 256 KiB, semantics
16 MiB, GLB 96 MiB, GLB JSON chunk 8 MiB, texture 16 MiB, material kit 32 MiB.
GLB читаются по одному, публикация использует максимум два параллельных запроса.
Предел population publisher остаётся прежним: 8 GiB.

## Относительные пути и независимый pin

Release SHA зависит от bytes/SHA корневого manifest и фиксированного контракта
доставки. Корень транзитивно закрепляет catalog, manifests ячеек и все листья.
Файлы передаются без изменения байтов и без Content-Encoding по адресу:

```text
https://storage.googleapis.com/omnitwin-demo-city-assets/packs/<releaseSHA>/city-visual-v1/
```

Сохраняются все относительные пути. Shared kit хранится физически один раз в
каталоге catalog. Cell manifests сохраняют identical materialLibrary, а runtime
сопоставляет точные cell-local material URLs с проверенными catalog-root URLs.
Не создаются тысячи копий kit. Если fallback root использует отдельные локальные
material URLs, эти реальные URL тоже входят в closure; planner их не переписывает.

Dry-run возвращает независимый runtime descriptor:

```json
{
  "contract": "CityVisualActivationV1",
  "version": 1,
  "populationDatasetId": "omnitwin-fictional-city-v2",
  "sourceDatasetVersion": "<source SHA>",
  "manifest": {
    "url": "https://storage.googleapis.com/omnitwin-demo-city-assets/packs/<releaseSHA>/city-visual-v1/manifest.json",
    "bytes": 123,
    "sha256": "<root SHA>"
  }
}
```

Сохранённый plan содержит descriptor и `publicReady: false`, но не credentials
или локальные абсолютные пути. Запись отчёта атомарная и create-only: отличающиеся
существующие байты не заменяются. Сериализованный отчёт не является исполняемым
планом: upload принимает только заново проверенный in-process plan.

## Исполнение и последующая активация

После QA и разрешения публикации доверенный orchestration-код передаёт
`getAccessToken({signal})` в `publishCityVisualAssets(plan, options)`. Callback
должен получать/обновлять доступ через уже согласованный provider; uploader не
ищет credentials, не читает Firebase CLI session files и не запускает login.
CLI может использовать только заранее предоставленную доверенным процессом
переменную `FIREBASE_CITY_ASSET_ACCESS_TOKEN`; токен не передаётся аргументом,
не печатается и не записывается.

```powershell
node tools/publish-city-visual-assets.mjs --execute --bucket omnitwin-demo-city-assets --expected-release SHA_FROM_REVIEWED_DRY_RUN --report-dir .cache/city-visual-publication-v1
```

Перед auth заново проверяются все локальные байты. Перед каждой загрузкой
проверяются фактические отправляемые байты. Существующий GCS transport проверяет
bucket projectNumber, bytes, SHA/MD5 и delivery metadata; создаёт объекты только
с `ifGenerationMatch=0`, не использует overwrite/delete/ACL/IAM/CORS операции.
Resume пропускает только точные существующие объекты, включая проверку после
412. Порядок: все листья → cell manifests → catalog → root manifest.

Receipt не активирует версию. После upload отдельно проверяются публичные GET
bytes/SHA, MIME/cache/CORS и фактический браузер; только затем независимый
descriptor включается в runtime/Pages release. Population/spatial activation
pins остаются отдельным контрактом. Bundled actors публикуются обычным Pages
shell; локальный movement overlay не является частью visual closure.

## Проверенный freeze 2026-09-09

Полный offline dry-run завершён с exit 0: **6 225 объектов / 10 078 815 074
байта**, complete catalog **855 nonempty + 476 empty** ячеек. Auth/network/upload
не выполнялись.

```text
release SHA: fc615fdfa6096d4f3bbe9ea6ceb96d3dc9cce92ae91e7189a98c0123ca32a9ec
root bytes: 167143
root SHA: 045265c909e71a82ad244f11f1471e76784244a318b5b082fbbc8c8db073e9f9
catalog bytes: 4490766
catalog SHA: 644cd25ca562392dafa18212c54e307fd649f163351610464e77719e4a1478ae
```

Изменение любого pinned manifest/asset требует нового согласованного freeze и
dry-run. Этот snapshot не доказывает публичную доступность или graphics acceptance.
