import type {
  TerminalInputHandler,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  isKeyRelease,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import type { UiHost } from "./host";
import { renderWidget, type WidgetSnapshot } from "./widget";

export interface UiController {
  update(snapshot: WidgetSnapshot): void;
  dispose(): void;
}

const right = "\x1b[C";
const clone = (snapshot: WidgetSnapshot): WidgetSnapshot =>
  structuredClone(snapshot);

/**
 * Owns one below-editor widget generation and local selection only. Snapshot
 * data is copied at the boundary; input/render paths have no monitor access.
 */
export function createUiController(
  host: UiHost,
  initial: WidgetSnapshot,
  openBoard: (snapshot: WidgetSnapshot) => void,
): UiController {
  let snapshot = clone(initial);
  let selected = false;
  let boardRequested = false;
  let disposed = false;
  let materialized = false;
  let theme: Theme | undefined;
  let unsubscribe: (() => void) | undefined;

  const clearSelection = () => {
    if (!selected) return;
    selected = false;
    host.requestRender();
  };

  const safeSelection = () => host.canActivate(right);

  const input: TerminalInputHandler = (data) => {
    if (disposed || isKeyRelease(data)) return;
    if (selected) {
      // Any focus/editor/overlay loss clears selection before interpreting keys.
      if (!safeSelection()) {
        clearSelection();
        return;
      }
      if (matchesKey(data, "right")) return { consume: true };
      if (matchesKey(data, "enter")) {
        selected = false;
        if (!boardRequested) {
          boardRequested = true;
          openBoard(clone(snapshot));
        }
        host.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "left") || matchesKey(data, "escape")) {
        clearSelection();
        return { consume: true };
      }
      // Preserve exactly what earlier listeners supplied to the editor pipeline.
      clearSelection();
      return;
    }
    if (host.canActivate(data)) {
      selected = true;
      boardRequested = false;
      host.requestRender();
      return { consume: true };
    }
  };

  const component: Component = {
    render(width) {
      if (selected && !safeSelection()) selected = false;
      return renderWidget(snapshot, selected, width, theme as Theme);
    },
    invalidate() {},
  };

  host.attach((_tui: TUI, nextTheme: Theme) => {
    if (disposed) return component;
    theme = nextTheme;
    materialized = true;
    if (!unsubscribe) unsubscribe = host.onInput(input);
    return component;
  });

  return {
    update(next: WidgetSnapshot) {
      if (disposed) return;
      snapshot = clone(next);
      if (!snapshot.presentation.enabled) {
        this.dispose();
        return;
      }
      if (selected && !safeSelection()) selected = false;
      if (materialized) host.requestRender();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      selected = false;
      unsubscribe?.();
      unsubscribe = undefined;
      host.dispose();
    },
  };
}
