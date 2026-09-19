import { appendFileSync } from "node:fs";
import {
  CustomEditor,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  isKeyRelease,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import { createUiHost } from "../../src/ui/host";

/** Opt-in, static actual-host probe. No monitor, provider or session writes. */
export default function uiHostProbe(pi: ExtensionAPI) {
  const output = process.env.PROGRESS_UI_PROBE_OUTPUT;
  if (!output) return;
  const record = (data: object) =>
    appendFileSync(output, `${JSON.stringify(data)}\n`);
  let unsubscribe: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") throw new Error("Probe requires TUI mode");
    type FocusTui = TUI & { getFocusedComponent(): Component | null };
    const captured: { host?: FocusTui; editor?: Component | null } = {};
    const uiHost = createUiHost(ctx);
    uiHost.attach((tui) => {
      if (
        !("getFocusedComponent" in tui) ||
        typeof tui.getFocusedComponent !== "function"
      )
        throw new Error("Host does not expose focus identity");
      const host = tui as FocusTui;
      const editor = host.getFocusedComponent();
      captured.host = host;
      captured.editor = editor;
      record({
        event: "capture",
        canonicalEditor: editor instanceof CustomEditor,
        customFactory: ctx.ui.getEditorComponent() !== undefined,
        overlay: tui.hasOverlay(),
        ownedOverlay: typeof tui.showOverlay === "function",
      });
      return { render: () => ["UX host probe"], invalidate() {} };
    });
    const { host, editor } = captured;
    if (!host || !(editor instanceof CustomEditor)) {
      record({ event: "failed", reason: "No canonical editor identity" });
      ctx.shutdown();
      return;
    }
    const tui = host;
    const board: Component = {
      render: () => ["Owned board"],
      invalidate() {},
    };
    const sibling: Component = {
      render: () => ["Other extension"],
      invalidate() {},
    };
    const first = uiHost.openOverlay(board, { width: "94%", maxHeight: "80%" });
    const second = tui.showOverlay(sibling);
    first.close();
    first.close();
    record({
      event: "ownership",
      siblingFocused: second.isFocused(),
      siblingPreserved: tui.getFocusedComponent() === sibling,
    });
    second.hide();
    record({
      event: "restore",
      editorRestored: tui.getFocusedComponent() === editor,
      noOverlay: !tui.hasOverlay(),
    });
    // The first listener proves later listeners receive transformed data.
    const transform = ctx.ui.onTerminalInput((data) =>
      data === "~" ? { data: "\x1b[C" } : undefined,
    );
    const input = uiHost.onInput((data) => {
      if (matchesKey(data, "f10")) {
        record({ event: "done" });
        ctx.shutdown();
        return { consume: true };
      }
      if (!matchesKey(data, "right") || isKeyRelease(data)) return;
      const allowed = uiHost.canActivate(data);
      record({ event: "right", allowed, editorText: ctx.ui.getEditorText() });
      return allowed ? { consume: true } : undefined;
    });
    unsubscribe = () => {
      input();
      transform();
      uiHost.dispose();
    };
    record({ event: "ready" });
  });
  pi.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
    record({ event: "shutdown" });
  });
}
