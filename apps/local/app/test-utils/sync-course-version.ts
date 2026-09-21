import {
  noExportPhase,
  syncFrozenCourseVersionToRemote,
} from "@/services/course-publish-sync";

/**
 * Drive the Commit half of a Publish on its own: ship an already-frozen
 * Course Version's Bundle and replace its `course.json` receipt, with no
 * export phase in front (every Video's bytes are on disk already, or missing).
 *
 * Only tests do this. It used to be reachable as a manual re-sync route, but
 * that route had no caller and was deleted; this is the same call the route
 * made, kept so the upload tests can exercise the sync without a Submit.
 */
export const syncCourseVersion = (
  courseId: string,
  courseVersionId: string,
  includeTodoLessons: boolean,
  onProgress?: (event: "progress", data: { percentage: number }) => void
) =>
  syncFrozenCourseVersionToRemote({
    courseId,
    courseVersionId,
    includeTodoLessons,
    onDetailEvent: (e) => {
      if (e.event === "progress") onProgress?.("progress", e.data);
    },
    awaitVideoReady: noExportPhase,
  });
