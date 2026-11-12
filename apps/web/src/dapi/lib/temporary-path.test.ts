import { describe, expect, it } from "vitest";

import { isDraftPath, isTemporaryPath } from "./temporary-path";

describe("isTemporaryPath", () => {
  it("knows the folders an agent keeps drafts in", () => {
    expect(isTemporaryPath("/tmp/promo-review-v1.mp4")).toBe(true);
    expect(isTemporaryPath("/private/tmp/agent/promo-review-music-v2.mp4")).toBe(true);
    expect(isTemporaryPath("/var/folders/8x/abc123/T/draft.mp4")).toBe(true);
    expect(isTemporaryPath("/private/var/folders/8x/abc123/T/draft.mp4")).toBe(true);
    expect(isTemporaryPath("C:\\Users\\me\\AppData\\Local\\Temp\\draft.mp4")).toBe(true);
    expect(isTemporaryPath("D:/Users/me/appdata/local/temp/draft.mp4")).toBe(true);
    expect(isTemporaryPath("C:\\Windows\\Temp\\draft.mp4")).toBe(true);
  });

  it("leaves a delivery, and anything else a person might look for, as it is", () => {
    expect(isTemporaryPath("/Users/me/Movies/Cutroom/Promo/exports/intro.mp4")).toBe(false);
    expect(isTemporaryPath("/Users/me/Desktop/final.mp4")).toBe(false);
    expect(isTemporaryPath("/Volumes/Media/tmp/final.mp4")).toBe(false);
    expect(isTemporaryPath("C:\\Users\\me\\Videos\\final.mp4")).toBe(false);
  });

  it("does not take a longer name for a temp folder", () => {
    expect(isTemporaryPath("/tmpfiles/draft.mp4")).toBe(false);
    expect(isTemporaryPath("/var/foldersX/draft.mp4")).toBe(false);
    expect(isTemporaryPath("/tmp")).toBe(false);
  });

  it("does not trust a path that climbs out of the folder it starts in", () => {
    expect(isTemporaryPath("/tmp/../Users/me/Desktop/final.mp4")).toBe(false);
    expect(isTemporaryPath("C:\\Users\\me\\AppData\\Local\\Temp\\..\\..\\Videos\\final.mp4")).toBe(false);
  });
});

describe("isDraftPath", () => {
  it("is a temporary file outside the project: what an agent renders to check its work", () => {
    expect(isDraftPath("/private/tmp/agent/promo-review-music-v3.mp4", "/Users/me/Movies/Cutroom/Promo")).toBe(true);
    expect(isDraftPath("/tmp/promo-review-v1.mp4", "/Users/me/Movies/Cutroom/Promo")).toBe(true);
  });

  it("is never what an export writes into the project itself, even when the project lives in a temp folder", () => {
    expect(isDraftPath("/private/tmp/proj/exports/intro.mp4", "/private/tmp/proj")).toBe(false);
    expect(isDraftPath("/private/tmp/proj/exports/intro.mp4", "/private/tmp/proj/")).toBe(false);
    expect(isDraftPath("C:\\Users\\me\\AppData\\Local\\Temp\\proj\\exports\\intro.mp4", "C:\\Users\\me\\AppData\\Local\\Temp\\proj")).toBe(false);
  });

  it("still calls a temp file next to such a project a draft, and a sibling folder is not the project", () => {
    expect(isDraftPath("/private/tmp/draft.mp4", "/private/tmp/proj")).toBe(true);
    expect(isDraftPath("/private/tmp/proj-review/draft.mp4", "/private/tmp/proj")).toBe(true);
  });

  it("is not a draft outside a temp folder, project or not", () => {
    expect(isDraftPath("/Users/me/Movies/Cutroom/Promo/exports/intro.mp4", "/Users/me/Movies/Cutroom/Promo")).toBe(false);
    expect(isDraftPath("/Users/me/Desktop/final.mp4", "/Users/me/Movies/Cutroom/Promo")).toBe(false);
  });
});
