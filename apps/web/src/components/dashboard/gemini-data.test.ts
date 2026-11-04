import { describe, expect, it } from "vitest";
import { GEMINI_DISCLOSURE, GEMINI_KEY_URL, GEMINI_PURPOSE, canSaveGeminiKey, canSaveGeminiModel, geminiLine } from "./gemini-data";

import type { GeminiStatus } from "@desktop/gemini/types";

// Built in two pieces: a literal in this shape would look like a real key to a secret scanner.
const KEY = ["AIza", "SyTestKeyForCutroomUnitTests_0123456"].join("");
const base: GeminiStatus = { configured: false, encryption: true, model: "gemini-3.8-flash", defaultModel: "gemini-3.8-flash" };

describe("geminiLine", () => {
  it("says nothing is sent until a key is saved", () => {
    expect(geminiLine(base)).toBe("No key saved. Nothing is sent to Google.");
  });

  it("names the key by its last four characters and the model it goes to", () => {
    expect(geminiLine({ ...base, configured: true, hint: "k3Yz" })).toBe("Ready, key ending k3Yz. Questions go to gemini-3.8-flash.");
    expect(geminiLine({ ...base, configured: true, hint: "k3Yz", model: "gemini-3.5-flash-lite" })).toBe("Ready, key ending k3Yz. Questions go to gemini-3.5-flash-lite.");
    expect(geminiLine({ ...base, configured: true })).toBe("Ready. Questions go to gemini-3.8-flash.");
  });

  it("explains a Mac that can't store a key safely, and a key that can't be read", () => {
    expect(geminiLine({ ...base, encryption: false })).toMatch(/won't save one\. Nothing is sent to Google\.$/);
    expect(geminiLine({ ...base, error: "The saved Gemini key can't be decrypted on this Mac. Save it again." })).toBe("The saved Gemini key can't be decrypted on this Mac. Save it again.");
  });
});

describe("what Settings tells the user before a key is added", () => {
  it("says the file is uploaded to Google under their key, and deleted afterwards", () => {
    expect(GEMINI_DISCLOSURE).toMatch(/uploaded to Google under your key/);
    expect(GEMINI_DISCLOSURE).toMatch(/deleted again afterwards/);
    expect(GEMINI_DISCLOSURE).toMatch(/only its sound/);
    expect(GEMINI_DISCLOSURE).toMatch(/YouTube link sends just the link/);
  });

  it("is straight about Google's free tier using what is sent, and what avoids that", () => {
    expect(GEMINI_DISCLOSURE).toMatch(/free tier.*used to improve its products/);
    expect(GEMINI_DISCLOSURE).toMatch(/paid key.*billing turned on.*isn't/);
    expect(GEMINI_DISCLOSURE).toMatch(/private footage, use a paid key/);
  });

  it("says it is off until the user adds their own key, and where a key comes from", () => {
    expect(GEMINI_PURPOSE).toMatch(/Off until you add your own key\.$/);
    expect(GEMINI_KEY_URL).toBe("https://aistudio.google.com/apikey");
  });
});

describe("what can be saved", () => {
  it("offers Save key for something long enough to be a key, and only where the Mac can encrypt it", () => {
    expect(canSaveGeminiKey("", base)).toBe(false);
    expect(canSaveGeminiKey("short", base)).toBe(false);
    expect(canSaveGeminiKey(KEY, base)).toBe(true);
    expect(canSaveGeminiKey(`   ${KEY}  `, base)).toBe(true);
    expect(canSaveGeminiKey(KEY, { ...base, encryption: false })).toBe(false);
    expect(canSaveGeminiKey(KEY, undefined)).toBe(false);
  });

  it("offers Save for a model different from the one in use, and for emptying back to the default", () => {
    const custom = { ...base, model: "gemini-3.5-flash-lite" };
    expect(canSaveGeminiModel("gemini-3.8-flash", base)).toBe(false);
    expect(canSaveGeminiModel("", base)).toBe(false);
    expect(canSaveGeminiModel("gemini-3.5-flash-lite", base)).toBe(true);
    expect(canSaveGeminiModel(" models/gemini-3.5-flash-lite ", custom)).toBe(false);
    expect(canSaveGeminiModel("", custom)).toBe(true);
    expect(canSaveGeminiModel("anything", undefined)).toBe(false);
  });
});
