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
import { type BoardComponent, createBoard } from "./board";
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
 * Owns one below-editor widget generation, its detached board projection, and
 * its exact overlay handle. Render/input paths have no monitor capability.
 */
export function createUiController(
  host: UiHost,
  initial: WidgetSnapshot,
): UiController {
  let snapshot = clone(initial);
  let selected = false;
  let disposed = false;
  let materialized = false;
  let theme: Theme | undefined;
  let tui: TUI | undefined;
  let unsubscribe: (() => void) | undefined;
  let board: BoardComponent | undefined;
  let boardOverlay: ReturnType<UiHost["openOverlay"]> | undefined;

  const safeSelection = () => host.canActivate(right);

  const screenRows = () => {
    try {
      const rows = tui?.terminal.rows;
      return typeof rows === "number" && Number.isFinite(rows) ? rows : 0;
    } catch {
      return 0;
    }
  };

  const closeBoard = () => {
    const ownedBoard = board;
    const ownedOverlay = boardOverlay;
    board = undefined;
    boardOverlay = undefined;
    ownedOverlay?.close();
    // Hosts normally dispose through their exact overlay close. Keep component
    // cleanup idempotent when a rejected host returns a no-op handle instead.
    ownedBoard?.dispose();
  };

  const openBoard = () => {
    if (disposed || board || !theme) return;
    let next: BoardComponent | undefined;
    next = createBoard(snapshot, {
      theme,
      screenRows,
      isFocused: () => board === next && boardOverlay?.isFocused() === true,
      onClose: () => {
        if (board !== next) return;
        closeBoard();
      },
      requestRender: () => host.requestRender(),
    });
    board = next;
    try {
      boardOverlay = host.openOverlay(next, {
        width: "94%",
        maxHeight: "80%",
        anchor: "center",
        margin: 1,
      });
    } catch (error) {
      if (board === next) board = undefined;
      next.dispose();
      throw error;
    }
  };

  const clearSelection = () => {
    if (!selected) return;
    selected = false;
    host.requestRender();
  };

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
        openBoard();
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

  host.attach((nextTui: TUI, nextTheme: Theme) => {
    if (disposed) return component;
    tui = nextTui;
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
      if (board) board.update(snapshot);
      else if (materialized) host.requestRender();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      selected = false;
      closeBoard();
      unsubscribe?.();
      unsubscribe = undefined;
      tui = undefined;
      host.dispose();
    },
  };
}
