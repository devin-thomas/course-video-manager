import { Effect } from "effect";
import { courseStorageBackend, type CourseStorage } from "./course-storage";
import { openDropboxCourseStorage } from "./dropbox-course-storage";
import { openGoogleDriveCourseStorage } from "./google-drive-course-storage";

/** The configured backend's view of one Course (`COURSE_STORAGE_BACKEND`). */
export const openCourseStorage = Effect.fn("openCourseStorage")(function* (
  courseName: string
) {
  const backend = yield* courseStorageBackend;
  const storage: CourseStorage =
    backend === "google-drive"
      ? yield* openGoogleDriveCourseStorage(courseName)
      : yield* openDropboxCourseStorage(courseName);
  return storage;
});
