/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { toolByName } from "@diffusionstudio/dapi";
import {
  attributionLine, catalogLicense, fileKey, interleave, isWikimediaRendition, licenseAllowed, openverseLicense, openverseUrl, parseOpenverse, parseWikimedia, plainText,
  UNKNOWN_LICENSE, urlKey, WIKIMEDIA_WIDTHS, wikimediaLicense, wikimediaRendition, wikimediaUrl, wikimediaWidth,
} from "./web-media-providers";
import { OPENVERSE_AUDIO, OPENVERSE_IMAGES, WIKIMEDIA_EMPTY, WIKIMEDIA_IMAGES, WIKIMEDIA_VIDEO_V1 } from "./web-media-fixtures";

import type { ToolInput } from "@diffusionstudio/dapi";

const args = (input: Partial<ToolInput<"web_media_search">> = {}) => toolByName("web_media_search").input.parse({ query: "apollo launch", ...input });
const output = toolByName("web_media_search").output;

describe("license normalization", () => {
  it("maps every Openverse code to its terms", () => {
    const terms = (code: string) => {
      const license = openverseLicense(code, code === "pdm" || code === "cc0" ? "1.0" : "4.0", undefined)!;
      return [license.attributionRequired, license.shareAlike, license.commercialUse, license.modificationsAllowed];
    };
    expect(terms("cc0")).toEqual([false, false, true, true]);
    expect(terms("pdm")).toEqual([false, false, true, true]);
    expect(terms("by")).toEqual([true, false, true, true]);
    expect(terms("by-sa")).toEqual([true, true, true, true]);
    expect(terms("by-nd")).toEqual([true, false, true, false]);
    expect(terms("by-nc")).toEqual([true, false, false, true]);
    expect(terms("by-nc-sa")).toEqual([true, true, false, true]);
    expect(terms("by-nc-nd")).toEqual([true, false, false, false]);
    expect(terms("sampling+")).toEqual([true, false, false, true]);
    expect(terms("nc-sampling+")).toEqual([true, false, false, true]);
    expect(openverseLicense("BY-SA", "2.0", "https://creativecommons.org/licenses/by-sa/2.0/")).toEqual({
      code: "by-sa", name: "CC BY-SA 2.0", version: "2.0", url: "https://creativecommons.org/licenses/by-sa/2.0/",
      attributionRequired: true, shareAlike: true, commercialUse: true, modificationsAllowed: true, verified: true,
    });
    expect(openverseLicense("by", "4.0", null)!.url).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(openverseLicense("cc0", "", null)).toMatchObject({ name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" });
    expect(openverseLicense("all-rights-reserved", "", null)).toBeNull();
    expect(openverseLicense(undefined, "", null)).toBeNull();
  });

  it("reads Commons' machine-readable license first, then its short name, and refuses non-free files", () => {
    const meta = (fields: Record<string, string>) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }]));
    expect(wikimediaLicense(meta({ License: "cc-by-sa-3.0-de", LicenseShortName: "CC BY-SA 3.0 de" }))).toMatchObject({ code: "by-sa", version: "3.0", name: "CC BY-SA 3.0" });
    expect(wikimediaLicense(meta({ LicenseShortName: "CC BY 2.5" }))).toMatchObject({ code: "by", version: "2.5", url: "https://creativecommons.org/licenses/by/2.5/" });
    expect(wikimediaLicense(meta({ License: "cc0", LicenseShortName: "CC0" }))).toMatchObject({ code: "cc0", attributionRequired: false });
    expect(wikimediaLicense(meta({ License: "pd", LicenseShortName: "Public domain" }))).toMatchObject({ code: "public-domain", attributionRequired: false, modificationsAllowed: true });
    expect(wikimediaLicense(meta({ License: "gfdl", LicenseShortName: "GFDL 1.2" }))).toMatchObject({ code: "gfdl", shareAlike: true });
    expect(wikimediaLicense(meta({ LicenseShortName: "Free Art License" }))).toMatchObject({ code: "fal", shareAlike: true });
    expect(wikimediaLicense(meta({ License: "ogl3", LicenseShortName: "OGL 3" }))).toMatchObject({ code: "ogl", attributionRequired: true });
    expect(wikimediaLicense(meta({ License: "attribution", LicenseShortName: "Attribution" }))).toMatchObject({ code: "attribution" });
    expect(wikimediaLicense(meta({ License: "cc-by-sa-4.0", NonFree: "true" }))).toBeNull();
    expect(wikimediaLicense(meta({ LicenseShortName: "Copyrighted free use" }))).toBeNull();
    expect(wikimediaLicense(undefined)).toBeNull();
  });

  it("filters by what the edit needs", () => {
    const by = openverseLicense("by", "4.0", null)!;
    const nd = openverseLicense("by-nd", "4.0", null)!;
    const nc = openverseLicense("by-nc", "4.0", null)!;
    expect([by, nd, nc].map((terms) => licenseAllowed(terms, "editable"))).toEqual([true, false, true]);
    expect([by, nd, nc].map((terms) => licenseAllowed(terms, "commercial"))).toEqual([true, false, false]);
    expect([by, nd, nc].map((terms) => licenseAllowed(terms, "any"))).toEqual([true, true, true]);
    expect(licenseAllowed(UNKNOWN_LICENSE, "editable")).toBe(false);
  });

  it("writes credits in the title, author, source, license form", () => {
    expect(attributionLine({ title: "Launch", creator: "NASA", pageUrl: "https://e.test/p", license: openverseLicense("by", "2.0", null)! }))
      .toBe("\"Launch\" by NASA (https://e.test/p), licensed under CC BY 2.0 (https://creativecommons.org/licenses/by/2.0/).");
    expect(attributionLine({ title: "Launch", pageUrl: "https://e.test/p", license: openverseLicense("cc0", "1.0", null)! }))
      .toBe("\"Launch\" (https://e.test/p), dedicated to the public domain under CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/).");
    expect(attributionLine({ title: "Pad", fileUrl: "https://e.test/a.jpg", license: UNKNOWN_LICENSE }))
      .toBe("\"Pad\" (https://e.test/a.jpg), license not verified: confirm the rights before publishing.");
  });
});

