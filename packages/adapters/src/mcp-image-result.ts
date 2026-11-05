// AgentLoom: a connector tool that answers with an image (a phone's screenshot) reached the model
// as JSON text clipped at 12,000 characters, so it saw a scrap of base64. This hands the image on
// the way the computer tools do, as an image part beside the text.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGES = 2;

type Part = { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };

function contentOf(value: unknown, depth = 0): Part[] | null {
  if (!value || typeof value !== "object" || depth > 2) return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.content)) return record.content as Part[];
  return contentOf(record.result, depth + 1) ?? contentOf(record.data, depth + 1);
}

/** The agent tool result for a connector answer holding an image, or null to serialize as usual. */
export function mcpImageResult(result: unknown) {
  const parts = contentOf(result);
  if (!parts) return null;
  const images = parts.filter(
    (part) =>
      part?.type === "image" &&
      typeof part.data === "string" &&
      part.data.length > 0 &&
      typeof part.mimeType === "string" &&
      IMAGE_TYPES.has(part.mimeType),
  );
  if (images.length === 0) return null;
  const text = parts.flatMap((part) =>
    part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
  );
  return {
    kind: "agent_tool_result" as const,
    content: [
      { type: "text" as const, text: text.join("\n") || "Image returned." },
      ...images.slice(0, MAX_IMAGES).map((part) => ({
        type: "image" as const,
        data: part.data as string,
        mimeType: part.mimeType as string,
      })),
    ],
    details: { images: images.length },
  };
}
