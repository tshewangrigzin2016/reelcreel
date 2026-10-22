import { describe, expect, test } from "bun:test";
import { explainYtDlpError, isChallengeError } from "../server/lib/spawn";

describe("explainYtDlpError", () => {
  test("adds hosted-deployment guidance to a YouTube sign-in wall", () => {
    const raw =
      "ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies for the authentication.";
    const explained = explainYtDlpError(raw);
    expect(explained).toContain(raw);
    expect(explained).toContain("Settings → YouTube cookies");
    expect(explained).toContain("Upload a cookies.txt");
  });

  test("does not duplicate the guidance", () => {
    const once = explainYtDlpError("Sign in to confirm you’re not a bot.");
    expect(explainYtDlpError(once)).toBe(once);
  });

  test("leaves unrelated errors alone", () => {
    const raw = "ERROR: [youtube] abc: Video unavailable";
    expect(explainYtDlpError(raw)).toBe(raw);
  });

  test("still classifies challenge errors", () => {
    expect(isChallengeError("ERROR: Sign in to confirm you’re not a bot.")).toBe(
      true,
    );
    expect(isChallengeError("ERROR: Video unavailable")).toBe(false);
  });
});
