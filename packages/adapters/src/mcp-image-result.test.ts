import { describe, expect, it } from "vitest";
import { mcpImageResult } from "./mcp-image-result.js";

const image = { type: "image", data: "QUJD", mimeType: "image/jpeg" };
const text = { type: "text", text: '{"shot":"a1"}' };

describe("mcpImageResult", () => {
  it("hands on an image beside its text, wrapped or not", () => {
    for (const answer of [
      { content: [text, image] },
      { result: { content: [text, image] } },
      { data: { content: [text, image] } },
    ]) {
      expect(mcpImageResult(answer)?.content).toEqual([
        { type: "text", text: '{"shot":"a1"}' },
        { type: "image", data: "QUJD", mimeType: "image/jpeg" },
      ]);
    }
  });

  it("leaves an answer with no image to the usual path", () => {
    expect(mcpImageResult({ content: [text] })).toBeNull();
    expect(mcpImageResult({ rows: [] })).toBeNull();
    expect(mcpImageResult("text")).toBeNull();
  });

  it("refuses a type it cannot show and caps how many reach the model", () => {
    expect(mcpImageResult({ content: [{ ...image, mimeType: "text/html" }] })).toBeNull();
    const many = mcpImageResult({ content: [image, image, image, image] });
    expect(many?.content.filter((part) => part.type === "image")).toHaveLength(2);
    expect(many?.details).toEqual({ images: 4 });
  });
});
