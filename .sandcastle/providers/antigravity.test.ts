import { describe, it, expect } from "vitest";
import { AntigravityProvider } from "./antigravity";

function provider(env: Record<string, string> = {}): AntigravityProvider {
  return new AntigravityProvider("antigravity-1", { env });
}

describe("AntigravityProvider", () => {
  it("implements the base AgentProvider identity fields", () => {
    const p = provider({ SOME_VAR: "value" });

    expect(p.name).toBe("antigravity");
    expect(p.captureSessions).toBe(true);
    expect(p.env).toEqual({ SOME_VAR: "value" });
  });

  it("defaults env to an empty object when none is passed", () => {
    expect(new AntigravityProvider("antigravity-1").env).toEqual({});
  });

  describe("buildPrintCommand", () => {
    it("builds the base agy invocation with the prompt and stream-json", () => {
      const command = provider().buildPrintCommand({
        prompt: "do the thing",
        dangerouslySkipPermissions: true,
      });

      expect(command.command).toBe(
        "agy -p 'do the thing' --output-format stream-json"
      );
    });

    it("appends --conversation when resuming a session", () => {
      const command = provider().buildPrintCommand({
        prompt: "continue",
        dangerouslySkipPermissions: true,
        resumeSession: "conv-123",
      });

      expect(command.command).toBe(
        "agy -p 'continue' --output-format stream-json --conversation 'conv-123'"
      );
    });

    it("safely escapes single quotes in the prompt", () => {
      const command = provider().buildPrintCommand({
        prompt: "it's a test",
        dangerouslySkipPermissions: true,
      });

      expect(command.command).toBe(
        "agy -p 'it'\\''s a test' --output-format stream-json"
      );
    });
  });

  describe("parseStreamLine", () => {
    it("ignores blank lines", () => {
      expect(provider().parseStreamLine("")).toEqual([]);
      expect(provider().parseStreamLine("   ")).toEqual([]);
    });

    it("ignores lines that aren't valid JSON", () => {
      expect(provider().parseStreamLine("not json")).toEqual([]);
    });

    it("ignores an init event", () => {
      expect(
        provider().parseStreamLine(JSON.stringify({ type: "init" }))
      ).toEqual([]);
    });

    it("emits a text event for a step_update with text", () => {
      const events = provider().parseStreamLine(
        JSON.stringify({ type: "step_update", text: "reading files" })
      );

      expect(events).toEqual([{ type: "text", text: "reading files" }]);
    });

    it("emits a text event for a step_update with message instead of text", () => {
      const events = provider().parseStreamLine(
        JSON.stringify({ type: "step_update", message: "running tests" })
      );

      expect(events).toEqual([{ type: "text", text: "running tests" }]);
    });

    it("emits nothing for a step_update with neither text nor message", () => {
      expect(
        provider().parseStreamLine(JSON.stringify({ type: "step_update" }))
      ).toEqual([]);
    });

    it("emits result, session_id, and usage events for a result line", () => {
      const events = provider().parseStreamLine(
        JSON.stringify({
          type: "result",
          result: "done",
          conversation_id: "conv-123",
          usage: { input_tokens: 100, output_tokens: 40 },
        })
      );

      expect(events).toEqual([
        { type: "result", result: "done" },
        { type: "session_id", sessionId: "conv-123" },
        {
          type: "usage",
          usage: {
            inputTokens: 100,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: 40,
          },
        },
      ]);
    });

    it("omits the session_id event when conversation_id is absent", () => {
      const events = provider().parseStreamLine(
        JSON.stringify({ type: "result", result: "done" })
      );

      expect(events).toEqual([{ type: "result", result: "done" }]);
    });

    it("omits the usage event when usage is absent", () => {
      const events = provider().parseStreamLine(
        JSON.stringify({
          type: "result",
          result: "done",
          conversation_id: "conv-123",
        })
      );

      expect(events).toEqual([
        { type: "result", result: "done" },
        { type: "session_id", sessionId: "conv-123" },
      ]);
    });

    it("throws when the result event carries denied_actions, instead of succeeding", () => {
      expect(() =>
        provider().parseStreamLine(
          JSON.stringify({
            type: "result",
            result: "done",
            denied_actions: [{ tool: "bash", reason: "blocked" }],
          })
        )
      ).toThrow(/denied 1 action/);
    });

    it("does not throw when denied_actions is an empty array", () => {
      const events = provider().parseStreamLine(
        JSON.stringify({ type: "result", result: "done", denied_actions: [] })
      );

      expect(events).toEqual([{ type: "result", result: "done" }]);
    });
  });
});
