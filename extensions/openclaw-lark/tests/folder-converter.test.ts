import { describe, expect, it } from "vitest";
import { convertFolder } from "../src/messaging/converters/folder";

describe("convertFolder", () => {
  it("keeps folder placeholders without exposing downloadable file resources", async () => {
    const result = await convertFolder(
      JSON.stringify({
        file_key: "file_v3_01100_b5a280c5-d69a-4b5b-bfd7-1c0d116824bg",
        file_name: "hr-analysis",
      }),
      {} as never,
    );

    expect(result.content).toBe(
      '<folder key="file_v3_01100_b5a280c5-d69a-4b5b-bfd7-1c0d116824bg" name="hr-analysis"/>',
    );
    expect(result.resources).toEqual([]);
  });
});
