export type VisualViewportLike = {
  height: number;
  offsetTop: number;
} | null;

export function getViewportOffset(layoutHeight: number, vv: VisualViewportLike): number {
  if (!vv) return 0;
  return Math.max(0, layoutHeight - vv.height - vv.offsetTop);
}

export function getVisualViewportHeight(layoutHeight: number, vv: VisualViewportLike): number {
  return vv ? vv.height : layoutHeight;
}