describe("the audio catalog's rights", () => {
  it("names the terms of open rights, with the version a credit line gives, and nothing for the rest", () => {
    expect(catalogLicense("cc0")).toMatchObject({ code: "cc0", name: "CC0 1.0", verified: true, attributionRequired: false });
    expect(catalogLicense("public-domain")).toMatchObject({ code: "public-domain", verified: true, attributionRequired: false });
    expect(catalogLicense("cc-by", "Song by Someone, licensed under CC BY 4.0.")).toMatchObject({ code: "by", name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/", attributionRequired: true });
    expect(catalogLicense("cc-by-sa", "Chill Day by an artist, licensed CC BY-SA.")).toMatchObject({ code: "by-sa", name: "CC BY-SA", shareAlike: true, verified: true });
    for (const rights of ["copyrighted", "royalty-free", "unknown", "cc-by-nc"]) expect(catalogLicense(rights, "CC BY 4.0"), rights).toBeNull();
  });
});

describe("Openverse", () => {
  it("builds the documented query: page size, maturity, license type and aspect ratio", () => {
    const url = new URL(openverseUrl(args({ orientation: "portrait", license: "commercial", limit: 30 }))!);
    expect(url.origin + url.pathname).toBe("https://api.openverse.org/v1/images/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "apollo launch", page_size: "20", mature: "false", license_type: "commercial,modification", aspect_ratio: "tall" });
    expect(new URL(openverseUrl(args({ kind: "audio", orientation: "landscape" }))!).pathname).toBe("/v1/audio/");
    expect(new URL(openverseUrl(args({ kind: "audio", orientation: "landscape" }))!).searchParams.has("aspect_ratio")).toBe(false);
    expect(new URL(openverseUrl(args({ license: "any" }))!).searchParams.has("license_type")).toBe(false);
    expect(new URL(openverseUrl(args())!).searchParams.get("license_type")).toBe("modification");
    expect(openverseUrl(args({ kind: "video" }))).toBeNull();
  });

  it("reads image results with their terms, dropping unusable rows and those the filter excludes", () => {
    const results = parseOpenverse(OPENVERSE_IMAGES, args());
    expect(results.map((result) => result.title)).toEqual(["Apollo 11 Launch", "Saturn V on the pad at dusk", "Crawler-transporter", "Untitled"]);
    const [apollo, saturn, crawler, untitled] = results;
    expect(apollo).toEqual({
      id: "openverse:f9384235-b72e-4f1e-9b05-e1b116262a29",
      kind: "image",
      title: "Apollo 11 Launch",
      provider: "openverse",
      source: "flickr",
      url: "https://live.staticflickr.com/7414/9460707453_8c5a1d8e32_b.jpg",
      thumbnailUrl: "https://api.openverse.org/v1/images/f9384235-b72e-4f1e-9b05-e1b116262a29/thumb/",
      pageUrl: "https://www.flickr.com/photos/nasacommons/9460707453",
      width: 819,
      height: 1024,
      mimeType: "image/jpeg",
      creator: "NASA on The Commons",
      license: { code: "pdm", name: "Public Domain Mark 1.0", version: "1.0", url: "https://creativecommons.org/publicdomain/mark/1.0/", attributionRequired: false, shareAlike: false, commercialUse: true, modificationsAllowed: true, verified: true },
      attribution: "\"Apollo 11 Launch\" by NASA on The Commons (https://www.flickr.com/photos/nasacommons/9460707453), in the public domain (Public Domain Mark 1.0).",
    });
    expect(saturn).toMatchObject({ creator: "Kim & Lee", source: "wikimedia", license: { code: "by-sa", shareAlike: true } });
    expect(crawler).toMatchObject({ mimeType: "image/png", license: { code: "by-nc", commercialUse: false } });
    expect(untitled).toMatchObject({ title: "Untitled", license: { code: "cc0" } });
    expect(untitled).not.toHaveProperty("creator");
    expect(parseOpenverse(OPENVERSE_IMAGES, args({ license: "commercial" })).map((result) => result.license.code)).toEqual(["pdm", "by-sa", "cc0"]);
    expect(parseOpenverse(OPENVERSE_IMAGES, args({ license: "any" })).map((result) => result.license.code)).toEqual(["pdm", "by-sa", "by-nd", "by-nc", "cc0"]);
    for (const result of interleave([results], 30)) expect(() => output.parse({ results: [result], warnings: [] })).not.toThrow();
  });

  it("reads audio durations from milliseconds and keeps thumbnails optional", () => {
    const [countdown, loop] = parseOpenverse(OPENVERSE_AUDIO, args({ kind: "audio" }));
    expect(countdown).toMatchObject({ kind: "audio", durationSeconds: 12.85, mimeType: "audio/mpeg", source: "freesound", license: { code: "by", name: "CC BY 4.0" } });
    expect(countdown).not.toHaveProperty("thumbnailUrl");
    expect(countdown).not.toHaveProperty("width");
    expect(loop).toMatchObject({ durationSeconds: 184, license: { code: "sampling+", commercialUse: false } });
    expect(parseOpenverse(OPENVERSE_AUDIO, args({ kind: "audio", license: "commercial" }))).toHaveLength(1);
  });

  it("fails loudly on a body that is not a search response", () => {
    expect(() => parseOpenverse({ detail: "Throttled" }, args())).toThrow(/unexpected response/);
  });
});

describe("Wikimedia Commons", () => {
  it("searches the File namespace with the kind's filetype and asks for the metadata it reads", () => {
    const url = new URL(wikimediaUrl(args({ kind: "video", limit: 30 })));
    expect(url.origin + url.pathname).toBe("https://commons.wikimedia.org/w/api.php");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      action: "query", format: "json", formatversion: "2", generator: "search", gsrnamespace: "6", gsrsearch: "apollo launch filetype:video",
      gsrlimit: "50", prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "500",
    });
    expect(new URL(wikimediaUrl(args({ limit: 3 }))).searchParams.get("gsrsearch")).toBe("apollo launch filetype:bitmap");
    expect(new URL(wikimediaUrl(args({ limit: 3 }))).searchParams.get("gsrlimit")).toBe("10");
  });

  it("rescales a Commons thumbnail URL, page and lossy prefixes and its query included", () => {
    expect(wikimediaRendition("https://upload.wikimedia.org/x/thumb/a/ab/B.jpg/500px-B.jpg", 3840)).toBe("https://upload.wikimedia.org/x/thumb/a/ab/B.jpg/3840px-B.jpg");
    expect(wikimediaRendition("https://u.test/thumb/7/7e/P.tif/lossy-page1-500px-P.tif.jpg", 1920)).toBe("https://u.test/thumb/7/7e/P.tif/lossy-page1-1920px-P.tif.jpg");
    expect(wikimediaRendition("https://thumb.wikimedia.org/wikipedia/commons/thumb/8/88/A.tif/lossless-page1-500px-A.tif.png?utm_source=commons.wikimedia.org&utm_content=thumbnail", 960))
      .toBe("https://thumb.wikimedia.org/wikipedia/commons/thumb/8/88/A.tif/lossless-page1-960px-A.tif.png?utm_source=commons.wikimedia.org&utm_content=thumbnail");
    expect(wikimediaRendition("https://u.test/a/ab/B.jpg", 120)).toBeNull();
  });

  it("asks only for the widths Commons renders, rounding down and never under 120", () => {
    // Live, thumb.wikimedia.org answers these with 200 and 640, 1237, 2262, 2415 or 2560 with 400.
    expect(WIKIMEDIA_WIDTHS).toEqual([120, 250, 330, 500, 960, 1280, 1920, 3840]);
    expect([4000, 3840, 3839, 2560, 2415, 2262, 1920, 1237, 960, 640, 500, 300, 120, 60].map(wikimediaWidth))
      .toEqual([3840, 3840, 1920, 1920, 1920, 1920, 1920, 960, 960, 500, 500, 250, 120, 120]);
    expect(isWikimediaRendition(new URL("https://thumb.wikimedia.org/wikipedia/commons/thumb/8/88/A.tif/lossless-page1-1237px-A.tif.png"))).toBe(true);
    expect(isWikimediaRendition(new URL("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/B.jpg/640px-B.jpg"))).toBe(true);
    expect(isWikimediaRendition(new URL("https://upload.wikimedia.org/wikipedia/commons/a/ab/B.jpg"))).toBe(false);
    expect(isWikimediaRendition(new URL("https://example.com/thumb/a/ab/B.jpg/640px-B.jpg"))).toBe(false);
  });

  it("downloads a TIFF narrower than 4K at the standard width below it, and keeps a standard thumbnail as the API gave it", () => {
    // As the live API answers for "apollo launchpad tif": originals and renditions carry `utm_*` parameters.
    const thumb = (width: number) => `https://thumb.wikimedia.org/wikipedia/commons/thumb/8/88/Apollo_16_on_the_launchpad.tif/lossless-page1-${width}px-Apollo_16_on_the_launchpad.tif.png?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail`;
    const page = (info: Record<string, unknown>) => ({ query: { pages: [{ pageid: 136409215, title: "File:Apollo 16 on the launchpad.tif", index: 1, imageinfo: [{
      width: 1237, height: 1234, mime: "image/tiff", thumburl: thumb(500), thumbwidth: 500, thumbheight: 499,
      url: "https://upload.wikimedia.org/wikipedia/commons/8/88/Apollo_16_on_the_launchpad.tif?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original",
      descriptionurl: "https://commons.wikimedia.org/wiki/File:Apollo_16_on_the_launchpad.tif",
      extmetadata: { License: { value: "pd" }, LicenseShortName: { value: "Public domain" } }, ...info,
    }] }] } });
    const [tiff] = parseWikimedia(page({}), args());
    expect(tiff).toMatchObject({ url: thumb(960), thumbnailUrl: thumb(500), width: 960, height: 958, mimeType: "image/png" });
    // A thumbnail at a width Commons doesn't render is asked for at the standard width below it.
    expect(parseWikimedia(page({ thumburl: thumb(640) }), args())[0]).toMatchObject({ url: thumb(960), thumbnailUrl: thumb(500) });
    // Narrower than the narrowest standard width: the narrowest.
    expect(parseWikimedia(page({ width: 100, height: 100 }), args())[0]).toMatchObject({ url: thumb(120), width: 100, height: 100 });
  });

  it("keeps the original as the thumbnail of an image narrower than the thumbnail, whatever its name", () => {
    // Narrower than the 500 px asked for, Commons answers with the original, here named like a rendition.
    const original = "https://upload.wikimedia.org/wikipedia/commons/a/ab/220px-Foo.jpg";
    const [narrow] = parseWikimedia({ query: { pages: [{ pageid: 7, title: "File:220px-Foo.jpg", index: 1, imageinfo: [{
      width: 220, height: 160, mime: "image/jpeg", url: original, thumburl: original, thumbwidth: 220, thumbheight: 160,
      descriptionurl: "https://commons.wikimedia.org/wiki/File:220px-Foo.jpg", extmetadata: { License: { value: "cc0" } },
    }] }] } }, args());
    expect(narrow).toMatchObject({ url: original, thumbnailUrl: original, width: 220, height: 160 });
    // An undecodable original without a rendition to point at is left out, not rewritten into a path that doesn't exist.
    const bmp = "https://upload.wikimedia.org/wikipedia/commons/a/ab/220px-Foo.bmp";
    expect(parseWikimedia({ query: { pages: [{ pageid: 8, title: "File:220px-Foo.bmp", index: 1, imageinfo: [{
      width: 220, height: 160, mime: "image/bmp", url: bmp, thumburl: bmp, extmetadata: { License: { value: "cc0" } },
    }] }] } }, args())).toEqual([]);
  });

  it("reads images in search order, as decodable renditions no wider than 4K, without non-free or unknown licenses", () => {
    const results = parseWikimedia(WIKIMEDIA_IMAGES, args());
    expect(results.map((result) => result.id)).toEqual(["wikimedia:99887766", "wikimedia:1532211", "wikimedia:33221100"]);
    const [panorama, apollo, falcon] = results;
    expect(panorama).toEqual({
      id: "wikimedia:99887766",
      kind: "image",
      title: "Kennedy Space Center panorama",
      provider: "wikimedia",
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7e/Kennedy_Space_Center_panorama.tif/lossy-page1-3840px-Kennedy_Space_Center_panorama.tif.jpg",
      thumbnailUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7e/Kennedy_Space_Center_panorama.tif/lossy-page1-500px-Kennedy_Space_Center_panorama.tif.jpg",
      pageUrl: "https://commons.wikimedia.org/wiki/File:Kennedy_Space_Center_panorama.tif",
      width: 3840,
      height: 1280,
      mimeType: "image/jpeg",
      creator: "Jane Doe & John Roe",
      license: { code: "by-sa", name: "CC BY-SA 4.0", version: "4.0", url: "https://creativecommons.org/licenses/by-sa/4.0", attributionRequired: true, shareAlike: true, commercialUse: true, modificationsAllowed: true, verified: true },
      attribution: "\"Kennedy Space Center panorama\" by Jane Doe & John Roe (https://commons.wikimedia.org/wiki/File:Kennedy_Space_Center_panorama.tif), licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0).",
    });
    // A web format within 4K is the original file.
    expect(apollo).toMatchObject({ url: "https://upload.wikimedia.org/wikipedia/commons/2/25/Apollo_11_Launch_-_GPN-2000-000630.jpg", width: 2400, height: 3000, creator: "NASA", license: { code: "public-domain" } });
    expect(falcon).toMatchObject({ url: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Falcon_9_liftoff.jpg/3840px-Falcon_9_liftoff.jpg", width: 3840, height: 2560, title: "Falcon 9 liftoff" });
    for (const result of interleave([results], 30)) expect(() => output.parse({ results: [result], warnings: [] })).not.toThrow();
  });

  it("filters orientation by the original's shape", () => {
    expect(parseWikimedia(WIKIMEDIA_IMAGES, args({ orientation: "portrait" })).map((result) => result.id)).toEqual(["wikimedia:1532211"]);
    expect(parseWikimedia(WIKIMEDIA_IMAGES, args({ orientation: "landscape" })).map((result) => result.id)).toEqual(["wikimedia:99887766", "wikimedia:33221100"]);
    expect(parseWikimedia(WIKIMEDIA_IMAGES, args({ orientation: "square" }))).toEqual([]);
  });

  it("reads format version 1 and keeps only video the editor decodes", () => {
    const results = parseWikimedia(WIKIMEDIA_VIDEO_V1, args({ kind: "video" }));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "video", mimeType: "video/webm", durationSeconds: 43.52, width: 1920, height: 1080,
      url: "https://upload.wikimedia.org/wikipedia/commons/4/4d/Apollo_11_liftoff_%281969%29.webm",
      thumbnailUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Apollo_11_liftoff_%281969%29.webm/500px--Apollo_11_liftoff_%281969%29.webm.jpg",
    });
  });

  it("answers no matches with no results, and an API error with its reason", () => {
    expect(parseWikimedia(WIKIMEDIA_EMPTY, args())).toEqual([]);
    expect(() => parseWikimedia({ error: { code: "badvalue", info: "Unrecognized value for parameter \"gsrnamespace\"." } }, args())).toThrow(/Unrecognized value/);
  });
});

describe("combining providers", () => {
  it("alternates providers, numbers from 1, drops repeated files and stops at the limit", () => {
    const a = parseOpenverse(OPENVERSE_IMAGES, args());
    const b = parseWikimedia(WIKIMEDIA_IMAGES, args());
    const repeat = { ...b[0]!, id: "openverse:dupe" };
    const results = interleave([[a[0]!, repeat, a[1]!], b], 4);
    expect(results.map((result) => [result.index, result.id])).toEqual([
      [1, a[0]!.id], [2, b[0]!.id], [3, b[1]!.id], [4, a[1]!.id],
    ]);
  });

  it("knows a Commons file in Openverse's results however Commons spells its URL", () => {
    const commons = parseWikimedia(WIKIMEDIA_IMAGES, args());
    const apollo = commons.find((result) => result.id === "wikimedia:1532211")!;
    const panorama = commons.find((result) => result.id === "wikimedia:99887766")!;
    const openverse = parseOpenverse(OPENVERSE_IMAGES, args());
    // Commons' API now tags its URLs; Openverse's copy of the same file has no query, and may spell it differently.
    const tagged = { ...apollo, url: `${apollo.url}?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original` };
    const copies = [
      { ...openverse[0]!, id: "openverse:apollo", url: apollo.url },
      { ...openverse[1]!, id: "openverse:panorama", url: "https://upload.wikimedia.org/wikipedia/commons/7/7e/Kennedy_Space_Center_panorama.tif" },
      { ...openverse[2]!, id: "openverse:encoded", url: "https://upload.wikimedia.org/wikipedia/commons/2/25/Apollo_11_Launch_%2D_GPN-2000-000630.jpg" },
      openverse[3]!,
    ];
    const results = interleave([[tagged, panorama], copies], 30);
    expect(results.map((result) => result.id)).toEqual([tagged.id, panorama.id, openverse[3]!.id]);
    // Not Commons: a query is part of what the file is, but tracking isn't.
    expect(fileKey("https://cdn.example/a.jpg?w=1200&utm_medium=social#top")).toBe("https://cdn.example/a.jpg?w=1200");
    expect(fileKey("https://cdn.example/a.jpg?w=600")).not.toBe(fileKey("https://cdn.example/a.jpg?w=1200"));
    expect(urlKey("https://cdn.example/a.jpg?utm_source=x&UTM_campaign=y")).toBe("https://cdn.example/a.jpg");
    expect(urlKey("not a url")).toBeNull();
  });

  it("keeps Commons' decodable rendition of a file Openverse lists as its original, wherever either comes", () => {
    // As the live APIs answer for "apollo 16 launchpad": Openverse links the TIFF original, Commons a PNG rendition of it.
    const tif = "https://upload.wikimedia.org/wikipedia/commons/8/88/Apollo_16_on_the_launchpad.tif";
    const openverse = parseOpenverse({ results: [{
      id: "ov-apollo-16", title: "Apollo 16 on the launchpad", url: tif, filetype: "tiff", width: 1237, height: 1234, license: "pdm", license_version: "1.0",
      foreign_landing_url: "https://commons.wikimedia.org/w/index.php?curid=136409215", source: "wikimedia", provider: "wikimedia", mature: false,
      thumbnail: "https://api.openverse.org/v1/images/ov-apollo-16/thumb/",
    }, { id: "ov-other", title: "Other", url: "https://live.staticflickr.com/1/other_b.jpg", filetype: "jpg", license: "cc0", license_version: "1.0" }] }, args());
    const rendition = "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/88/Apollo_16_on_the_launchpad.tif/lossless-page1-960px-Apollo_16_on_the_launchpad.tif.png?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail";
    const commons = parseWikimedia({ query: { pages: [{ pageid: 136409215, title: "File:Apollo 16 on the launchpad.tif", index: 1, imageinfo: [{
      width: 1237, height: 1234, mime: "image/tiff", thumburl: rendition.replace("-960px-", "-500px-"),
      url: `${tif}?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original`,
      descriptionurl: "https://commons.wikimedia.org/wiki/File:Apollo_16_on_the_launchpad.tif",
      extmetadata: { License: { value: "pd" }, LicenseShortName: { value: "Public domain" } },
    }] }] } }, args());
    expect(openverse[0]).toMatchObject({ url: tif, mimeType: "image/tiff" });
    expect(commons[0]).toMatchObject({ url: rendition, mimeType: "image/png" });

    // The default order asks Openverse first: the file keeps Openverse's place, as Commons gives it.
    const results = interleave([openverse, commons], 30);
    expect(results.map((result) => [result.index, result.id, result.url, result.mimeType])).toEqual([
      [1, commons[0]!.id, rendition, "image/png"],
      [2, openverse[1]!.id, openverse[1]!.url, "image/jpeg"],
    ]);
    expect(interleave([commons, openverse], 30).map((result) => result.id)).toEqual([commons[0]!.id, openverse[1]!.id]);
    // Even when Commons' copy falls past the limit.
    const other = { ...openverse[1]!, id: "openverse:x", url: "https://e.test/x.jpg" };
    expect(interleave([[openverse[1]!, openverse[0]!], [other, commons[0]!]], 3).map((result) => result.url)).toEqual([openverse[1]!.url, other.url, rendition]);
    expect(interleave([[openverse[0]!, openverse[1]!], [other, commons[0]!]], 1).map((result) => result.url)).toEqual([rendition]);
  });

  it("keeps Commons' 4K rendition of an original wider than that, rather than Openverse's link to the original", () => {
    const falcon = parseWikimedia(WIKIMEDIA_IMAGES, args()).find((result) => result.id === "wikimedia:33221100")!;
    const original = { ...parseOpenverse(OPENVERSE_IMAGES, args())[0]!, id: "openverse:falcon", url: "https://upload.wikimedia.org/wikipedia/commons/9/9a/Falcon_9_liftoff.jpg", width: 6000, height: 4000 };
    expect(interleave([[original], [falcon]], 30)).toEqual([{ index: 1, ...falcon }]);
    expect(falcon).toMatchObject({ url: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Falcon_9_liftoff.jpg/3840px-Falcon_9_liftoff.jpg", width: 3840 });
    // Two copies of a file outside Commons: the first stays.
    const a = { ...original, id: "openverse:a", url: "https://cdn.example/a.jpg" };
    expect(interleave([[a], [{ ...a, id: "openverse:b", url: "https://cdn.example/a.jpg?utm_source=x" }]], 30).map((result) => result.id)).toEqual(["openverse:a"]);
  });

  it("flattens HTML to one line of capped text", () => {
    expect(plainText("<b>Jane</b>\n&amp;<br/> John &#x2F; &#47; &quot;X&quot;")).toBe("Jane & John / / \"X\"");
    expect(plainText("x".repeat(300))).toHaveLength(200);
    expect(plainText(null)).toBe("");
  });
});
