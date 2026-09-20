import type {
  TerminalInputHandler,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { createUiController } from "../src/ui/controller";
import type { UiHost } from "../src/ui/host";
import { uxView } from "./fixtures/ux-view";

async function fixture(deferred = false) {
  let component: Component | undefined;
  let factory: Parameters<UiHost["attach"]>[0] | undefined;
  let listener: TerminalInputHandler | undefined;
  let safe = true;
  let overlayOpen = false;
  let overlayFocused = false;
  let overlay: (Component & { dispose?(): void }) | undefined;
  const closeOverlay = vi.fn();
  const theme = {
    fg: (_: string, text: string) => text,
    bold: (text: string) => text,
    bg: (_: string, text: string) => text,
  } as Theme;
  const materialize = () => {
    component = factory?.({ terminal: { rows: 40 } } as TUI, theme);
  };
  const stop = vi.fn();
  const host = {
    attach: vi.fn((fn: Parameters<UiHost["attach"]>[0]) => {
      factory = fn;
      if (!deferred) materialize();
    }),
    canActivate: vi.fn(
      (data: string) => safe && !overlayOpen && data === "\u001b[C",
    ),
    onInput: vi.fn((fn: TerminalInputHandler) => {
      listener = fn;
      return stop;
    }),
    requestRender: vi.fn(),
    dispose: vi.fn(),
    openOverlay: vi.fn((next: Component & { dispose?(): void }) => {
      overlay = next;
      overlayOpen = overlayFocused = true;
      let closed = false;
      return {
        isFocused: () => !closed && overlayFocused,
        close: () => {
          if (closed) return;
          closed = true;
          overlayOpen = overlayFocused = false;
          closeOverlay();
          next.dispose?.();
        },
      };
    }),
  } as unknown as UiHost;
  const openBoard = vi.mocked(host.openOverlay);
  const view = uxView();
  const controller = createUiController(host, view);
  const input = (data: string) => listener?.(data);
  const text = () => component?.render(160).join("\n") ?? "";
  return {
    host,
    controller,
    view,
    input,
    text,
    openBoard,
    stop,
    materialize,
    closeOverlay,
    board: () => overlay,
    boardText: () => overlay?.render(113).join("\n") ?? "",
    blurOverlay: () => {
      overlayFocused = false;
    },

    unsafe: () => {
      safe = false;
    },
  };
}
it("installs once, reveals usage on safe Right, and Enter requests the board once", async () => {
  const h = await fixture();
  expect(h.host.attach).toHaveBeenCalledTimes(1);
  expect(h.host.onInput).toHaveBeenCalledTimes(1);
  expect(h.text()).not.toContain("tokens");
  expect(h.input("\u001b[C")).toEqual({ consume: true });
  expect(h.text()).toContain("200 calls");
  expect(h.text()).toContain("enter to see board");
  expect(h.input("\r")).toEqual({ consume: true });
  expect(h.openBoard).toHaveBeenCalledTimes(1);
  h.input("\r");
  expect(h.openBoard).toHaveBeenCalledTimes(1);
});
it.each(["\u001b[D", "\u001b"])(
  "returns selection to editor on %j",
  async (key) => {
    const h = await fixture();
    h.input("\u001b[C");
    expect(h.input(key)).toEqual({ consume: true });
    expect(h.text()).not.toContain("tokens");
    expect(h.openBoard).not.toHaveBeenCalled();
  },
);
it.each(["x", "日本語", "\u001b[200~pasted text\u001b[201~", "\u001b[A"])(
  "ordinary received input %j deselects without consuming/transformation",
  async (key) => {
    const h = await fixture();
    h.input("\u001b[C");
    expect(h.input(key)).toBeUndefined();
    expect(h.text()).not.toContain("tokens");
  },
);
it("selected Right is a no-op and unsafe focus cannot activate", async () => {
  const h = await fixture();
  h.input("\u001b[C");
  const before = h.text();
  expect(h.input("\u001b[C")).toEqual({ consume: true });
  expect(h.text()).toBe(before);
  h.unsafe();
  expect(h.input("\r")).toBeUndefined();
  expect(h.text()).not.toContain("tokens");
  expect(h.openBoard).not.toHaveBeenCalled();
  expect(h.input("\u001b[C")).toBeUndefined();
});
it("updates cached detached snapshots without replacing the widget or subscribing twice", async () => {
  const h = await fixture();
  h.input("\u001b[C");
  for (let i = 0; i < 20; i++) h.controller.update(h.view);
  expect(h.host.attach).toHaveBeenCalledTimes(1);
  expect(h.host.onInput).toHaveBeenCalledTimes(1);
  expect(h.text()).toContain("200 calls");
  h.view.presentation.usage.jev.calls = 999;
  expect(h.text()).not.toContain("999 calls");
});
it("clears selection on redraw after editor/overlay preconditions are lost without publication", async () => {
  const h = await fixture();
  h.input("\u001b[C");
  expect(h.text()).toContain("tokens");
  h.unsafe();
  expect(h.text()).not.toContain("tokens");
});

it("clears selection on a publication after editor/overlay preconditions are lost", async () => {
  const h = await fixture();
  h.input("\u001b[C");
  expect(h.text()).toContain("tokens");
  h.unsafe();
  h.controller.update(uxView());
  expect(h.text()).not.toContain("tokens");
});

it("subscribes only after a deferred host widget factory is materialized", async () => {
  const h = await fixture(true);
  expect(h.host.onInput).not.toHaveBeenCalled();
  h.materialize();
  expect(h.host.onInput).toHaveBeenCalledTimes(1);
  h.input("\u001b[C");
  expect(h.text()).toContain("tokens");
});
it("disposal fences old callbacks, updates, and delayed factory with exactly owned cleanup", async () => {
  const h = await fixture();
  h.controller.dispose();
  h.controller.dispose();
  expect(h.stop).toHaveBeenCalledTimes(1);
  expect(h.host.dispose).toHaveBeenCalledTimes(1);
  const renders = vi.mocked(h.host.requestRender).mock.calls.length;
  h.input("\u001b[C");
  h.input("\r");
  h.controller.update(uxView());
  h.materialize();
  expect(h.openBoard).not.toHaveBeenCalled();
  expect(h.host.onInput).toHaveBeenCalledTimes(1);
  expect(h.host.requestRender).toHaveBeenCalledTimes(renders);
});
it("OFF tears down owned widget/input and cannot be reversed by a stale update", async () => {
  const h = await fixture();
  const off = uxView();
  off.presentation.enabled = false;
  h.controller.update(off);
  expect(h.host.dispose).toHaveBeenCalledTimes(1);
  h.controller.update(uxView());
  expect(h.host.attach).toHaveBeenCalledTimes(1);
  h.input("\u001b[C");
  expect(h.openBoard).not.toHaveBeenCalled();
});

it("opens a bounded centered board with one-cell margins, not a full-screen replacement", async () => {
  const h = await fixture();
  h.input("\u001b[C");
  h.input("\r");
  expect(h.openBoard).toHaveBeenCalledTimes(1);
  expect(h.openBoard.mock.calls[0]?.[1]).toMatchObject({
    width: "94%",
    maxHeight: "80%",
    anchor: "center",
    margin: 1,
  });
  expect(h.boardText()).toContain("Requirements");
  expect(h.boardText()).toContain("Handle escaped delimiters in parser");
});
it("refreshes the existing board from publications and supports repeated owned open/close", async () => {
  const h = await fixture();
  for (let i = 0; i < 3; i++) {
    h.input("\u001b[C");
    h.input("\r");
    const view = uxView();
    const task = view.board.tasks[0];
    if (task) task.health.requirements = `Published health ${i}`;
    h.controller.update(view);
    expect(h.boardText()).toContain(`Published health ${i}`);
    h.board()?.handleInput?.("\u001b");
    expect(h.closeOverlay).toHaveBeenCalledTimes(i + 1);
  }
  expect(h.host.attach).toHaveBeenCalledTimes(1);
  expect(h.host.onInput).toHaveBeenCalledTimes(1);
  expect(h.openBoard).toHaveBeenCalledTimes(3);
});
it.each(["dispose", "OFF"])(
  "%s closes only owned board even beneath a sibling and fences stale input",
  async (reason) => {
    const h = await fixture();
    h.input("\u001b[C");
    h.input("\r");
    const old = h.board();
    expect(old).toBeDefined();
    h.blurOverlay();
    old?.handleInput?.("\u001b");
    expect(h.closeOverlay).not.toHaveBeenCalled();
    if (reason === "OFF") {
      const off = uxView();
      off.presentation.enabled = false;
      h.controller.update(off);
    } else h.controller.dispose();
    expect(h.closeOverlay).toHaveBeenCalledTimes(1);
    expect(h.host.dispose).toHaveBeenCalledTimes(1);
    old?.handleInput?.("\u001b");
    h.controller.dispose();
    h.controller.update(uxView());
    expect(h.closeOverlay).toHaveBeenCalledTimes(1);
    expect(h.openBoard).toHaveBeenCalledTimes(1);
  },
);
