/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Provider responses for the web media tests, written by hand after the
// documented shapes: Openverse's `/v1/images/` and `/v1/audio/` search
// (https://api.openverse.org/v1/) and the MediaWiki Action API's
// `generator=search` + `prop=imageinfo` on Wikimedia Commons, format
// versions 2 and 1. Field values are representative, including the awkward
// ones: null titles, HTML in artist fields, licenses a filter must drop.

const OV = "https://api.openverse.org/v1";

const openverseImage = (id: string, fields: Record<string, unknown>) => ({
  id,
  title: "Untitled",
  indexed_on: "2023-05-17T14:12:09.553311Z",
  foreign_landing_url: `https://www.flickr.com/photos/example/${id}`,
  url: `https://live.staticflickr.com/65535/${id}_b.jpg`,
  creator: "Example Photographer",
  creator_url: "https://www.flickr.com/photos/example",
  license: "by",
  license_version: "2.0",
  license_url: "https://creativecommons.org/licenses/by/2.0/",
  provider: "flickr",
  source: "flickr",
  category: "photograph",
  genres: null,
  filesize: null,
  filetype: "jpg",
  tags: [{ name: "rocket", accuracy: null, unstable__provider: "flickr" }],
  alt_files: null,
  attribution: "\"Untitled\" by Example Photographer is licensed under CC BY 2.0.",
  fields_matched: ["title"],
  mature: false,
  height: 768,
  width: 1024,
  thumbnail: `${OV}/images/${id}/thumb/`,
  detail_url: `${OV}/images/${id}/`,
  related_url: `${OV}/images/${id}/related/`,
  unstable__sensitivity: [],
  ...fields,
});

export const OPENVERSE_IMAGES = {
  result_count: 2178,
  page_count: 109,
  page_size: 20,
  page: 1,
  results: [
    openverseImage("f9384235-b72e-4f1e-9b05-e1b116262a29", {
      title: "Apollo 11 Launch",
      foreign_landing_url: "https://www.flickr.com/photos/nasacommons/9460707453",
      url: "https://live.staticflickr.com/7414/9460707453_8c5a1d8e32_b.jpg",
      creator: "NASA on The Commons",
      license: "pdm",
      license_version: "1.0",
      license_url: "https://creativecommons.org/publicdomain/mark/1.0/",
      height: 1024,
      width: 819,
    }),
    openverseImage("2b1f9c50-7c2e-4a61-a3c4-6f0ad1b2c3d4", {
      title: "Saturn V on the pad at dusk",
      creator: "Kim &amp; Lee",
      license: "by-sa",
      license_version: "2.0",
      license_url: "https://creativecommons.org/licenses/by-sa/2.0/",
      width: 2048,
      height: 1365,
      source: "wikimedia",
      provider: "wikimedia",
      foreign_landing_url: "https://commons.wikimedia.org/w/index.php?curid=1234567",
      url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Saturn_V_dusk.jpg",
      filetype: "jpg",
    }),
    // No derivatives: dropped from an "editable" search.
    openverseImage("6e7d1c2b-0a9f-4e8d-8c7b-6a5f4e3d2c1b", { title: "Launch control room", license: "by-nd", license_url: "https://creativecommons.org/licenses/by-nd/2.0/" }),
    // Non-commercial: kept for "editable", dropped for "commercial".
    openverseImage("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", { title: "Crawler-transporter", license: "by-nc", license_url: "https://creativecommons.org/licenses/by-nc/2.0/", filetype: "png" }),
    // Null title and creator, as Openverse sends them for some providers.
    openverseImage("0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e", {
      title: null, creator: null, license: "cc0", license_version: "1.0", license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
      provider: "stocksnap", source: "stocksnap", foreign_landing_url: "https://stocksnap.io/photo/rocket-XNVBVXO3B7", url: "https://cdn.stocksnap.io/img-thumbs/960w/XNVBVXO3B7.jpg",
    }),
    // Unusable: no file URL, or a license code Openverse does not document.
    openverseImage("11111111-2222-4333-8444-555555555555", { url: null }),
    openverseImage("66666666-7777-4888-9999-aaaaaaaaaaaa", { license: "all-rights-reserved" }),
  ],
  warnings: [],
};

