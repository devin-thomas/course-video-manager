import type {
  AgentCommandOptions,
  AgentProvider,
  PrintCommand,
} from "@ai-hero/sandcastle";

// The SDK doesn't export `ParsedStreamEvent` by name (it's used only as
// `AgentProvider["parseStreamLine"]`'s return element type), so it's derived
// structurally here instead of duplicated by hand.
type ParsedStreamEvent = ReturnType<AgentProvider["parseStreamLine"]>[number];

/** Options for {@link AntigravityProvider}. */
export interface AntigravityOptions {
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
}

/**
 * Custom `AgentProvider` for Google Antigravity's `agy` CLI — not shipped by
 * `@ai-hero/sandcastle`. See ADR 0030 and §7 of
 * docs/agents/multi-vendor-sandcastle-spec.md. Upstream contribution to the
 * SDK is a stretch goal, not a blocker for this in-repo implementation.
 *
 * `agy` resumes a conversation through its own `--conversation <id>` flag
 * rather than a locally captured session file, so this provider — like the
 * SDK's own `cursor`/`opencode`/`copilot` providers — does not implement
 * `sessionStorage`. The session id instead surfaces as a `session_id` stream
 * event, read from the `result` event's `conversation_id` field, which is
 * enough for `runWithRetry`/`runWithExtraction` to resume via `resumeSession`.
 *
 * `buildPrintCommand` omits `--json-schema`: `AgentCommandOptions` carries no
 * schema, and the harness already validates structured output itself
 * (ADR 0030's "harness-side validation" principle), so no vendor-native
 * schema enforcement is required here.
 */
export class AntigravityProvider implements AgentProvider {
  readonly name = "antigravity";
  readonly env: Record<string, string>;
  readonly captureSessions = true;

  constructor(
    // `agy` has no documented model-selection flag today — kept for
    // signature parity with the SDK's own provider factories
    // (claudeCode(model, opts), codex(model, opts), cursor(model, opts)).
    private readonly model: string,
    options: AntigravityOptions = {}
  ) {
    this.env = options.env ?? {};
  }

  buildPrintCommand(options: AgentCommandOptions): PrintCommand {
    const args = [
      "agy",
      "-p",
      shellQuote(options.prompt),
      "--output-format",
      "stream-json",
    ];
    if (options.resumeSession) {
      args.push("--conversation", shellQuote(options.resumeSession));
    }
    return { command: args.join(" ") };
  }

  parseStreamLine(line: string): ParsedStreamEvent[] {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return [];
    }

    if (typeof event !== "object" || event === null || !("type" in event)) {
      return [];
    }

    switch ((event as { type: unknown }).type) {
      case "result":
        return parseResultEvent(event as AntigravityResultEvent);
      case "step_update":
        return parseStepUpdateEvent(event as AntigravityStepUpdateEvent);
      case "init":
      default:
        // Session start and any other/unrecognized event types carry no
        // signal this harness surfaces — the session id is read from the
        // `result` event instead (see class docstring).
        return [];
    }
  }
}

interface AntigravityUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

interface AntigravityResultEvent {
  readonly conversation_id?: string;
  readonly result?: string;
  readonly usage?: AntigravityUsage;
  readonly denied_actions?: readonly unknown[];
}

interface AntigravityStepUpdateEvent {
  readonly text?: string;
  readonly message?: string;
}

function parseResultEvent(event: AntigravityResultEvent): ParsedStreamEvent[] {
  if (event.denied_actions && event.denied_actions.length > 0) {
    // `agy` exits 0 even when tools are denied in headless mode, so exit
    // code alone can't signal failure. ParsedStreamEvent has no "error"
    // variant, so a thrown error is the only way this stream parser can
    // make the harness treat the run as failed rather than successful.
    throw new Error(
      `Antigravity denied ${event.denied_actions.length} action(s) during this run: ` +
        JSON.stringify(event.denied_actions)
    );
  }

  const events: ParsedStreamEvent[] = [
    { type: "result", result: event.result ?? "" },
  ];

  if (event.conversation_id) {
    events.push({ type: "session_id", sessionId: event.conversation_id });
  }

  if (
    typeof event.usage?.input_tokens === "number" &&
    typeof event.usage?.output_tokens === "number"
  ) {
    events.push({
      type: "usage",
      usage: {
        inputTokens: event.usage.input_tokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: event.usage.output_tokens,
      },
    });
  }

  return events;
}

function parseStepUpdateEvent(
  event: AntigravityStepUpdateEvent
): ParsedStreamEvent[] {
  const text = event.text ?? event.message;
  return text ? [{ type: "text", text }] : [];
}

/** POSIX single-quote shell escaping, safe for arbitrary prompt/id text. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
