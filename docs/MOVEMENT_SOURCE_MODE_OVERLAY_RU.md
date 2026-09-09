# Source-mode-v2 overlay движения: источник и публичная активация

Статус на 2026-09-09: immutable overlay опубликован, публичная доставка проверена;
совместимость базовых профилей подтверждена отдельной backend-активацией и двумя
live-запросами, legacy и V2. Область самого overlay остаётся ограниченным
исходным кварталом. Это не наблюдаемый транспортный поток, не маршрутизация
дом—работа и не новая демографическая модель. Базовые люди, домохозяйства,
назначения зданий, сценарии и старые артефакты сохраняются.

Исторический `DemoMovementOverlayV2` по-прежнему содержит `scope=local_preview`
и `chatCompatibility=pending`. Эти поля и SHA его байтов не меняются после
публикации. `base_profiles_unchanged` — отдельная аттестация публичного
`runtime-config.json.movementOverlay`, связанная со всеми тремя base pins;
подробнее — в разделе публичной доставки ниже. Полный каталог зданий
[охватывает 82 490 ID в семи районах](CITY_VISUAL_PACK_RU.md), но это не расширяет
область данного overlay до всего города.

## Причина исправления

Старый `nearestRoadBindings` выбирал исключительно ближайшую линию с `walkable/drivable=true`; для пешехода это мог быть автомобильный центрлайн. Старый corridor builder предпочитал прямой поворот, не учитывал класс дороги и продолжение после следующего ребра. Начальная ориентация всегда была forward: подъезд, исходно нарисованный к тупику, не искал разрешённый обратный выход.

Read-only проверка девяти SHA-проверенных z16 ячеек вокруг `16/43944/20676`: 642 уникальные дороги, включая 333 footway, 6 pedestrian, 2 path и 28 steps. Все 642 исходно помечены walkable, 271 drivable. После исключения 50-метровой внешней полосы степень 1 имели 131 из 1513 узлов (8,7%); 98 таких концов относятся к service. Следовательно, тупики не доминируют в источнике — они непропорционально относятся к подъездам. Отдельные footway существуют; симметричные выдуманные тротуары не нужны.

