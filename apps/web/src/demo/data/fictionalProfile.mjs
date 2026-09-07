// This vocabulary and every resulting identity are fictional presentation material.
export function stableHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}
const NAMES = {
  female: ['Анна', 'Мария', 'Елена', 'Ольга', 'София', 'Наталья', 'Ирина', 'Алина', 'Валерия', 'Дарья', 'Вера', 'Полина'],
  male: ['Александр', 'Михаил', 'Андрей', 'Дмитрий', 'Иван', 'Артём', 'Сергей', 'Денис', 'Павел', 'Максим', 'Роман', 'Никита'],
};
const SURNAMES = ['Волков', 'Соколов', 'Морозов', 'Лебедев', 'Орлов', 'Кузнецов', 'Белов', 'Зайцев', 'Смирнов', 'Попов', 'Крылов', 'Миронов', 'Фролов'];
const JOBS = ['учитель', 'инженер', 'врач', 'дизайнер', 'специалист по логистике', 'библиотекарь', 'технолог', 'разработчик', 'повар', 'архитектор'];
const INTERESTS = ['прогулки по набережной', 'книги', 'велосипед', 'фотография', 'театр', 'садоводство', 'музыка', 'история города', 'спорт', 'рисование'];
export function ageBandFor(age) {
  return age < 18 ? '0-17' : age < 35 ? '18-34' : age < 55 ? '35-54' : age < 70 ? '55-69' : '70+';
}
export function employmentFor(record, year) {
  const age = year - record.birthYear;
  if (age < 7) return 'child';
  if (age < 18 || (age < 23 && stableHash(record.id + ':study') % 3 !== 0)) return 'student';
  if (age >= 65) return 'retired';
  return stableHash(record.id + ':employment') % 13 === 0 ? 'not_employed' : 'employed';
}
export function fictionalProfile(record, year, scenario, datasetId, householdSize, territoryName) {
  const h = stableHash(record.id);
  const name = `${NAMES[record.sex][h % NAMES[record.sex].length]} ${SURNAMES[(h >>> 8) % SURNAMES.length]}${record.sex === 'female' ? 'а' : ''}`;
  const employment = employmentFor(record, year);
  const occupation = employment === 'employed' ? JOBS[(h >>> 12) % JOBS.length] : ({ child: 'дошкольник', student: 'учащийся', retired: 'пенсионер', not_employed: 'сейчас не работает' })[employment];
  const interests = [INTERESTS[(h >>> 16) % INTERESTS.length], INTERESTS[(h >>> 20) % INTERESTS.length]];
  return {
    contract: 'PublicFictionalPersonV1', id: record.id, name, age: year - record.birthYear,
    ageBand: ageBandFor(year - record.birthYear), sex: record.sex, employment, occupation,
    householdId: record.householdId, householdSize, territoryId: record.territoryId, territoryName,
    biography: `Вымышленный житель демонстрационного Челябинска. ${occupation[0].toUpperCase() + occupation.slice(1)}. Интересы: ${[...new Set(interests)].join(', ')}. Биография и размещение созданы для демонстрации интерфейса, не описывают реального человека.`,
    interests: [...new Set(interests)], scenario, demographicYear: year, datasetId,
    representation: 'fictional_demo', spatialRepresentation: 'visual_synthesis', isFictional: true,
  };
}
