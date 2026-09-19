import { Effect } from "effect";
import { courseStorageBackend } from "./course-storage";
import { openDropboxCourseStorage } from "./dropbox-course-storage";

/** The configured backend's view of one Course (`COURSE_STORAGE_BACKEND`). */
export const openCourseStorage = Effect.fn("openCourseStorage")(function* (
  courseName: string
) {
  const backend = yield* courseStorageBackend;
  switch (backend) {
    case "dropbox":
      return yield* openDropboxCourseStorage(courseName);
    case "google-drive":
      return yield* Effect.dieMessage(
        "The google-drive course storage backend is not implemented yet"
      );
  }
});
