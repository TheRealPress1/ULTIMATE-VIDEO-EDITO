import { describe, expect, it } from "vitest";

import type { MediaEntry, MediaPlace } from "@desktop/main-channels";

import {
  columnPaths,
  detailRows,
  dragPaths,
  droppedMediaPaths,
  filterEntries,
  formatDuration,
  formatSize,
  MEDIA_PATHS_DRAG_TYPE,
  mediaKind,
  mergePlaces,
  pathSegments,
  permissionNoteFor,
  select,
  sortEntries,
  visibleGridRange,
  visibleRange,
} from "./media-browser-data";

const file = (name: string, extra: Partial<MediaEntry> = {}): MediaEntry => ({ name, path: `/shoot/${name}`, kind: "file", size: 100, mtime: 1, ...extra });
const folder = (name: string): MediaEntry => ({ name, path: `/shoot/${name}`, kind: "directory", size: 0, mtime: 1 });

const places: MediaPlace[] = [
  { label: "Movies", path: "/Users/editor/Movies", group: "favorites" },
  { label: "Desktop", path: "/Users/editor/Desktop", group: "favorites" },
  { label: "Shoot Drive", path: "/Volumes/Shoot Drive", group: "volumes" },
];

describe("media browser data", () => {
  it("knows video, audio and image by extension, in any case", () => {
    expect(mediaKind("A001_C002.MOV")).toBe("video");
    expect(mediaKind("boom.wav")).toBe("audio");
    expect(mediaKind("still.HEIC")).toBe("image");
    expect(mediaKind("notes.txt")).toBeNull();
    expect(mediaKind(".mov")).toBeNull();
    expect(mediaKind("README")).toBeNull();
  });

  it("shows folders and media, narrowed to the kinds asked for", () => {
    const entries = [folder("Day 1"), file("a.mov"), file("b.wav"), file("c.jpg"), file("notes.txt")];
    expect(filterEntries(entries, new Set()).map((entry) => entry.name)).toEqual(["Day 1", "a.mov", "b.wav", "c.jpg"]);
    expect(filterEntries(entries, new Set(["audio"])).map((entry) => entry.name)).toEqual(["Day 1", "b.wav"]);
  });

  it("sorts folders first, then files by the key, with names in natural order", () => {
    const entries = [file("clip 10.mov", { size: 5 }), folder("B roll"), file("clip 2.mov", { size: 50 }), folder("A roll"), file("clip 1.mov", { size: 5 })];
    expect(sortEntries(entries, { key: "name", descending: false }).map((entry) => entry.name))
      .toEqual(["A roll", "B roll", "clip 1.mov", "clip 2.mov", "clip 10.mov"]);
    expect(sortEntries(entries, { key: "size", descending: true }).map((entry) => entry.name))
      .toEqual(["A roll", "B roll", "clip 2.mov", "clip 1.mov", "clip 10.mov"]);
    expect(sortEntries([file("b.jpg"), file("a.wav"), file("c.mov")], { key: "kind", descending: false }).map((entry) => entry.name))
      .toEqual(["c.mov", "a.wav", "b.jpg"]);
    expect(sortEntries([file("old.mov", { mtime: 1 }), file("new.mov", { mtime: 9 })], { key: "date", descending: true }).map((entry) => entry.name))
      .toEqual(["new.mov", "old.mov"]);
  });

  it("puts clips of unknown duration last, whichever way duration sorts", () => {
    const entries = [file("unknown.mov"), file("long.mov"), file("short.mov")];
    const durations = new Map([["/shoot/long.mov", 90], ["/shoot/short.mov", 3]]);
    expect(sortEntries(entries, { key: "duration", descending: false }, durations).map((entry) => entry.name)).toEqual(["short.mov", "long.mov", "unknown.mov"]);
    expect(sortEntries(entries, { key: "duration", descending: true }, durations).map((entry) => entry.name)).toEqual(["long.mov", "short.mov", "unknown.mov"]);
  });

  it("adds the user's folders after the system's, once each", () => {
    const merged = mergePlaces(places, ["/Volumes/Shoot Drive", "/Users/editor/Work/Client", "/Users/editor/Work/Client"]);
    expect(merged.map((place) => [place.label, place.group])).toEqual([
      ["Movies", "favorites"], ["Desktop", "favorites"], ["Shoot Drive", "volumes"], ["Client", "added"],
    ]);
  });

  it("builds the path bar from the deepest place that holds the folder", () => {
    const merged = mergePlaces(places, ["/Volumes/Shoot Drive/Day 1"]);
    expect(pathSegments("/Volumes/Shoot Drive/Day 1/A001", merged)).toEqual([
      { label: "Day 1", path: "/Volumes/Shoot Drive/Day 1" },
      { label: "A001", path: "/Volumes/Shoot Drive/Day 1/A001" },
    ]);
    expect(pathSegments("/Volumes/Shoot Drive/Day 2", merged).map((segment) => segment.label)).toEqual(["Shoot Drive", "Day 2"]);
    // A sibling whose name starts the same is not inside the place.
    expect(pathSegments("/Volumes/Shoot Drive 2/x", merged).map((segment) => segment.label)).toEqual(["/", "Volumes", "Shoot Drive 2", "x"]);
    expect(columnPaths("/Users/editor/Movies/Reels", merged)).toEqual(["/Users/editor/Movies", "/Users/editor/Movies/Reels"]);
  });

  it("explains permission once per place, before macOS asks", () => {
    expect(permissionNoteFor("/Users/editor/Desktop/cards", places, [])).toBe("/Users/editor/Desktop");
    expect(permissionNoteFor("/Volumes/Shoot Drive/Day 1", places, [])).toBe("/Volumes/Shoot Drive");
    expect(permissionNoteFor("/Volumes/Shoot Drive/Day 1", places, ["/Volumes/Shoot Drive"])).toBeNull();
    expect(permissionNoteFor("/Users/editor/Movies/x", places, [])).toBeNull();
    expect(permissionNoteFor("/Users/editor/Library/Mobile Documents/com~apple~CloudDocs", places, [])).not.toBeNull();
  });

  it("draws only the rows on screen", () => {
    expect(visibleRange(0, 100, 20, 10_000, 2)).toEqual({ start: 0, end: 7 });
    expect(visibleRange(2000, 100, 20, 10_000, 2)).toEqual({ start: 98, end: 107 });
    expect(visibleRange(10_000_000, 100, 20, 50, 2)).toEqual({ start: 50, end: 50 });
    expect(visibleRange(0, 100, 20, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleGridRange(0, 200, 100, 3, 1000, 1)).toEqual({ start: 0, end: 9 });
    expect(visibleGridRange(1000, 200, 100, 3, 40, 0)).toEqual({ start: 30, end: 36 });
  });

  it("selects like Finder", () => {
    const keys = ["a", "b", "c", "d"];
    let selection = select(keys, { selected: [], anchor: null }, "b");
    expect(selection).toEqual({ selected: ["b"], anchor: "b" });
    selection = select(keys, selection, "d", { extend: true });
    expect(selection.selected).toEqual(["b", "c", "d"]);
    selection = select(keys, selection, "c", { toggle: true });
    expect(selection.selected).toEqual(["b", "d"]);
    expect(select(keys, selection, "a").selected).toEqual(["a"]);
  });

  it("drags the selection, or the item alone, and never a cloud-only file", () => {
    const entries = [file("a.mov"), file("b.mov"), file("cloud.mov", { cloud: true }), folder("Day 1")];
    expect(dragPaths(entries, ["/shoot/a.mov", "/shoot/cloud.mov", "/shoot/Day 1"], "/shoot/a.mov")).toEqual(["/shoot/a.mov", "/shoot/Day 1"]);
    expect(dragPaths(entries, ["/shoot/a.mov"], "/shoot/b.mov")).toEqual(["/shoot/b.mov"]);
    expect(dragPaths(entries, [], "/shoot/cloud.mov")).toEqual([]);
  });

  it("reads only absolute paths from a browser drag", () => {
    const transfer = { getData: (type: string) => (type === MEDIA_PATHS_DRAG_TYPE ? "/a/b.mov\nrelative.mov\n\n/c/d" : "") };
    expect(droppedMediaPaths(transfer)).toEqual(["/a/b.mov", "/c/d"]);
    expect(droppedMediaPaths({ getData: () => "" })).toEqual([]);
    expect(droppedMediaPaths(null)).toEqual([]);
  });

  it("formats durations, sizes and the details rows", () => {
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatSize(999)).toBe("999 bytes");
    expect(formatSize(1_500_000)).toBe("1.5 MB");
    expect(formatSize(250_000_000_000)).toBe("250 GB");
    expect(detailRows({ duration: 62, width: 3840, height: 2160, frameRate: 23.976, videoCodec: "prores", audioCodec: "pcm_s24le", sampleRate: 48000, channels: 2 })).toEqual([
      ["Duration", "1:02"],
      ["Resolution", "3840 × 2160"],
      ["Frame rate", "23.976 fps"],
      ["Video", "ProRes"],
      ["Audio", "PCM 24-bit · 48 kHz, 2 ch"],
    ]);
    expect(detailRows({})).toEqual([]);
  });
});
