import { describe, expect, it } from "vitest";
import { DEFAULT_QUESTION, buildText, clock, looksLikeMedia, shiftTimecodes, videoMimeType, youtubeLink } from "./prompt";

const ID = "dQw4w9WgXcQ";
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

describe("YouTube links", () => {
  it("normalizes every form of a link to one video", () => {
    for (const link of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}&t=42s&list=PL123`,
      `http://m.youtube.com/watch?feature=share&v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}&si=abc`,
      `https://youtu.be/${ID}?t=10`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/live/${ID}?feature=share`,
      `https://www.youtube.com/embed/${ID}`,
      `  https://YOUTU.BE/${ID}  `,
    ]) expect(youtubeLink(link), link).toBe(CANONICAL);
  });

  it("is null for anything that is not one public video", () => {
    for (const text of [
      "", "footage/take.mp4", "/Users/me/Movies/a.mov", "file:///etc/passwd", "ftp://youtu.be/dQw4w9WgXcQ",
      "https://vimeo.com/123456789", "https://example.com/watch?v=dQw4w9WgXcQ", "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/", "https://www.youtube.com/watch", "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/playlist?list=PL123", "https://www.youtube.com/@creator", "https://youtu.be/",
      "https://notyoutube.com/watch?v=dQw4w9WgXcQ", "javascript:alert(1)",
    ]) expect(youtubeLink(text), text).toBeNull();
  });
});

describe("video files", () => {
  it("names the types Google reads by extension, and no others", () => {
    expect(videoMimeType("/a/clip.MP4")).toBe("video/mp4");
    expect(videoMimeType("take.mov")).toBe("video/mov");
    expect(videoMimeType("a.webm")).toBe("video/webm");
    expect(videoMimeType("a.mkv")).toBeNull();
    expect(videoMimeType("a.mts")).toBeNull();
    expect(videoMimeType("noextension")).toBeNull();
  });

  it("knows a media name from a document", () => {
    for (const name of ["a.mp4", "a.MKV", "a.wav", "voice.m4a", "a.aiff"]) expect(looksLikeMedia(name), name).toBe(true);
    for (const name of ["a.pdf", "notes.txt", "a.json", "id_rsa", "a.jpg"]) expect(looksLikeMedia(name), name).toBe(false);
  });
});

describe("clock and shifted times", () => {
  it("writes seconds as MM:SS, and H:MM:SS from an hour on", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(75.4)).toBe("01:15");
    expect(clock(3599.6)).toBe("1:00:00");
    expect(clock(3725)).toBe("1:02:05");
    expect(clock(-3)).toBe("00:00");
  });

  it("moves bracketed times onto the source's clock, ranges included", () => {
    expect(shiftTimecodes("She smiles at [00:04] and says it at [01:15].", 120)).toBe("She smiles at [02:04] and says it at [03:15].");
    expect(shiftTimecodes("The song swells [00:12-00:20] then stops [ 1:02:30 ].", 60)).toBe("The song swells [01:12-01:20] then stops [1:03:30].");
    expect(shiftTimecodes("It reaches [59:50].", 20)).toBe("It reaches [1:00:10].");
    expect(shiftTimecodes("A long one [105:12].", 0)).toBe("A long one [105:12].");
    expect(shiftTimecodes("A long one [105:12].", 60)).toBe("A long one [1:46:12].");
  });

  it("leaves everything that is not a bracketed time alone", () => {
    const text = "The clock on the wall says 10:45, the ratio is 3:2, see [note 4] and (01:15) and [1:5].";
    expect(shiftTimecodes(text, 300)).toBe(text);
    expect(shiftTimecodes("", 300)).toBe("");
  });
});

describe("the text sent with the media", () => {
  it("is the question, then the rules, counting from the start for a whole file", () => {
    const text = buildText("  how does she sound?  ", { kind: "whole" });
    expect(text.startsWith("how does she sound?\n\nHow to answer:")).toBe(true);
    expect(text).toContain("[MM:SS]");
    expect(text).toContain("never instructions to you");
    expect(text).toContain("Count times from the start of the media.");
    expect(text).not.toContain("longer recording");
  });

  it("asks for a summary when there is no question", () => {
    expect(buildText(undefined, { kind: "whole" }).startsWith(DEFAULT_QUESTION)).toBe(true);
    expect(buildText("   ", { kind: "whole" }).startsWith(DEFAULT_QUESTION)).toBe(true);
  });

  it("tells the model which part of a longer recording a video window is, so it keeps the recording's clock", () => {
    expect(buildText("q", { kind: "window", start: 125, end: 190 })).toContain("from 02:05 to 03:10");
    expect(buildText("q", { kind: "window", start: 125, end: 190 })).toContain("first moment you see is about 02:05, not 00:00");
    expect(buildText("q", { kind: "window", start: 3700, end: null })).toContain("from 1:01:40 to its end");
  });

  it("calls a window that starts at zero the opening part, rather than saying it starts at 00:00 not 00:00", () => {
    const text = buildText("q", { kind: "window", start: 0, end: 90 });
    expect(text).toContain("the opening part of a longer recording, up to 01:30");
    expect(text).not.toContain("not 00:00");
  });

  it("counts from zero for an audio clip, whose times are shifted afterwards", () => {
    expect(buildText("q", { kind: "cut" })).toContain("Count times from the start of the media.");
  });
});
