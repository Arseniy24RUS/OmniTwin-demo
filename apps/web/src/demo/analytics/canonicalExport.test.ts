// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadCanonicalCsv, type CanonicalRow } from './canonical';

afterEach(() => {
  Reflect.deleteProperty(window, 'showSaveFilePicker');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('aggregate CSV export', () => {
  it('writes the disclosure-safe CSV through the user-selected file handle', async () => {
    let captured = '';
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: vi.fn(async () => ({
        createWritable: async () => ({
          write: async (blob: Blob) => { captured = await blob.text(); },
          close: async () => undefined,
        }),
      })),
    });
    const smallCell: CanonicalRow = {
      geographyId: 'RU-CHE-SET', geographyName: 'Челябинск', period: '2026-01-01',
      stockAsOf: '2026-01-01', periodStart: null, periodEnd: null,
      ageBand: '0-9', sex: 'female', metric: 'population', value: 9, unit: 'persons',
      provenance: 'synthetic', coverage: 1, runMode: 'synthetic',
    };
    const rows: CanonicalRow[] = [
      smallCell,
      { ...smallCell, ageBand: '10-19', value: 20 },
    ];

    await expect(downloadCanonicalCsv(rows, 'synthetic-chelyabinsk-v1')).resolves.toBe('saved');
    expect(captured).toContain('"stock_as_of","period_start","period_end"');
    expect(captured).toContain('"suppressed_small_cell"');
    expect(captured).toContain('"suppressed_complementary"');
  });

  it('fails before opening a file handle when a lone primary cell has no safe sibling', async () => {
    const showSaveFilePicker = vi.fn();
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: showSaveFilePicker,
    });
    const singleton: CanonicalRow = {
      geographyId: 'GEO-930', geographyName: 'Город N', period: '2025',
      stockAsOf: null, periodStart: '2025-01-01', periodEnd: '2025-12-31',
      eventType: 'death', metric: 'death', value: 8, unit: 'events',
      provenance: 'synthetic', coverage: 1, runMode: 'synthetic',
    };

    await expect(downloadCanonicalCsv([singleton], 'run-remapped')).rejects.toThrow(/CSV_DISCLOSURE_UNSAFE/);
    expect(showSaveFilePicker).not.toHaveBeenCalled();
  });

  it('keeps a fallback Blob URL alive until the browser has accepted the download', async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:aggregate-export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const row: CanonicalRow = {
      geographyId: 'GEO-930', geographyName: 'Город N', period: '2026-01-01',
      stockAsOf: '2026-01-01', periodStart: null, periodEnd: null,
      metric: 'population', value: 10, unit: 'persons', provenance: 'synthetic',
      coverage: 1, runMode: 'synthetic',
    };

    await expect(downloadCanonicalCsv([row], 'run-remapped')).resolves.toBe('download_started');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:aggregate-export');
  });
});
