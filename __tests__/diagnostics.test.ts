import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { Monitor } from "../src/core/monitor";
import { command } from "../src/ui/commands";
import { replayEntries } from "./fixtures/live-session";

describe("bounded progress diagnostics", () => {
  it("distinguishes pending discovery, missing scope and service failure", () => {
    const monitor = new Monitor(vi.fn(), vi.fn());
    expect(monitor.progressState()).toBe("Monitoring off");
    monitor.enabled = true;
    expect(monitor.progressState()).toMatch(/no actionable/i);
    monitor.observe(() => replayEntries());
    expect(monitor.progressState()).toMatch(/updating scope/i);
    monitor.error = "Jev unavailable";
    expect(monitor.progressState()).toMatch(/unavailable/i);
    monitor.stop();
  });

  it("caps diagnostic counts and retains only bounded reason codes, never original text", () => {
    const monitor = new Monitor(vi.fn(), vi.fn());
    for (let i = 0; i < 1100; i++)
      monitor.conversation.note("candidate-rejected");
    monitor.conversation.note("Private source text\nAuthorization: secret");
    expect(monitor.diagnostics()).toEqual([
      { code: "candidate-rejected", count: 999 },
    ]);
    for (let i = 0; i < 20; i++)
      monitor.conversation.note(`reason-${String.fromCharCode(97 + i)}`);
    expect(monitor.conversation.diagnostics()).toHaveLength(12);
    expect(monitor.diagnosticSummary()).not.toMatch(
      /Private|secret|Authorization/,
    );
    expect(JSON.stringify(monitor.checkpoint())).not.toContain("reason-");
    monitor.stop();
  });

  it("shows freshness and rejection diagnostics in existing help without new commands", async () => {
    const monitor = new Monitor(vi.fn(), vi.fn());
    monitor.conversation.note("candidate-rejected");
    monitor.gateway.status =
      "Offline / invalid response / timeout; retry backed off";
    monitor.error = "Service unavailable";
    const notify = vi.fn();
    await command(
      "",
      { hasUI: true, ui: { notify } } as unknown as ExtensionCommandContext,
      monitor,
    );
    const help = notify.mock.calls[0]?.[0];
    expect(help).toContain("Progress: Monitoring off");
    expect(help).toMatch(/Last Jev call[^\n]*never/i);
    expect(help).toContain("Diagnostics: candidate-rejected:1");
    expect(help).toContain("Service unavailable");
    expect(help).toContain("retry backed off");
    expect(help).toContain("/progress interval <seconds>");
    expect(help).not.toContain("/progress reset");
    monitor.stop();
  });
});
