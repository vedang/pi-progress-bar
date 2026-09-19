import {
  CustomEditor,
  type ExtensionContext,
  type TerminalInputHandler,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  isKeyRelease,
  matchesKey,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";

const widgetName = "pi-progress-bar";

type FocusTui = TUI & { getFocusedComponent(): Component | null };
type DisposableComponent = Component & { dispose?(): void };

export interface OwnedOverlay {
  close(): void;
  isFocused(): boolean;
}

/** Narrow UI boundary: host input and overlays never gain monitor capabilities. */
export interface UiHost {
  attach(factory: (tui: TUI, theme: Theme) => DisposableComponent): void;
  canActivate(data: string): boolean;
  onInput(listener: TerminalInputHandler): () => void;
  openOverlay(
    component: DisposableComponent,
    options?: OverlayOptions,
  ): OwnedOverlay;
  requestRender(): void;
  dispose(): void;
}

const noop = () => {};

const isFocusTui = (value: TUI): value is FocusTui =>
  "getFocusedComponent" in value &&
  typeof value.getFocusedComponent === "function";

const disposeComponent = (component: DisposableComponent) => {
  try {
    component.dispose?.();
  } catch {
    // Component cleanup cannot prevent later owned cleanup.
  }
};

class ExtensionUiHost implements UiHost {
  private attached = false;
  private disposed = false;
  private tui: FocusTui | undefined;
  private editor: Component | undefined;
  private readonly inputUnsubscribers = new Set<() => void>();
  private readonly overlayClosers = new Set<() => void>();

  constructor(private readonly ctx: ExtensionContext) {}

  attach(factory: (tui: TUI, theme: Theme) => DisposableComponent): void {
    if (this.disposed || this.attached || this.ctx.mode !== "tui") return;
    this.attached = true;
    try {
      this.ctx.ui.setWidget(
        widgetName,
        (tui, theme) => {
          this.captureEditor(tui);
          return factory(tui, theme);
        },
        { placement: "belowEditor" },
      );
    } catch (error) {
      this.attached = false;
      this.tui = undefined;
      this.editor = undefined;
      throw error;
    }
  }

  canActivate(data: string): boolean {
    if (
      this.disposed ||
      this.ctx.mode !== "tui" ||
      !this.attached ||
      !this.tui ||
      !this.editor ||
      !matchesKey(data, "right") ||
      isKeyRelease(data)
    )
      return false;
    try {
      return (
        !this.tui.hasOverlay() &&
        this.ctx.ui.getEditorComponent() === undefined &&
        this.tui.getFocusedComponent() === this.editor &&
        this.ctx.ui.getEditorText() === ""
      );
    } catch {
      return false;
    }
  }

  onInput(listener: TerminalInputHandler): () => void {
    if (
      this.disposed ||
      this.ctx.mode !== "tui" ||
      !this.attached ||
      !this.tui ||
      !this.editor
    )
      return noop;
    let active = true;
    const unsubscribe = this.ctx.ui.onTerminalInput((data) => {
      if (!active || this.disposed) return;
      return listener(data);
    });
    const stop = () => {
      if (!active) return;
      active = false;
      this.inputUnsubscribers.delete(stop);
      try {
        unsubscribe();
      } catch {
        // Other owned listeners must still be released during disposal.
      }
    };
    this.inputUnsubscribers.add(stop);
    return stop;
  }

  openOverlay(
    component: DisposableComponent,
    options?: OverlayOptions,
  ): OwnedOverlay {
    if (this.disposed || this.ctx.mode !== "tui" || !this.tui) {
      disposeComponent(component);
      return { close: noop, isFocused: () => false };
    }

    let handle: OverlayHandle;
    try {
      handle = this.tui.showOverlay(component, options);
    } catch (error) {
      disposeComponent(component);
      throw error;
    }

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.overlayClosers.delete(close);
      try {
        handle.hide();
      } catch {
        // Exact-handle teardown must not skip component cleanup.
      } finally {
        disposeComponent(component);
      }
    };
    this.overlayClosers.add(close);
    return {
      close,
      isFocused: () => {
        if (closed || this.disposed) return false;
        try {
          return handle.isFocused();
        } catch {
          return false;
        }
      },
    };
  }

  requestRender(): void {
    if (this.disposed || !this.tui) return;
    try {
      this.tui.requestRender();
    } catch {
      // Rendering a disposed/replaced host is a no-op.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of [...this.inputUnsubscribers]) unsubscribe();
    for (const close of [...this.overlayClosers]) close();
    this.tui = undefined;
    this.editor = undefined;
    if (this.ctx.mode !== "tui") return;
    try {
      this.ctx.ui.setWidget(widgetName, undefined);
    } catch {
      // Lifecycle teardown should remain idempotent even after host replacement.
    }
  }

  private captureEditor(tui: TUI): void {
    if (this.disposed || this.tui || !isFocusTui(tui)) return;
    try {
      if (tui.hasOverlay() || this.ctx.ui.getEditorComponent() !== undefined)
        return;
      const editor = tui.getFocusedComponent();
      if (!(editor instanceof CustomEditor)) return;
      this.tui = tui;
      this.editor = editor;
    } catch {
      // Missing/unstable host capability fails closed.
    }
  }
}

export const createUiHost = (ctx: ExtensionContext): UiHost =>
  new ExtensionUiHost(ctx);