Текущий geographic compiler сохраняет класс, нормализованные mode/oneway flags и ordered node IDs, но теряет sidewalk/footway=crossing и исходные access-теги. Нельзя выдавать оставшуюся линию footway за доказанную сторону улицы или конкретный переход. OSM различает отдельную геометрию тротуара и тег на дороге, а пешеходное направление задаётся отдельно: [sidewalk](https://wiki.openstreetmap.org/wiki/Key:sidewalk), [oneway:foot](https://wiki.openstreetmap.org/wiki/Key:oneway:foot).

## Новая ограниченная политика

- Пеший граф использует только разрешённые source footway/pedestrian/path/steps/corridor/platform/bridleway и shared-space living_street. Разрешение foot=yes на автомобильной линии не создаёт геометрию тротуара. Неизвестная пешеходная геометрия остаётся недоступной.
- Геометрические связи строятся исключительно по общим OSM node IDs, включая внутренние узлы way. Пересечение координат без общего ID не создаёт перехода.
- Направления разделены по mode. Для living_street автомобильное oneway не переносится на пешехода. Явное нормализованное walkDirection имеет приоритет; неоднозначное plain oneway на footway/path сохраняется консервативно.
- Автомобильные предпочтения учитывают класс, известное число полос, длину и связность. Это объявленные иллюстративные веса выбора, не измеренные capacity/demand и не дробные веса жителей.
- `selectSeed` ищет только исходные линии в пределах 750 м; `buildBest` выбирает более длинную разрешённую ориентацию. Продолжение отдаёт предпочтение связной улице перед коротким тупиковым ответвлением. Ограничения: target 1 км, максимум 1,5 км / 12 сегментов, bounded LRU.

На тех же девяти ячейках проверены 63 детерминированно выбранных здания: пешие seeds — 52 footway, 8 pedestrian, 3 path; автомобильные — 22 primary, 14 secondary, 23 residential, 4 service. В пеших corridor не было автомобильных centerline-сегментов; один автомобильный маршрут был короче 100 м. Это проверка результата алгоритма, не оценка фактического городского трафика.

## История локального preview и версионирование

`DemoMovementOverlayV2` имеет `scope=local_preview`, `chatCompatibility=pending`, hash-pinned base spatial/population/geography, отдельные policy/corridor code hashes, core bbox и guarded source bbox. Он содержит полные mode bindings всех покрытых исходных зданий и новый индекс person×corridor-cell. Строки людей и household context копируются из проверенных канонических байтов; отсутствующая связь не подменяется старым или придуманным маршрутом.

Область первого preview: source-квартал 1200 м вокруг `[61.39466,55.1654]`; sourceBounds имеет радиус 1500 м от того же центра (квадрат 3 км), то есть минимум 900 м внешнего запаса вокруг core. Это не дополнительная полоса шириной 1500 м. Полные исходные ways могут пересекать внешнюю границу; полнота графа за sourceBounds не заявляется. Ceilings: 256 source cells, 150 000 уникальных кандидатов, 512 MiB serialized output. Staging только `.cache/movement-mode-v2`; dry-run предшествует одной BelowNormal сборке. Публикация и opt-in активация — отдельные действия владельца интеграции. Нельзя применять новые routes к старому cell index и объявлять покрытие полным.

Первоначальный локальный результат, позднее опубликованный без изменения байтов: `manifest-625391b37ea50add.json`, SHA-256 `625391b37ea50add3c40c4ad715124e8fcf395cbd5610f55bc7f5a68b74a7245`, 109 055 bytes. 151 core-здание с role memberships, 91 236 уникальных кандидатов, 68 265 полных домохозяйств / 183 776 записей их членов. 34 выходные ячейки, 205 страниц; 95 029 774 bytes raw и 16 872 967 bytes gzip. Нет непривязанных walk/car origins или кандидатов без нового cell index. До и после emission совпали все три base manifest и runtime codec hashes; source/published manifests не переписывались.

Старые артефакты закономерно сохраняют старые compiler/corridor hashes. Их нельзя переподписывать под новую политику или ослаблять lineage tests ради зелёного статуса. `spatial.mjs` и `movement-index.mjs` runtime codecs в этом изменении не меняются.

Проверка полного старого spatial-пакета теперь привязана к его точному SHA
`ec886d770baa1bbb83afab4973b857a6d50d9a1eac0135c1f90508a88557567d`:
для этого поколения сохранены дословные исходники двух производителей из
опубликованного commit `21ee9a4543f7ee1acc4004fe5c11aea043490724`.
Их SHA повторно сравниваются с неизменённым manifest. Для любого другого
поколения проверяются текущие производители. Source manifests и runtime codecs
во всех случаях обязаны совпадать с текущими байтами. Архив не исполняется и
лежит в `shared/demo-population/test/fixtures/published-spatial-v1-producers`.

## Проверки и открытые ограничения

```sh
node --test --test-concurrency=1 shared/demo-population/movement-road-policy.test.mjs shared/demo-population/route-corridors.test.mjs shared/demo-population/test/spatial-compiler.test.mjs shared/demo-population/test/movement-compiler.test.mjs shared/demo-population/test/movement-index.test.mjs
node --test --test-concurrency=1 tools/tests/city-movement-overlay.test.mjs
```

Первоначальные 27 направленных tests проверили реальные mode geometry, direction, bounded exact-node graph, connectivity ranking, reverse exit, stable ordering/cache, complete canonical contexts и synthetic fixture compilation. Последующая фактическая проверка opt-in и границ DEV/public записана в [local-public-activation evidence](evidence/local-public-activation-20260909.json).

Связные дороги сами по себе не устраняют конец конечного one-way presentation corridor. Старый `once` имеет шестисекундный разрыв перед повтором; при ускорении 16× refresh может его пропустить. Последующая политика lifecycle, очередей, встречных участков, фаз и безопасной интерполяции реализована отдельно от graph fix; её [описание](qa/junction-traffic-policy.md) и [ограниченная проверка всех отображаемых акторов](evidence/junction-cold-rendered-opposing-pass-20260909.json) не меняют исходные маршруты или population assignments. Научные коэффициенты и наблюдаемые ряды не затрагиваются.

## Публичная доставка и отдельная аттестация — 2026-09-09

Отдельный immutable publisher загрузил пакет; opt-in выполняется через
`runtime-config.json.movementOverlay`. Старый manifest сохраняет
SHA `625391b37ea50add3c40c4ad715124e8fcf395cbd5610f55bc7f5a68b74a7245`,
`scope=local_preview` и `chatCompatibility=pending`. Deployment descriptor отдельно
закрепляет публичный URL, 109 055 bytes, полный SHA и три исходных manifest SHA.
Runtime проверяет также точные bytes и все три фактически загруженных base pins.

Полная локальная closure проверена и декодирована: 481 файл, 112 011 796 bytes
raw+gzip, 33 854 989 сохраняемых bytes; 34 ячейки, 205 страниц, 151 покрытое
здание, 381 732 person-cell associations. Release SHA:
`a825cb2f215a04483ff7ba4932dde38c34763260177aa6da5ab9920263a4a019`.
Эта проверка closure предшествовала загрузке и не меняла source manifests/codecs.

[Квитанция загрузки](evidence/movement-upload-receipt-20260909.json) фиксирует все
481 объект и публичный URL manifest. [Последующий публичный аудит](evidence/movement-public-assets-20260909.json)
имеет `publicVerified=true`: точные метаданные всех 481 объектов совпали,
анонимно прочитаны семь контрольных файлов, 881 368 bytes, с проверкой SHA,
MIME, CORS и представления gzip. Поля `publicReady=false` и
`chatCompatibility=pending` исходной upload receipt остаются исторической
записью результата publisher, а не последующей аттестацией backend.

Публичная доставка сама по себе не разрешает полноценный чат. Publisher всегда
выдаёт `chatCompatibility=pending`; отдельное значение
`base_profiles_unchanged` включает владелец выпуска после backend V2
rollout/read-back/tests. Такая аттестация принимается только при совпадении всех
трёх base pins. Направленные provider tests сравнили неизменность person IDs,
полных household records, профилей и home/work/study assignments для трёх жителей,
трёх сценариев и двух лет — 18 сравнений. Это ограниченное инженерное evidence,
а не научная валидация. Исторический manifest не переподписывается и не получает
новых утверждений о совместимости.

Для текущего выпуска read-back подтвердил Firebase `ACTIVE`, ревизию
`chatapi-00002-zup`; оба ограниченных live-запроса — legacy и V2 — прошли проверку.
Результаты и пределы утверждения записаны в
[Firebase live activation evidence](evidence/firebase-live-activation-20260909.json).
Это отдельное основание публичного `base_profiles_unchanged`; исторический
manifest `625391…` и локальный preview не переписываются. Проверка базовых
профилей не заявляет полного равенства визуальных маршрутов и не является
научной валидацией.

В DEV на same-origin loopback остаётся локальная доставка с исходным
`local_preview/pending`, сохраняя опубликованные population/spatial pins.
Публичная активация проверяется отдельно; ошибка pin не вызывает переход на
другой источник. Первая фаза frontend-конфигурации сохраняет legacy default с
явным V2 opt-in. Новый публичный Pages, clean-URL default V2 и публичный браузерный
проход подтверждаются после соответствующей доставки, не выводятся из upload
или двух chat smoke-запросов. Локальная проверка движения, hardware-видео,
паузы и кликов уже имеет [отдельное evidence](evidence/final-hardware-controls-20260909.json).
Подробные команды, limits, доставка gzip и процедура активации:
[movement release README](../tools/movement-release/README.md).
