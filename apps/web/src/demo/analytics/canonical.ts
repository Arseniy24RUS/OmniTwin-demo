// Aggregate export ported from OmniTwin analyticsData.ts. Research disclosure semantics are preserved.
export const DEFAULT_SMALL_CELL_THRESHOLD = 10;

export interface CanonicalRow {
  geographyId: string;
  geographyName: string;
  period: string;
  stockAsOf: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  ageBand?: string | null;
  sex?: string | null;
  eventType?: string | null;
  metric: string;
  value: number | null;
  unit: string;
  provenance: string | null;
  coverage: number | null;
  runMode: string;
  datasetId?: string;
  scenarioId?: string;
  representation?: string;
  cohortAgeBand?: string | null;
  cohortSex?: string | null;
  cohortEmployment?: string | null;
  analysisScope?: string;
}

export function formatNullableNumber(value: number | null, maximumFractionDigits = 1): string {
  return value === null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits }).format(value);
}

export interface CsvDisclosureOptions {
  smallCellThreshold?: number;
}

const PERSON_COUNT_UNITS = new Set(['person', 'persons', 'people', 'чел.']);
const EVENT_COUNT_UNITS = new Set(['event', 'events', 'событий']);

type CsvDisclosureStatus = '' | 'suppressed_small_cell' | 'suppressed_complementary';
type CountKind = 'person' | 'event';

function countKind(row: CanonicalRow): CountKind | null {
  const unit = row.unit.trim().toLowerCase();
  if (PERSON_COUNT_UNITS.has(unit)) return 'person';
  if (EVENT_COUNT_UNITS.has(unit)) return 'event';
  return null;
}

function disclosureGroupKey(row: CanonicalRow, kind: CountKind): string {
  const temporalKey = row.stockAsOf !== null
    ? `stock:${row.stockAsOf}`
    : `flow:${row.periodStart ?? ''}:${row.periodEnd ?? ''}`;
  const varyingDimensionBoundary = kind === 'person'
    ? [row.metric.trim().toLowerCase(), row.sex?.trim().toLowerCase() ?? '']
    : [];
  return JSON.stringify([
    row.geographyId,
    temporalKey,
    kind,
    ...varyingDimensionBoundary,
    row.provenance?.trim().toLowerCase() ?? '',
    row.runMode,
    row.datasetId ?? '',
    row.scenarioId ?? '',
    row.cohortAgeBand ?? '',
    row.cohortSex ?? '',
    row.cohortEmployment ?? '',
    row.analysisScope ?? '',
  ]);
}

function complementaryTieKey(row: CanonicalRow): string {
  return JSON.stringify([
    row.ageBand ?? '',
    row.geographyName,
    row.metric,
    row.sex ?? '',
    row.eventType ?? '',
    row.provenance ?? '',
    row.coverage ?? '',
    row.unit,
  ]);
}

function disclosureStatuses(rows: CanonicalRow[], smallCellThreshold: number): CsvDisclosureStatus[] {
  const statuses: CsvDisclosureStatus[] = rows.map(() => '');
  const groups = new Map<string, number[]>();

  rows.forEach((row, index) => {
    const kind = countKind(row);
    if (kind === null) return;
    const groupKey = disclosureGroupKey(row, kind);
    const group = groups.get(groupKey);
    if (group) group.push(index);
    else groups.set(groupKey, [index]);
    if (row.value !== null && row.value > 0 && row.value < smallCellThreshold) {
      statuses[index] = 'suppressed_small_cell';
    }
  });

  for (const group of groups.values()) {
    const primaryCount = group.filter((index) => statuses[index] === 'suppressed_small_cell').length;
    if (primaryCount === 0) continue;
    const complementary = group
      .filter((index) => statuses[index] === '' && rows[index].value !== null && (rows[index].value as number) > 0)
      .sort((leftIndex, rightIndex) => {
        const valueDifference = (rows[leftIndex].value as number) - (rows[rightIndex].value as number);
        if (valueDifference !== 0) return valueDifference;
        const leftKey = complementaryTieKey(rows[leftIndex]);
        const rightKey = complementaryTieKey(rows[rightIndex]);
        if (leftKey < rightKey) return -1;
        if (leftKey > rightKey) return 1;
        return leftIndex - rightIndex;
      })[0];
    if (complementary !== undefined) {
      statuses[complementary] = 'suppressed_complementary';
    } else if (primaryCount === 1) {
      throw new Error('CSV_DISCLOSURE_UNSAFE · единственная малая count-ячейка не имеет положительного sibling для дополнительного подавления; экспорт отменён');
    }
  }

  return statuses;
}

export function buildCanonicalCsv(rows: CanonicalRow[], options: CsvDisclosureOptions = {}): string {
  const smallCellThreshold = Math.max(1, Math.floor(options.smallCellThreshold ?? DEFAULT_SMALL_CELL_THRESHOLD));
  const statuses = disclosureStatuses(rows, smallCellThreshold);
  const escape = (value: string | number | null) => {
    const text = value === null ? '' : String(value);
    return `"${text.replaceAll('"', '""')}"`;
  };
  const header = ['geography_id', 'geography_name', 'stock_as_of', 'period_start', 'period_end', 'age_band', 'sex', 'event_type', 'metric', 'value', 'unit', 'provenance', 'coverage', 'run_mode', 'disclosure_status', 'dataset_id', 'scenario_id', 'representation', 'cohort_age_band', 'cohort_sex', 'cohort_employment', 'analysis_scope'];
  const body = rows.map((row, index) => {
    const status = statuses[index];
    const disclosedValue = status === '' ? row.value : null;
    return [row.geographyId, row.geographyName, row.stockAsOf, row.periodStart, row.periodEnd, row.ageBand ?? null, row.sex ?? null, row.eventType ?? null, row.metric, disclosedValue, row.unit, row.provenance, row.coverage, row.runMode, status, row.datasetId ?? null, row.scenarioId ?? null, row.representation ?? null, row.cohortAgeBand ?? null, row.cohortSex ?? null, row.cohortEmployment ?? null, row.analysisScope ?? null].map(escape).join(',');
  });
  return `\uFEFF${header.map(escape).join(',')}\n${body.join('\n')}\n`;
}

export type CsvExportResult = 'saved' | 'cancelled' | 'download_started';

interface FileSystemWritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandleLike {
  createWritable(): Promise<FileSystemWritableLike>;
}

type FilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandleLike>;
};

export async function downloadCanonicalCsv(rows: CanonicalRow[], runId: string, options: CsvDisclosureOptions = {}): Promise<CsvExportResult> {
  const filename = `omnitwin-${runId}-aggregates.csv`;
  const blob = new Blob([buildCanonicalCsv(rows, options)], { type: 'text/csv;charset=utf-8' });
  const browserWindow = window as FilePickerWindow;
  if (typeof browserWindow.showSaveFilePicker === 'function') {
    try {
      const handle = await browserWindow.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'CSV aggregates', accept: { 'text/csv': ['.csv'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return 'saved';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
      throw error;
    }
  }

  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(href);
  }, 60_000);
  return 'download_started';
}
