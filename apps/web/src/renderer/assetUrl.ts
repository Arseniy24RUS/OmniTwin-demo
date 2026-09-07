/** Resolve a published asset inside the Vite project base, including GitHub Pages. */
export function rendererAssetUrl(path: string): string {
  if (/^(?:https?:|data:|blob:)/u.test(path)) return path;
  const base = import.meta.env.BASE_URL || '/';
  if (base !== '/' && path.startsWith(base)) return path;
  return `${base.replace(/\/$/u, '')}/${path.replace(/^\//u, '')}`;
}
