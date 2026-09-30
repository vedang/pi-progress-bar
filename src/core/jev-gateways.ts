import { JevGateway } from "../analysis/gateway";

type GatewayOptions = Omit<
  ConstructorParameters<typeof JevGateway>[0],
  "fetch" | "getApiKey"
>;

type GatewayName =
  | "semantic"
  | "health"
  | "activity"
  | "detail"
  | "subtask"
  | "correction"
  | "continuation"
  | "visibility";

/** Live consent identities, read at each enable in gateway order. */
export interface GatewayIdentities {
  identity: () => string;
  subtask: () => string;
  visibility: () => string;
}

/** One Jev transport over the shared endpoint and environment API key. */
const jevGateway = (options: GatewayOptions) =>
  new JevGateway({
    fetch: (url, init) => globalThis.fetch(url, init),
    getApiKey: () => process.env.TYPESAFE_API_KEY,
    ...options,
  });

/** Independent Jev transports; each keeps its own retry and consent state. */
export class JevGatewaySet {
  readonly semantic: JevGateway;
  /** Optional health has independent retry/permanent-failure state. */
  readonly health: JevGateway;
  /** Optional display-only tool activity never shares semantic transport authority. */
  readonly activity: JevGateway;
  /** Optional grounded details never share semantic/health retry state. */
  readonly detail: JevGateway;
  /** Generic subtask gate has its own durable runtime admission callback. */
  readonly subtask: JevGateway;
  /** Optional corrective binding has its own one-flight transport authority. */
  readonly correction: JevGateway;
  /** Continuation has its own Jev transport; it never borrows semantic capacity. */
  readonly continuation: JevGateway;
  /** Visibility transport and spend are isolated from semantic/advisory telemetry. */
  readonly visibility: JevGateway;

  constructor(options: Record<GatewayName, GatewayOptions>) {
    this.semantic = jevGateway(options.semantic);
    this.health = jevGateway(options.health);
    this.activity = jevGateway(options.activity);
    this.detail = jevGateway(options.detail);
    this.subtask = jevGateway(options.subtask);
    this.correction = jevGateway(options.correction);
    this.continuation = jevGateway(options.continuation);
    this.visibility = jevGateway(options.visibility);
  }

  /** Pause every Jev transport; an active subtask report may keep its own. */
  pauseAll(retainSubtask = false) {
    this.semantic.pause();
    this.health.pause();
    this.activity.pause();
    this.detail.pause();
    if (!retainSubtask) this.subtask.pause();
    this.correction.pause();
    this.continuation.pause();
    this.visibility.pause();
  }

  /** Enable every Jev transport under the current epoch's consent identities. */
  enableAll(identities: GatewayIdentities, retainSubtask = false) {
    this.semantic.enable(identities.identity());
    this.health.enable(identities.identity());
    this.activity.enable(identities.identity());
    this.detail.enable(identities.identity());
    if (!retainSubtask) this.subtask.enable(identities.subtask());
    this.correction.enable(identities.identity());
    this.continuation.enable(identities.identity());
    this.visibility.enable(identities.visibility());
  }
}
