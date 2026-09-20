import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Real CLI transport characterization only. No production advisory code and no
// external provider. All records are synthetic and emitted only by this fixture.
export default function advisoryModeProbe(pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "advisory-probe" });
  faux.setResponses([
    fauxAssistantMessage("Independent answer."),
    fauxAssistantMessage("Status answer: pending."),
  ]);
  pi.registerProvider(faux.provider);
  let sent = false;
  let idleDeadline: ReturnType<typeof setTimeout> | undefined;
  pi.on("session_shutdown", () => {
    process.stderr.write(
      `${JSON.stringify({ probe: "advisory-shutdown", armed: idleDeadline !== undefined })}\n`,
    );
    clearTimeout(idleDeadline);
  });
  pi.on("message_update", () => {
    if (sent) return;
    sent = true;
    pi.sendMessage(
      {
        customType: "pi-progress-advisory",
        content: "[Progress advisory] Status reconciliation only.",
        display: true,
        details: { opportunityId: "probe-1", sendId: "probe-send-1" },
      },
      { deliverAs: "steer" },
    );
  });
  pi.on("agent_settled", (_event, ctx) => {
    idleDeadline = setTimeout(() => {
      process.stderr.write("UNEXPECTED_IDLE_DEADLINE\n");
    }, 60_000);
    const custom = ctx.sessionManager
      .getBranch()
      .filter((e) => e.type === "custom_message");
    process.stderr.write(
      `${JSON.stringify({ probe: "advisory-settled", mode: ctx.mode, custom, calls: faux.state.callCount })}\n`,
    );
  });
}
