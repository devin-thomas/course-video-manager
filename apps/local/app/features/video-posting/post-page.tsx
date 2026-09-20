"use client";

import { useState } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { toast } from "sonner";
import { useFetcher } from "react-router";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { CopyIcon, LinkIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import type { CourseStructure } from "@/components/video-context-panel";
import type { SectionWithWordCount } from "@/features/article-writer/types";
import { PostPageOverwriteDialog } from "./post-page-overwrite-dialog";
import { ThumbnailSelector } from "./post-page-thumbnail-selector";
import { validateYoutubeTitle } from "./post-page-validation";
import { getAutoSelectThumbnailId } from "./auto-select-thumbnail";
import {
  findConvertibleAiHeroUrls,
  hasAiHeroUrls,
  replaceUrls,
} from "./convert-short-links";

const POST_TITLE_STORAGE_KEY = (videoId: string) => `post-title-${videoId}`;
const POST_DESCRIPTION_STORAGE_KEY = (videoId: string) =>
  `post-description-${videoId}`;
export function PostPage({
  videoId,
  thumbnails,
  enabledFiles,
  enabledSections,
  includeTranscript,
  courseStructure,
  includeCourseStructure,
  chapters,
  pitchYoutubeTitle,
}: {
  videoId: string;
  thumbnails: Array<{ id: string }>;
  enabledFiles: Set<string>;
  enabledSections: Set<string>;
  includeTranscript: boolean;
  courseStructure: CourseStructure | null;
  includeCourseStructure: boolean;
  chapters: SectionWithWordCount[];
  pitchYoutubeTitle: string | null;
}) {
  const [title, setTitle] = useLocalStorage(
    POST_TITLE_STORAGE_KEY(videoId),
    pitchYoutubeTitle ?? ""
  );
  const [description, setDescription] = useLocalStorage(
    POST_DESCRIPTION_STORAGE_KEY(videoId)
  );

  // AI generation state
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
  const [isGeneratingDescription, setIsGeneratingDescription] = useState(false);

  // Confirmation dialog state
  const [confirmOverwriteField, setConfirmOverwriteField] = useState<
    "title" | "description" | null
  >(null);
  const [pendingGeneratedText, setPendingGeneratedText] = useState<string>("");
  const [currentFieldText, setCurrentFieldText] = useState<string>("");

  // Visibility state

  const generateContent = async (
    mode: "youtube-title" | "youtube-title-single" | "youtube-description"
  ) => {
    const transcriptEnabled =
      chapters.length > 0 ? enabledSections.size > 0 : includeTranscript;

    const response = await fetch(`/api/videos/${videoId}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        enabledFiles: Array.from(enabledFiles),
        includeTranscript: transcriptEnabled,
        enabledSections: Array.from(enabledSections),
        courseStructure:
          includeCourseStructure && courseStructure
            ? courseStructure
            : undefined,
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to generate content");
    }

    const result = await response.json();
    return result.text as string;
  };

  const handleGenerateTitle = async () => {
    setIsGeneratingTitle(true);
    try {
      const generatedText = await generateContent("youtube-title-single");
      if (title.trim()) {
        setCurrentFieldText(title);
        setPendingGeneratedText(generatedText);
        setConfirmOverwriteField("title");
      } else {
        setTitle(generatedText);
      }
    } catch (error) {
      console.error("Failed to generate title:", error);
    } finally {
      setIsGeneratingTitle(false);
    }
  };

  const handleGenerateDescription = async () => {
    setIsGeneratingDescription(true);
    try {
      const generatedText = await generateContent("youtube-description");
      if (description.trim()) {
        setCurrentFieldText(description);
        setPendingGeneratedText(generatedText);
        setConfirmOverwriteField("description");
      } else {
        setDescription(generatedText);
      }
    } catch (error) {
      console.error("Failed to generate description:", error);
    } finally {
      setIsGeneratingDescription(false);
    }
  };

  const handleConfirmOverwrite = () => {
    if (confirmOverwriteField === "title") {
      setTitle(pendingGeneratedText);
    } else if (confirmOverwriteField === "description") {
      setDescription(pendingGeneratedText);
    }
    setConfirmOverwriteField(null);
    setPendingGeneratedText("");
    setCurrentFieldText("");
  };

  const handleCancelOverwrite = () => {
    setConfirmOverwriteField(null);
    setPendingGeneratedText("");
    setCurrentFieldText("");
  };

  const handleCopyFromPitch = () => {
    if (!pitchYoutubeTitle) return;

    if (title.trim()) {
      setCurrentFieldText(title);
      setPendingGeneratedText(pitchYoutubeTitle);
      setConfirmOverwriteField("title");
    } else {
      setTitle(pitchYoutubeTitle);
    }
  };

  const titleValidationError = validateYoutubeTitle(title);

  const [selectedThumbnailId, setSelectedThumbnailId] = useState<string | null>(
    () => getAutoSelectThumbnailId(thumbnails)
  );

  const deleteThumbnailFetcher = useFetcher();

  const handleDeleteThumbnail = (thumbnailId: string) => {
    if (!confirm("Delete this thumbnail?")) return;
    if (thumbnailId === selectedThumbnailId) {
      setSelectedThumbnailId(null);
    }
    deleteThumbnailFetcher.submit(null, {
      method: "post",
      action: `/api/thumbnails/${thumbnailId}/delete`,
    });
  };

  // Short link conversion state
  const [isConvertingShortLinks, setIsConvertingShortLinks] = useState(false);

  const handleConvertToShortLinks = async () => {
    const convertibleUrls = findConvertibleAiHeroUrls(description);

    if (!hasAiHeroUrls(description)) {
      toast("No aihero.dev links found", {
        description: "The description doesn't contain any aihero.dev URLs.",
      });
      return;
    }

    if (convertibleUrls.length === 0) {
      toast("All links already converted", {
        description: "All aihero.dev links are already short links.",
      });
      return;
    }

    setIsConvertingShortLinks(true);
    try {
      const replacements = new Map<string, string>();
      for (const url of convertibleUrls) {
        const response = await fetch("/api/shortlinks/find-or-create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url,
            description: `YouTube (${title || "Untitled"})`,
          }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to create short link");
        }

        const { shortLinkUrl } = await response.json();
        replacements.set(url, shortLinkUrl);
      }

      setDescription(replaceUrls(description, replacements));
      toast("Links converted", {
        description: `Converted ${convertibleUrls.length} aihero.dev URL${convertibleUrls.length > 1 ? "s" : ""} to short links.`,
      });
    } catch (error) {
      console.error("Failed to convert short links:", error);
      toast.error("Failed to convert links", {
        description:
          error instanceof Error ? error.message : "An error occurred",
      });
    } finally {
      setIsConvertingShortLinks(false);
    }
  };

  return (
    <>
      <div className="max-w-2xl mx-auto w-full space-y-6">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="title">Title</Label>
            <div className="flex items-center gap-2">
              {pitchYoutubeTitle && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyFromPitch}
                >
                  <CopyIcon className="h-4 w-4" />
                  Copy from Pitch
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerateTitle}
                disabled={isGeneratingTitle || isGeneratingDescription}
              >
                {isGeneratingTitle ? (
                  <>
                    <Loader2Icon className="h-4 w-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <SparklesIcon className="h-4 w-4" />
                    Generate
                  </>
                )}
              </Button>
            </div>
          </div>
          <Textarea
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Enter video title..."
            className="text-lg min-h-[60px] resize-y"
          />
          {titleValidationError && (
            <p className="text-sm text-destructive">{titleValidationError}</p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="description">Description</Label>
            <Button
              variant="outline"
              size="sm"
              onClick={handleGenerateDescription}
              disabled={isGeneratingTitle || isGeneratingDescription}
            >
              {isGeneratingDescription ? (
                <>
                  <Loader2Icon className="h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <SparklesIcon className="h-4 w-4" />
                  Generate
                </>
              )}
            </Button>
          </div>
          <Textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Enter video description..."
            className="min-h-[300px] resize-y"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleConvertToShortLinks}
            disabled={isConvertingShortLinks || !description.trim()}
          >
            {isConvertingShortLinks ? (
              <>
                <Loader2Icon className="h-4 w-4 animate-spin" />
                Converting...
              </>
            ) : (
              <>
                <LinkIcon className="h-4 w-4" />
                Convert to short links
              </>
            )}
          </Button>
        </div>

        {/* Thumbnail selection */}
        <ThumbnailSelector
          videoId={videoId}
          thumbnails={thumbnails}
          selectedThumbnailId={selectedThumbnailId}
          onSelectThumbnail={setSelectedThumbnailId}
          onDeleteThumbnail={handleDeleteThumbnail}
        />
      </div>

      <PostPageOverwriteDialog
        field={confirmOverwriteField}
        currentText={currentFieldText}
        pendingText={pendingGeneratedText}
        onConfirm={handleConfirmOverwrite}
        onCancel={handleCancelOverwrite}
      />
    </>
  );
}
