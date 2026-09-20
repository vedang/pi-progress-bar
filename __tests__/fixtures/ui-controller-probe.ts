import { appendFileSync } from "node:fs";
import {
  CustomEditor,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey } from "@earendil-works/pi-tui";
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
  pi.on("session_start", (_event, ctx) => {
    const base = createUiHost(ctx);
    let component: Component | undefined;
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
        record({ event: "board-request", options, lines: view.render(75) });
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
    // U10 removes the inert callback seam; use static call after implementation.
    const controller = Reflect.apply(createUiController, undefined, [
      host,
      uxView(),
    ]) as ReturnType<typeof createUiController>;
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
    record({ event: "ready", transformedFirst, materialized: !!component });
  });
  pi.on("session_shutdown", () => {
    cleanup();
    record({ event: "shutdown" });
  });
}
