import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Monitor } from "../../src/core/monitor";
import { paint } from "../../src/ui/widget";

export function renderWidget(monitor: Monitor): string[] {
  let lines: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      setWidget: (
        _name: string,
        factory: (
          _tui: unknown,
          theme: { fg: (color: string, text: string) => string },
        ) => { render: (width: number) => string[] },
      ) => {
        lines = factory({}, { fg: (_color, text) => text }).render(200);
      },
    },
  } as unknown as ExtensionContext;
  paint(ctx, monitor);
  return lines;
}
