import { Effect } from "effect";
import type { CourseStorage } from "./course-storage";
import { openGoogleDriveCourseStorage } from "./google-drive-course-storage";

/**
 * The storage a Publish writes one Course into. Google Drive is the only
 * backend; callers go through here so they depend on `CourseStorage` alone.
 */
export const openCourseStorage = Effect.fn("openCourseStorage")(function* (
  courseName: string
) {
  const storage: CourseStorage =
    yield* openGoogleDriveCourseStorage(courseName);
  return storage;
});
