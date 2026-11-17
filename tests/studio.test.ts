import { describe, expect, test } from "bun:test";
import { jobs_of, slug_of } from "../src/studio/jobs.js";

describe("studio jobs", () => {
  test("file names come from the prompt", () => {
    expect(slug_of("A low-poly wooden barrel, with two metal hoops!")).toBe(
      "a-low-poly-wooden-barrel-with-two-metal",
    );
    expect(slug_of("!!!")).toBe("model");
  });

  test("reads jobs from a tool reply and ignores anything malformed", () => {
    const job = {
      id: "f6f4f81c-8859-4841-b81f-111fdfc277a0",
      status: "done",
      prompt: "chest",
      preview_id: "c6f81ce1-facc-408f-8f29-67660898453d",
      preview_url: "https://chat.nemu.cc/preview/c6f81ce1-facc-408f-8f29-67660898453d",
      model: "agentrouter/gpt-5.6-sol",
      format: "glb",
      progress: null,
      error: null,
      download_url: "https://example.r2.cloudflarestorage.com/x.glb",
      triangles: 4632,
      bytes: 100,
      is_cloud_rendered: true,
      created_at: "2026-11-17T12:00:03.472Z",
      finished_at: "2026-11-17T12:07:57.000Z",
    };
    expect(jobs_of({ jobs: [job] })).toHaveLength(1);
    expect(jobs_of({ jobs: [{ ...job, status: "lost" }] })).toEqual([]);
  });
});
