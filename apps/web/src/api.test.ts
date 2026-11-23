import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("API response handling", () => {
  it("reports a non-JSON Vercel error without leaking a JSON parse exception", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("The page could not be found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    ));

    await expect(api("/api/v1/auth/register", {
      method: "POST",
      body: "{}",
    })).rejects.toThrow(
      "API returned a non-JSON response (HTTP 404). Check the Vercel API function routing.",
    );
  });
});
