export interface BoardLayout {
  width: number;
  height: number;
  leftWidth: number;
  rightWidth: number;
  contentRows: number;
  usable: boolean;
}

const whole = (value: number, minimum = 0) =>
  Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : minimum;

/**
 * The overlay host owns its 94% width. This pure helper only divides the
 * already-bounded component width and reserves terminal-safe render rows.
 */
export function layoutBoard(width: number, screenRows: number): BoardLayout {
  const columns = whole(width, 1);
  const rows = whole(screenRows);
  const height = Math.max(0, Math.min(Math.floor(rows * 0.8), rows - 2));
  const usable = columns >= 56 && height >= 13;
  const contentRows = Math.max(0, height - 1);
  const leftWidth = Math.max(1, Math.floor((columns - 1) * 0.4));
  return {
    width: columns,
    height,
    leftWidth,
    rightWidth: Math.max(1, columns - leftWidth - 1),
    contentRows,
    usable,
  };
}
