import { Effect } from "effect";
import { VersionOperationsService } from "@/services/db-version-operations.server";
import { openCourseStorage } from "./course-storage-resolver";
import { isRemoteStorageError } from "./course-storage";

export type PendingRecovery = {
  versionId: string;
  versionName: string;
  receiptState: "committed" | "absent" | "unreadable";
};

export const classifyPendingRecovery = Effect.fn("classifyPendingRecovery")(
  function* (input: { courseId: string; courseName: string }) {
    const versionOps = yield* VersionOperationsService;
    const pending = yield* versionOps.getPendingVersion(input.courseId);
    if (!pending) return null;

    // If the backend cannot be reached or is not authenticated, refuse to
    // classify — same as "mount unreachable" in the old FS world.
    const storage = yield* openCourseStorage(input.courseName).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );

    if (!storage) {
      return {
        versionId: pending.id,
        versionName: pending.name,
        receiptState: "unreadable" as const,
      } satisfies PendingRecovery;
    }

    const receiptState: PendingRecovery["receiptState"] = yield* storage
      .readCommitReceipt()
      .pipe(
        Effect.map((receipt): PendingRecovery["receiptState"] => {
          if (receipt.state === "absent") return "absent";
          try {
            const doc = JSON.parse(receipt.content.toString("utf-8")) as {
              courseVersionId?: unknown;
            };
            return doc.courseVersionId === pending.id ? "committed" : "absent";
          } catch {
            return "unreadable";
          }
        }),
        Effect.catchIf(isRemoteStorageError, () =>
          Effect.succeed<PendingRecovery["receiptState"]>("unreadable")
        )
      );

    return {
      versionId: pending.id,
      versionName: pending.name,
      receiptState,
    } satisfies PendingRecovery;
  }
);
