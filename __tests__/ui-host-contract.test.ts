import {
  CustomEditor,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

type Listener = (
  data: string,
) => { consume?: boolean; data?: string } | undefined;
type OwnedOverlay = { close(): void; isFocused(): boolean };
type Host = {
  attach(factory: (tui: TUI, theme: Theme) => Component): void;
  canActivate(data: string): boolean;
  onInput(listener: Listener): () => void;
  openOverlay(
    component: Component & { dispose?(): void },
    options?: OverlayOptions,
  ): OwnedOverlay;
  requestRender(): void;
  dispose(): void;
};

async function create(ctx: ExtensionContext): Promise<Host> {
  // Dynamic path keeps the red-test commit type-checkable before U02 adds source.
  const path = "../src/ui/host";
  const module = await import(path);
  return module.createUiHost(ctx);
}

function fixture() {
  const editor = Object.create(CustomEditor.prototype) as Component;
  const state = {
    focused: editor as Component | null,
    overlay: false,
    text: "",
    custom: undefined as unknown,
    mode: "tui",
  };
  const listeners = new Set<Listener>();
  const unsubscribe = vi.fn();
  const handle = { hide: vi.fn(), isFocused: vi.fn(() => true) };
  const tui = {
    getFocusedComponent: () => state.focused,
    hasOverlay: () => state.overlay,
    showOverlay: vi.fn(() => handle),
    requestRender: vi.fn(),
  };
  const theme = {} as Theme;
  const setWidget = vi.fn(
    (_key: string, factory?: (tui: TUI, theme: Theme) => Component) => {
      factory?.(tui as unknown as TUI, theme);
    },
  );
  const ctx = {
    get mode() {
      return state.mode;
    },
    ui: {
      getEditorText: () => state.text,
      getEditorComponent: () => state.custom,
      onTerminalInput: (listener: Listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          unsubscribe();
        };
      },
      setWidget,
    },
  } as unknown as ExtensionContext;
  const component = { render: () => ["static"], invalidate: vi.fn() };
  return {
    ctx,
    editor,
    state,
    tui,
    component,
    theme,
    setWidget,
    listeners,
    unsubscribe,
    handle,
  };
}

async function attached() {
  const f = fixture();
  const host = await create(f.ctx);
  host.attach(() => f.component);
  return { ...f, host };
}

describe("passive host adapter contract", () => {
  it("attaches the named component below the editor with host-provided TUI/theme", async () => {
    const f = fixture();
    const host = await create(f.ctx);
    const factory = vi.fn(() => f.component);
    host.attach(factory);
    expect(f.setWidget).toHaveBeenCalledWith(
      "pi-progress-bar",
      expect.any(Function),
      { placement: "belowEditor" },
    );
    expect(factory).toHaveBeenCalledWith(f.tui, f.theme);
    expect(host.canActivate("\x1b[C")).toBe(true);
  });

  it.each(["print", "json", "rpc"])(
    "does not install terminal UI in %s mode",
    async (mode) => {
      const f = fixture();
      f.state.mode = mode;
      const host = await create(f.ctx);
      host.attach(() => f.component);
      host.onInput(() => undefined);
      expect(f.setWidget).not.toHaveBeenCalled();
      expect(f.listeners.size).toBe(0);
      expect(host.canActivate("\x1b[C")).toBe(false);
    },
  );

  it.each(["x", " ", "\n"])(
    "preserves Right for nonempty editor %j",
    async (text) => {
      const f = await attached();
      f.state.text = text;
      expect(f.host.canActivate("\x1b[C")).toBe(false);
    },
  );

  it("refuses overlays, custom editors and other focused components", async () => {
    const f = await attached();
    f.state.overlay = true;
    expect(f.host.canActivate("\x1b[C")).toBe(false);
    f.state.overlay = false;
    f.state.custom = () => f.editor;
    expect(f.host.canActivate("\x1b[C")).toBe(false);
    f.state.custom = undefined;
    f.state.focused = f.component;
    expect(f.host.canActivate("\x1b[C")).toBe(false);
    f.state.focused = f.editor;
    expect(f.host.canActivate("\x1b[C")).toBe(true);
  });

  it("never guesses editor identity from arbitrary editor-shaped objects", async () => {
    const f = fixture();
    f.state.focused = {
      ...f.component,
      handleInput() {},
      getText() {
        return "";
      },
      setText() {},
    } as Component;
    const host = await create(f.ctx);
    host.attach(() => f.component);
    expect(host.canActivate("\x1b[C")).toBe(false);
  });

  it("does not capture an editor through a competing overlay", async () => {
    const f = fixture();
    f.state.overlay = true;
    const host = await create(f.ctx);
    host.attach(() => f.component);
    f.state.overlay = false;
    expect(host.canActivate("\x1b[C")).toBe(false);
  });

  it.each(["a", "\x1b[D", "\x1b[1;5C", "\x1b[1;1:3C"])(
    "ignores non-Right or release %j",
    async (key) => {
      const f = await attached();
      expect(f.host.canActivate(key)).toBe(false);
    },
  );

  it("uses the received terminal-input pipeline and owns its unsubscribe", async () => {
    const f = await attached();
    const listener = vi.fn((data: string) =>
      data === "\x1b[C" ? { consume: true } : undefined,
    );
    const off = f.host.onInput(listener);
    const raw = [...f.listeners][0];
    expect(raw?.("x")).toBeUndefined();
    expect(raw?.("\x1b[C")).toEqual({ consume: true });
    off();
    off();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.listeners.size).toBe(0);
  });

  it("closes exactly its overlay once, disposing component separately", async () => {
    const f = await attached();
    const dispose = vi.fn();
    const component = { ...f.component, dispose };
    const overlay = f.host.openOverlay(component, {
      width: "94%",
      maxHeight: "80%",
    });
    expect(f.tui.showOverlay).toHaveBeenCalledWith(component, {
      width: "94%",
      maxHeight: "80%",
    });
    expect(overlay.isFocused()).toBe(true);
    overlay.close();
    overlay.close();
    expect(f.handle.hide).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(overlay.isFocused()).toBe(false);
  });

  it("disposal fences late input/render/attach and cleans all owned resources once", async () => {
    const f = await attached();
    const listener = vi.fn(() => ({ consume: true }));
    f.host.onInput(listener);
    const raw = [...f.listeners][0];
    const dispose = vi.fn();
    f.host.openOverlay({ ...f.component, dispose });
    f.host.requestRender();
    expect(f.tui.requestRender).toHaveBeenCalledTimes(1);
    f.host.dispose();
    f.host.dispose();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.handle.hide).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(f.setWidget).toHaveBeenLastCalledWith("pi-progress-bar", undefined);
    expect(raw?.("\x1b[C")).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    const calls = f.setWidget.mock.calls.length;
    f.host.attach(() => f.component);
    f.host.requestRender();
    expect(f.setWidget).toHaveBeenCalledTimes(calls);
    expect(f.tui.requestRender).toHaveBeenCalledTimes(1);
    expect(f.host.canActivate("\x1b[C")).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
