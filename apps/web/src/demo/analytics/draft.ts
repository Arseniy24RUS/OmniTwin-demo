export const DRAFT_KEY = 'omnitwin.public-demo.scenario-draft.v1';
export const DRAFT_PARAMETERS = [
  ['fertility', 'Рождаемость'], ['household_size', 'Размер домохозяйства'], ['age_structure', 'Возрастная структура'],
  ['migration_inflow', 'Приток населения'], ['internal_mobility', 'Внутренняя мобильность'],
  ['employment', 'Занятость'], ['productivity', 'Производительность'],
] as const;
export interface LocalScenarioDraft { version: 1; title: string; note: string; parameters: Record<string, number>; status: 'uncomputed' }
export function emptyDraft(): LocalScenarioDraft { return {version: 1, title: 'Мой сценарий', note: '', parameters: Object.fromEntries(DRAFT_PARAMETERS.map(([id]) => [id, 0])), status: 'uncomputed'}; }
export function parseDraft(value: unknown): LocalScenarioDraft | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LocalScenarioDraft>;
  if (candidate.version !== 1 || candidate.status !== 'uncomputed' || typeof candidate.title !== 'string' || candidate.title.length > 120 || typeof candidate.note !== 'string' || candidate.note.length > 2000 || !candidate.parameters || typeof candidate.parameters !== 'object') return null;
  const parameters: Record<string, number> = {};
  for (const [key] of DRAFT_PARAMETERS) {
    const value = candidate.parameters[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -30 || value > 30) return null;
    parameters[key] = value;
  }
  return {version: 1, status: 'uncomputed', title: candidate.title, note: candidate.note, parameters};
}
