import type { MapSourceState } from './types';

export interface SourceStateInput {
  mapEnabled: boolean;
  navigatorOnline?: boolean;
  query?: string;
  loadSucceeded?: boolean;
  fatalError?: boolean;
}

export function isForcedOffline(query: string): boolean {
  const parameters = new URLSearchParams(query.startsWith('?') ? query : `?${query}`);
  return parameters.get('map') === 'offline';
}

export function resolveSourceState({
  mapEnabled,
  navigatorOnline = true,
  query = '',
  loadSucceeded = false,
  fatalError = false,
}: SourceStateInput): MapSourceState {
  if (!mapEnabled || !navigatorOnline || isForcedOffline(query) || fatalError) {
    return 'offline_fallback';
  }
  return loadSucceeded ? 'online' : 'checking';
}

export function sourceStateLabel(state: MapSourceState): string {
  if (state === 'online') return 'КАРТА ОНЛАЙН';
  if (state === 'online_degraded') return 'КАРТА ОНЛАЙН · НЕПОЛНЫЕ ТАЙЛЫ';
  if (state === 'local_scene_ready') return 'ЛОКАЛЬНАЯ SCENE · БЕЗ ВНЕШНИХ ТАЙЛОВ';
  if (state === 'offline_fallback') return 'OFFLINE_FALLBACK';
  return 'ПРОВЕРКА КАРТЫ';
}

export function isOnlineSourceState(state: MapSourceState): boolean {
  return state === 'online' || state === 'online_degraded';
}
