import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchAll, parseEnvelope } from "../src/fetch";

const fixturesDir = join(import.meta.dir, "..", "fixtures");

describe("parseEnvelope", () => {
  test("parses totalCount and list items from a fixture without coercing values", async () => {
    const xml = await readFile(
      join(fixturesDir, "SVC01", "page-0001.xml"),
      "utf8",
    );

    expect(parseEnvelope(xml)).toEqual({
      totalCount: 5,
      items: [
        expect.objectContaining({
          pestiCode: "973",
          diseaseUseSeq: "1",
          cropName: "벼",
        }),
        expect.objectContaining({
          pestiCode: "973",
          diseaseUseSeq: "2",
          cropName: "배추",
        }),
        expect.objectContaining({
          pestiCode: "1201",
          diseaseUseSeq: "1",
          cropName: "밤",
        }),
      ],
    });
  });

  test("handles a flat detail fixture as an envelope with no list items", async () => {
    const xml = await readFile(join(fixturesDir, "SVC02", "973.xml"), "utf8");

    expect(parseEnvelope(xml)).toEqual({ items: [] });
  });
});

describe("fetchAll mock mode", () => {
  test("copies every fixture without network access and writes a done manifest", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "nongyak-fetch-"));
    const rawDir = join(tempDir, "raw");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (..._args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
        throw new Error("mock mode attempted network access");
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      await fetchAll({ mock: true, rawDir });

      expect(
        await readFile(join(rawDir, "SVC01", "page-0001.xml"), "utf8"),
      ).toBe(
        await readFile(join(fixturesDir, "SVC01", "page-0001.xml"), "utf8"),
      );
      expect(
        await readFile(join(rawDir, "SVC02", "973.xml"), "utf8"),
      ).toBe(await readFile(join(fixturesDir, "SVC02", "973.xml"), "utf8"));

      const manifest = JSON.parse(
        await readFile(join(rawDir, "manifest.json"), "utf8"),
      ) as {
        SVC01: {
          totalCount: number;
          pageSize: number;
          fetchedPages: number[];
          done: boolean;
        };
        SVC02: { pending: string[]; done: string[] };
        SVC07: {
          totalCount: number;
          fetchedPages: number[];
          done: boolean;
        };
        SVC08: {
          totalCount: number;
          fetchedPages: number[];
          done: boolean;
        };
      };

      expect(manifest.SVC01).toMatchObject({
        totalCount: 5,
        pageSize: 50,
        fetchedPages: [1, 2],
        done: true,
      });
      expect(manifest.SVC02).toMatchObject({
        pending: [],
        done: ["1201", "1544", "2088", "973"],
      });
      expect(manifest.SVC07).toMatchObject({
        totalCount: 2,
        fetchedPages: [1],
        done: true,
      });
      expect(manifest.SVC08).toMatchObject({
        totalCount: 2,
        fetchedPages: [1],
        done: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