export const OPENVERSE_AUDIO = {
  result_count: 31,
  page_count: 2,
  page_size: 20,
  page: 1,
  results: [
    {
      id: "8624ba61-57f1-4f98-8a85-ece206c319cf",
      title: "Rocket launch countdown",
      indexed_on: "2021-02-24T04:25:46Z",
      foreign_landing_url: "https://freesound.org/people/space-sounds/sounds/412345/",
      url: "https://cdn.freesound.org/previews/412/412345_6142149-hq.mp3",
      creator: "space-sounds",
      creator_url: "https://freesound.org/people/space-sounds/",
      license: "by",
      license_version: "4.0",
      license_url: "https://creativecommons.org/licenses/by/4.0/",
      provider: "freesound",
      source: "freesound",
      category: "sound_effect",
      genres: [],
      filesize: 1031200,
      filetype: "mp3",
      tags: [{ name: "countdown", accuracy: null, unstable__provider: "freesound" }],
      alt_files: [{ url: "https://freesound.org/apiv2/sounds/412345/download/", filesize: 4100000, filetype: "wav", sample_rate: 44100, bit_rate: 1411200 }],
      attribution: "\"Rocket launch countdown\" by space-sounds is licensed under CC BY 4.0.",
      fields_matched: ["title"],
      mature: false,
      audio_set: null,
      duration: 12850,
      bit_rate: 128000,
      sample_rate: 44100,
      thumbnail: null,
      detail_url: `${OV}/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/`,
      related_url: `${OV}/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/related/`,
      waveform: `${OV}/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/waveform/`,
      unstable__sensitivity: [],
    },
    {
      id: "c0ffee00-1234-4abc-9def-0123456789ab",
      title: "Ambient mission control loop",
      indexed_on: "2022-08-01T10:00:00Z",
      foreign_landing_url: "https://ccmixter.org/files/someone/61234",
      url: "https://ccmixter.org/content/someone/someone_-_Mission_Control.mp3",
      creator: "someone",
      creator_url: "https://ccmixter.org/people/someone",
      license: "sampling+",
      license_version: "1.0",
      license_url: "https://creativecommons.org/licenses/sampling+/1.0/",
      provider: "ccmixter",
      source: "ccmixter",
      category: "music",
      genres: ["ambient"],
      filesize: null,
      filetype: "mp3",
      tags: [],
      alt_files: null,
      attribution: "\"Ambient mission control loop\" by someone is licensed under CC Sampling+ 1.0.",
      fields_matched: ["title"],
      mature: false,
      audio_set: null,
      duration: 184000,
      bit_rate: 192000,
      sample_rate: 44100,
      thumbnail: `${OV}/audio/c0ffee00-1234-4abc-9def-0123456789ab/thumb/`,
      detail_url: `${OV}/audio/c0ffee00-1234-4abc-9def-0123456789ab/`,
      related_url: `${OV}/audio/c0ffee00-1234-4abc-9def-0123456789ab/related/`,
      waveform: `${OV}/audio/c0ffee00-1234-4abc-9def-0123456789ab/waveform/`,
      unstable__sensitivity: [],
    },
  ],
  warnings: [],
};

const UP = "https://upload.wikimedia.org/wikipedia/commons";
const meta = (fields: Record<string, string>) =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value, source: "commons-desc-page", hidden: "" }]));

