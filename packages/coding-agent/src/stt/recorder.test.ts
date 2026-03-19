import { afterEach, describe, expect, it, vi } from "bun:test";
import { detectRecordingTools, startRecording } from "./recorder";

type SpawnProc = ReturnType<typeof Bun.spawn>;

function createRunningProc(): SpawnProc {
	return {
		stdin: { write: vi.fn(), end: vi.fn() },
		kill: vi.fn(),
		exited: new Promise<number>(() => {}),
		stdout: 1,
		stderr: 2,
	} as unknown as SpawnProc;
}

function mockAvailableTools(...tools: string[]): void {
	const available = new Set(tools);
	vi.spyOn(Bun, "which").mockImplementation((tool: string) => (available.has(tool) ? `/usr/bin/${tool}` : null));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("detectRecordingTools", () => {
	it("prefers ffmpeg when an explicit input device is configured", () => {
		mockAvailableTools("sox", "ffmpeg", "arecord");

		expect(detectRecordingTools({ inputDevice: "  webcam-mic  " })).toEqual(["ffmpeg"]);
	});
});

describe("startRecording", () => {
	it("uses the configured linux input device instead of pulse default", async () => {
		mockAvailableTools("sox", "ffmpeg", "arecord");
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const spawnSpy = vi.spyOn(Bun, "spawn").mockReturnValue(createRunningProc());

		await startRecording("/tmp/omp-recorder-test.wav", { inputDevice: "alsa_input.webcam" });

		expect(spawnSpy).toHaveBeenCalledWith(
			[
				"ffmpeg",
				"-f",
				"pulse",
				"-i",
				"alsa_input.webcam",
				"-ar",
				"16000",
				"-ac",
				"1",
				"-sample_fmt",
				"s16",
				"-y",
				"/tmp/omp-recorder-test.wav",
			],
			expect.objectContaining({ stdin: "pipe", stdout: "pipe", stderr: "ignore" }),
		);
	});

	it("requires ffmpeg when an explicit input device is configured", async () => {
		mockAvailableTools("sox", "arecord");

		await expect(startRecording("/tmp/omp-recorder-test.wav", { inputDevice: "alsa_input.webcam" })).rejects.toThrow(
			"No compatible audio recording tool found for stt.inputDevice. Install FFmpeg or clear stt.inputDevice to use the system default input.",
		);
	});
});
