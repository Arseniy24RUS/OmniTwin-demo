import { describe, expect, it, vi } from 'vitest';
import { InteractionController } from '../renderer/runtime/InteractionController';

class ViewportMap {
  handlers = new Map<string, Set<() => void>>();
  camera = { longitude: 61.4, latitude: 55.16, zoom: 16.7, pitch: 55, bearing: 0 };
  bbox = [61.39, 55.15, 61.42, 55.18];
  canvas = { clientWidth: 1480, clientHeight: 800 };
  moving = false;
  on(event: string, callback: () => void) { const set = this.handlers.get(event) ?? new Set(); set.add(callback); this.handlers.set(event, set); }
  off(event: string, callback: () => void) { this.handlers.get(event)?.delete(callback); }
  emit(event: string) { this.handlers.get(event)?.forEach(callback => callback()); }
  getCenter() { return { lng: this.camera.longitude, lat: this.camera.latitude }; }
  getZoom() { return this.camera.zoom; }
  getPitch() { return this.camera.pitch; }
  getBearing() { return this.camera.bearing; }
  getCanvas() { return this.canvas; }
  isMoving() { return this.moving; }
  getBounds() { return { getWest: () => this.bbox[0]!, getSouth: () => this.bbox[1]!, getEast: () => this.bbox[2]!, getNorth: () => this.bbox[3]! }; }
}

describe('actual renderer viewport lifecycle', () => {
  it('publishes initial actual bounds and changed pitch/bearing/fractional zoom only at settled events', () => {
    const map = new ViewportMap(); const publish = vi.fn();
    const controller = new InteractionController({ map: map as never, getEntities: () => [], readTargetCamera: () => map.camera, onViewportChange: publish });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ bbox: map.bbox, widthCss: 1480, heightCss: 800 }));
    map.camera.bearing = 70; map.bbox = [61.38, 55.15, 61.43, 55.18]; map.moving = true;
    map.emit('move'); map.emit('resize'); expect(publish).toHaveBeenCalledTimes(1);
    map.moving = false;
    map.emit('moveend'); expect(publish).toHaveBeenCalledTimes(2);
    map.camera.pitch = 60; map.emit('moveend'); expect(publish).toHaveBeenCalledTimes(3);
    map.camera.zoom = 16.9; map.emit('moveend'); expect(publish).toHaveBeenCalledTimes(4);
    map.emit('idle'); map.emit('load'); map.emit('moveend'); expect(publish).toHaveBeenCalledTimes(4);
    controller.dispose();
    expect([...map.handlers.values()].every(set => set.size === 0)).toBe(true);
  });

  it('refreshes changed CSS viewport after resize, ignores DPR-only repeats and hidden canvas', () => {
    const map = new ViewportMap(); const publish = vi.fn();
    const controller = new InteractionController({ map: map as never, getEntities: () => [], readTargetCamera: () => map.camera, onViewportChange: publish });
    map.canvas.clientWidth = 390; map.canvas.clientHeight = 844; map.emit('resize');
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ widthCss: 390, heightCss: 844 }));
    map.emit('resize'); map.emit('idle'); expect(publish).toHaveBeenCalledTimes(2);
    map.canvas.clientWidth = 0; map.emit('resize'); expect(publish).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});