/** `formatversion=2`: `query.pages` is an array, each with its search `index`; out of order on purpose. */
export const WIKIMEDIA_IMAGES = {
  batchcomplete: true,
  continue: { gsroffset: 10, continue: "gsroffset||" },
  query: {
    pages: [
      {
        pageid: 1532211,
        ns: 6,
        title: "File:Apollo 11 Launch - GPN-2000-000630.jpg",
        index: 2,
        imagerepository: "local",
        imageinfo: [{
          thumburl: `${UP}/thumb/2/25/Apollo_11_Launch_-_GPN-2000-000630.jpg/500px-Apollo_11_Launch_-_GPN-2000-000630.jpg`,
          thumbwidth: 500,
          thumbheight: 625,
          responsiveUrls: { "2": `${UP}/thumb/2/25/Apollo_11_Launch_-_GPN-2000-000630.jpg/960px-Apollo_11_Launch_-_GPN-2000-000630.jpg` },
          size: 2340551,
          width: 2400,
          height: 3000,
          url: `${UP}/2/25/Apollo_11_Launch_-_GPN-2000-000630.jpg`,
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Apollo_11_Launch_-_GPN-2000-000630.jpg",
          descriptionshorturl: "https://commons.wikimedia.org/w/index.php?curid=1532211",
          mime: "image/jpeg",
          extmetadata: meta({
            ObjectName: "Apollo 11 Launch - GPN-2000-000630",
            LicenseShortName: "Public domain",
            License: "pd",
            Artist: "<a href=\"//en.wikipedia.org/wiki/NASA\" class=\"extiw\" title=\"en:NASA\">NASA</a>",
          }),
        }],
      },
      {
        pageid: 99887766,
        ns: 6,
        title: "File:Kennedy Space Center panorama.tif",
        index: 1,
        imagerepository: "local",
        imageinfo: [{
          thumburl: `${UP}/thumb/7/7e/Kennedy_Space_Center_panorama.tif/lossy-page1-500px-Kennedy_Space_Center_panorama.tif.jpg`,
          thumbwidth: 500,
          thumbheight: 167,
          size: 162000000,
          width: 9000,
          height: 3000,
          url: `${UP}/7/7e/Kennedy_Space_Center_panorama.tif`,
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Kennedy_Space_Center_panorama.tif",
          descriptionshorturl: "https://commons.wikimedia.org/w/index.php?curid=99887766",
          mime: "image/tiff",
          extmetadata: meta({
            ObjectName: "Kennedy Space Center panorama",
            LicenseShortName: "CC BY-SA 4.0",
            License: "cc-by-sa-4.0",
            LicenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
            Artist: "<span class=\"fn\" id=\"creator\"><bdi>Jane Doe &amp; John Roe</bdi></span>",
          }),
        }],
      },
      {
        pageid: 55443322,
        ns: 6,
        title: "File:Mission patch (non-free).png",
        index: 3,
        imagerepository: "local",
        imageinfo: [{
          thumburl: `${UP}/thumb/1/12/Mission_patch.png/500px-Mission_patch.png`,
          width: 1000, height: 1000,
          url: `${UP}/1/12/Mission_patch.png`,
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Mission_patch_(non-free).png",
          mime: "image/png",
          extmetadata: meta({ LicenseShortName: "Fair use", NonFree: "true" }),
        }],
      },
      {
        pageid: 44332211,
        ns: 6,
        title: "File:Launch tower sketch.png",
        index: 4,
        imagerepository: "local",
        imageinfo: [{
          thumburl: `${UP}/thumb/3/3c/Launch_tower_sketch.png/500px-Launch_tower_sketch.png`,
          width: 1200, height: 900,
          url: `${UP}/3/3c/Launch_tower_sketch.png`,
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Launch_tower_sketch.png",
          mime: "image/png",
          // A license Cutroom does not recognize is left out rather than guessed.
          extmetadata: meta({ LicenseShortName: "Copyrighted free use with conditions", License: "copyrighted-free-use-provided-that" }),
        }],
      },
      {
        pageid: 33221100,
        ns: 6,
        title: "File:Falcon 9 liftoff.jpg",
        index: 5,
        imagerepository: "local",
        imageinfo: [{
          thumburl: `${UP}/thumb/9/9a/Falcon_9_liftoff.jpg/500px-Falcon_9_liftoff.jpg`,
          thumbwidth: 500,
          thumbheight: 333,
          width: 6000,
          height: 4000,
          url: `${UP}/9/9a/Falcon_9_liftoff.jpg`,
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Falcon_9_liftoff.jpg",
          mime: "image/jpeg",
          extmetadata: meta({ LicenseShortName: "CC BY 2.0", License: "cc-by-2.0", LicenseUrl: "https://creativecommons.org/licenses/by/2.0" }),
        }],
      },
    ],
  },
};

/** `formatversion=1`: `query.pages` is an object keyed by page id. */
export const WIKIMEDIA_VIDEO_V1 = {
  batchcomplete: "",
  query: {
    pages: {
      "70011001": {
        pageid: 70011001,
        ns: 6,
        title: "File:Apollo 11 liftoff (1969).webm",
        index: 1,
        imagerepository: "local",
        imageinfo: [{
          thumburl: `${UP}/thumb/4/4d/Apollo_11_liftoff_%281969%29.webm/500px--Apollo_11_liftoff_%281969%29.webm.jpg`,
          width: 1920,
          height: 1080,
          duration: 43.52,
          url: `${UP}/4/4d/Apollo_11_liftoff_%281969%29.webm`,
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Apollo_11_liftoff_(1969).webm",
          mime: "video/webm",
          extmetadata: meta({ ObjectName: "Apollo 11 liftoff (1969)", LicenseShortName: "Public domain", License: "pd", Artist: "NASA" }),
        }],
      },
      "70011002": {
        pageid: 70011002,
        ns: 6,
        title: "File:Launch archive.ogv",
        index: 2,
        imagerepository: "local",
        imageinfo: [{
          thumburl: `${UP}/thumb/5/5e/Launch_archive.ogv/500px--Launch_archive.ogv.jpg`,
          width: 640,
          height: 480,
          duration: 120,
          url: `${UP}/5/5e/Launch_archive.ogv`,
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Launch_archive.ogv",
          // Theora, which the editor cannot decode.
          mime: "application/ogg",
          extmetadata: meta({ LicenseShortName: "CC BY 3.0", License: "cc-by-3.0" }),
        }],
      },
    },
  },
};

/** No matches: the API answers without a `query` at all. */
export const WIKIMEDIA_EMPTY = { batchcomplete: true };
