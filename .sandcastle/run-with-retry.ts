import {
  run,
  StructuredOutputError,
  type OutputObjectDefinition,
  type RunOptions,
  type RunResult,
} from "@ai-hero/sandcastle";
import { buildRetryFeedback } from "./retry-feedback";

/**
 * Options for {@link runWithRetry} — the standard `run()` options with `output`
 * required and a `maxAttempts` cap added.
 */
export interface RunWithRetryOptions<T> extends Omit<RunOptions, "output"> {
  /** Structured output to extract. Applied to the first call and every retry. */
  readonly output: OutputObjectDefinition<T>;
  /**
   * Total number of attempts (the first call plus retries) before giving up.
   * Default: 3 — one initial call and up to two resumed retries.
   */
  readonly maxAttempts?: number;
}

/**
 * Run an agent in a single call that both does the work and emits structured
 * output, retrying the *same session* if extraction fails.
 *
 * Use this for **side-effect-free** scripts where the structured output IS the
 * work (e.g. drafting a PR title/description, breaking a PRD into slices). For
 * these, splitting into a separate produce + extract pass (see
 * {@link import("./run-with-extraction").runWithExtraction}) buys nothing — the
 * drafting and the emission are the same act — so we keep one combined prompt:
 *
 * 1. Run `prompt`/`promptFile` WITH the `output` definition. On the happy path
 *    this is a single call.
 * 2. Re-validate the returned `output` against `output.schema` ourselves
 *    (Standard Schema's `~standard.validate`), regardless of whether
 *    Sandcastle's own per-vendor extraction already validated it — ADR 0030's
 *    harness-side validation principle: correctness must not depend on how
 *    thoroughly a given vendor's CLI enforces the schema natively.
 * 3. If `run()` throws {@link StructuredOutputError}, or step 2's re-validation
 *    fails, resume that same session (via the session id) with a feedback
 *    message describing exactly what it emitted and why it failed. The session
 *    still holds all the agent's work, so it only needs to re-emit corrected
 *    output — nothing is re-done. Retry up to `maxAttempts` times total.
 *
 * Resuming the failed session (rather than re-running from scratch) needs the
 * run's session id — carried on `StructuredOutputError.sessionId` for a native
 * extraction failure, or read from `result.iterations` for a harness-side
 * validation failure. Whether a given run actually captured one depends on the
 * active `AgentProvider`, not on any one vendor.
 *
 * Throws the final {@link StructuredOutputError} if every attempt fails, which
 * mirrors the pre-wrapper failure path.
 */
export async function runWithRetry<T>(
  options: RunWithRetryOptions<T>
): Promise<RunResult & { output: T }> {
  const { output, maxAttempts = 3, ...runOptions } = options;

  let lastError: StructuredOutputError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let result: RunResult & { output: T };

      if (!lastError) {
        // First attempt: the original prompt does the work AND emits output.
        result = await run({ ...runOptions, output });
      } else {
        // Retry: resume the failed session and feed back what went wrong. The
        // session still holds everything the agent did, so it only re-emits.
        const sessionId = lastError.sessionId;
        if (!sessionId) {
          throw new Error(
            "runWithRetry: the failed run carried no sessionId, so it cannot be " +
              `resumed for a retry. The "${runOptions.agent.name}" provider may not ` +
              "support session capture in its current configuration."
          );
        }

        // The retry uses an inline `prompt` (the feedback message), so drop
        // `promptArgs` — Sandcastle only allows promptArgs alongside a promptFile,
        // and the feedback prompt needs no substitution.
        const { promptArgs: _retryArgs, ...retryOptions } = runOptions;
        result = await run({
          ...retryOptions,
          name: runOptions.name
            ? `${runOptions.name} (retry ${attempt - 1})`
            : undefined,
          promptFile: undefined,
          prompt: buildRetryFeedback(lastError, attempt, maxAttempts),
          resumeSession: sessionId,
          output,
        });
      }

      const validation = await validateStandardSchema(
        output.schema,
        result.output
      );
      if (validation.success) {
        return result;
      }

      // Harness-side validation failed even though the run itself succeeded
      // (and Sandcastle's own extraction, if any, didn't catch it for this
      // vendor). Route it through the same StructuredOutputError retry path
      // as a native extraction failure.
      lastError = new StructuredOutputError(
        "runWithRetry: harness-side schema validation failed for the agent's structured output.",
        {
          tag: output.tag,
          rawMatched: JSON.stringify(result.output),
          cause: validation.issues,
          commits: result.commits,
          branch: result.branch,
          sessionId: result.iterations.at(-1)?.sessionId,
        }
      );
    } catch (error) {
      if (error instanceof StructuredOutputError) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

/**
 * Validate a value against a Standard Schema (the protocol `OutputObjectDefinition`
 * schemas already implement — zod v4 native, among others) without depending on
 * `@standard-schema/spec` as a direct dependency: `OutputObjectDefinition["schema"]`
 * already carries the full type from `@ai-hero/sandcastle`'s own declaration.
 */
async function validateStandardSchema<T>(
  schema: OutputObjectDefinition<T>["schema"],
  value: unknown
) {
  const result = await schema["~standard"].validate(value);
  return result.issues
    ? ({ success: false as const, issues: result.issues } as const)
    : ({ success: true as const } as const);
}
