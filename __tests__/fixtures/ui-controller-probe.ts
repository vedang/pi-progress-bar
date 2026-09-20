import { appendFileSync } from "node:fs";
import {
  CustomEditor,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createUiController } from "../../src/ui/controller";
import { createUiHost, type UiHost } from "../../src/ui/host";
import { uxView } from "./ux-view";

/** Actual-host static controller probe: no monitor/provider/session persistence. */
export default function probe(pi: ExtensionAPI) {
  const output = process.env.PROGRESS_UI_PROBE_OUTPUT;
  if (!output) return;
  const record = (data: object) =>
    appendFileSync(output, `${JSON.stringify(data)}\n`);
  let cleanup = () => {};
  let networkAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkAttempts++;
    throw new Error("UI probe forbids network");
  };
  pi.on("session_start", (_event, ctx) => {
    if (
      process.env.PROGRESS_UI_COLOAD === "1" &&
      !pi.getAllTools().some((tool) => tool.name === "subagent")
    )
      throw new Error("Expected actual pi-subagents co-load");
    const base = createUiHost(ctx);
    let component: Component | undefined;
    let columns = 80;
    const transformedFirst =
      process.env.PROGRESS_UI_LISTENER_ORDER === "before";
    let stopTransform = () => {};
    const transform = () =>
      ctx.ui.onTerminalInput((data) =>
        data === "~" ? { data: "\x1b[C" } : undefined,
      );
    if (transformedFirst) stopTransform = transform();
    const host: UiHost = {
      attach: (factory) =>
        base.attach((tui, theme) => {
          columns = tui.terminal.columns;
          component = factory(tui, theme);
          return component;
        }),
      canActivate: (data) => base.canActivate(data),
      onInput: (handler) =>
        base.onInput((data) => {
          const result = handler(data);
          if (
            matchesKey(data, "right") ||
            matchesKey(data, "left") ||
            matchesKey(data, "enter") ||
            data === "~"
          )
            record({
              event: "input",
              data,
              consumed: result?.consume === true,
              selected: component?.render(160).join("\n").includes("200 calls"),
              custom: ctx.ui.getEditorComponent() !== undefined,
            });
          return result;
        }),
      openOverlay: (view, options) => {
        const owned = base.openOverlay(view, options);
        const lines = view.render(Math.floor(columns * 0.94));
        record({
          event: "board-request",
          options,
          lines,
          widths: lines.map(visibleWidth),
        });
        return {
          isFocused: () => owned.isFocused(),
          close: () => {
            owned.close();
            record({ event: "board-closed" });
          },
        };
      },
      requestRender: () => base.requestRender(),
      dispose: () => base.dispose(),
    };
    const view = uxView();
    if (process.env.PROGRESS_UI_RICH === "1") {
      const task = view.board.tasks[0];
      if (!task) throw new Error("Missing static probe task");
      const provenance = {
        role: "user" as const,
        validatedAt: 1,
        confidence: 1,
        probability: 1,
      };
      task.details = {
        title: { text: "Parser task", provenance },
        description: { text: "Preserve escaped commas 😀", provenance },
        acceptanceCriteria: [
          { text: "Quoted delimiters remain in the field", provenance },
        ],
      };
    }
    const controller = createUiController(host, view);
    if (!transformedFirst) stopTransform = transform();
    const stop = ctx.ui.onTerminalInput((data) => {
      if (matchesKey(data, "f7")) {
        ctx.ui.setEditorComponent(
          (tui, theme, keys) => new CustomEditor(tui, theme, keys),
        );
        record({ event: "custom-installed" });
        return { consume: true };
      }
      if (matchesKey(data, "f10")) {
        ctx.shutdown();
        return { consume: true };
      }
    });
    cleanup = () => {
      stop();
      stopTransform();
      controller.dispose();
    };
    record({
      event: "ready",
      transformedFirst,
      materialized: !!component,
      coLoaded: pi.getAllTools().some((tool) => tool.name === "subagent"),
    });
  });
  pi.on("session_shutdown", () => {
    cleanup();
    globalThis.fetch = originalFetch;
    record({ event: "shutdown", networkAttempts });
    if (networkAttempts) throw new Error("Unexpected UI network work");
  });
}
