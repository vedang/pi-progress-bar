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
  const theme = {
    fg: (_: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const materialize = () => {
    component = factory?.({} as TUI, theme);
  };
  const stop = vi.fn();
  const host = {
    attach: vi.fn((fn: Parameters<UiHost["attach"]>[0]) => {
      factory = fn;
      if (!deferred) materialize();
    }),
    canActivate: vi.fn((data: string) => safe && data === "\u001b[C"),
    onInput: vi.fn((fn: TerminalInputHandler) => {
      listener = fn;
      return stop;
    }),
    requestRender: vi.fn(),
    dispose: vi.fn(),
    openOverlay: vi.fn(),
  } as unknown as UiHost;
  const openBoard = vi.fn();
  const view = uxView();
  const controller = createUiController(host, view, openBoard);
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
