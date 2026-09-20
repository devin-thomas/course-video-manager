import { toast } from "sonner";
import type { uploadReducer } from "./upload-reducer";

/**
 * Shows a toast notification when an upload transitions to "success".
 */
export function showSuccessToast(upload: uploadReducer.UploadEntry): void {
  if (upload.uploadType === "export") {
    toast.success(`"${upload.title}" exported successfully`, {
      duration: Infinity,
      cancel: {
        label: "Open",
        onClick: () => {
          fetch(`/api/videos/${upload.videoId}/reveal`, {
            method: "POST",
          }).catch(() => {});
        },
      },
    });
  } else if (upload.uploadType === "autofill") {
    // The Autofill never rolls on into a Publish — the second press is the
    // author's. So the toast carries them back to where that press happens.
    const publishUrl = `/courses/${upload.courseId}/publish`;
    toast.success(`${upload.title} finished`, {
      duration: Infinity,
      action: {
        label: "Back to Publish",
        onClick: () => {
          window.location.href = publishUrl;
        },
      },
    });
  } else if (upload.uploadType === "publish") {
    const newDraftVersionId = upload.newDraftVersionId;
    const courseId = upload.courseId;
    toast.success(`"${upload.title}" published successfully`, {
      duration: Infinity,
      action: newDraftVersionId
        ? {
            label: "Go to Draft",
            onClick: () => {
              window.location.href = `/courses/${courseId}?versionId=${newDraftVersionId}`;
            },
          }
        : undefined,
    });
  }
}

/**
 * Shows a toast notification when an upload transitions to "error".
 */
export function showErrorToast(upload: uploadReducer.UploadEntry): void {
  const postUrl = `/videos/${upload.videoId}/post`;

  toast.error(`"${upload.title}" upload failed: ${upload.errorMessage}`, {
    duration: Infinity,
    cancel: {
      label: "Go to Post",
      onClick: () => {
        window.location.href = postUrl;
      },
    },
  });
}
