import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import assert from 'node:assert/strict';

/** Deliberately excludes private PMO archive/audit and all real person records. */
export async function buildObservedCity(root, out) {
  const folder = join(root, 'data/observed');
  const read = async name => JSON.parse(await readFile(join(folder, name), 'utf8'));
  const historical = await read('chelyabinsk-history-reviewed-v1.json');
  assert.equal(historical.municipalityOktmo, '75701000');
  assert.equal(historical.reuse.status, 'small_confirmed_public_aggregates_with_attribution');
  const sources = [{ id: historical.sourceId, title: historical.source.title, url: historical.source.url }];
  const snapshots = [];
  for (const year of [2023, 2024]) {
    const source = await read(`chelyabinsk-official-city-${year}.json`);
    assert.equal(source.stockAsOf, `${year}-01-01`);
    assert.equal(source.classification, 'observed');
    assert.equal(source.reuse.status, 'public_source_aggregate_extract_with_attribution');
    assert.equal(source.geography.nameRu, 'Челябинск');
    assert.equal(source.totals.total, source.totals.male + source.totals.female);
    let nextAge = 0;
    for (const row of source.ageSex) {
      const age = /^(\d+)(?:-(\d+)|(\+))$/.exec(row.ageBand);
      assert(age && Number(age[1]) === nextAge, 'Only contiguous non-overlapping age partitions can be published');
      nextAge = age[3] ? Infinity : Number(age[2]) + 1;
      assert([row.male, row.female].every(n => Number.isSafeInteger(n) && n >= 0));
    }
    assert.equal(nextAge, Infinity);
    for (const sex of ['male', 'female']) assert.equal(source.ageSex.reduce((n, r) => n + r[sex], 0), source.totals[sex]);
    assert.equal(source.totals.total, historical.history.find(p => p.year === year)?.population, 'Never rescale a pyramid to a conflicting stock');
    snapshots.push({year, asOf:source.stockAsOf, population:source.totals.total, male:source.totals.male, female:source.totals.female,
      ageSex:source.ageSex.map(({ageBand,male,female})=>({ageBand,male,female})), sourceId:source.sourceId});
    sources.push({id:source.sourceId, title:source.source.titleRu, url:source.source.downloadUrl, publishedAt:source.publicationDate, sha256:source.source.sha256});
  }
  const reference = {
    datasetId:'chelyabinsk-observed-reference-v1', representation:'observed_reference',
    territory:{id:'RU-CHE-SET',name:'Челябинский городской округ',oktmo:'75701000'}, snapshots,
    history:historical.history.map(point=>({...point,sourceId:historical.sourceId})), sources,
    notes:[historical.noteRu,
      'Структура: официальные таблицы по городу Челябинску. Городские итоги сверены с муниципальным рядом Челябинского городского округа; отдельные районы не оценивались.',
      'Официальные опубликованные оценки, не результат OmniTwin и не научный прогноз. Дата наблюдения отделена от даты публикации.',
      'Вымышленные персонажи и сценарии 2026–2036 годов составляют отдельный демонстрационный набор, не репрезентативную выборку города.',
      'Использован небольшой числовой фрагмент с указанием источника. Открытая лицензия на исходные публикации не заявляется.'],
    seriesBreaks:[{year:2023,label:'2021–2022: без учёта ВПН‑2020 по муниципальному примечанию источника; сопоставимость редакций ограничена.'}]
  };
  const bytes = JSON.stringify(reference, null, 2)+'\n';
  const url = 'observed-chelyabinsk-v1.json';
  await writeFile(join(out,url), bytes);
  return {url,bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')};
}
