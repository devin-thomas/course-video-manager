import { openGoogleDriveCourseStorage } from "./google-drive-course-storage";

/**
 * The `CourseStorage` a Publish writes one Course into. Google Drive is the
 * only backend; callers go through here so they depend on `CourseStorage`
 * alone.
 */
export const openCourseStorage = openGoogleDriveCourseStorage;
