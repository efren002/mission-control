import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogApi } from "@/features/catalog/api";

import {
  MAX_MISSION_IMAGES,
  MissionAttachments,
  MissionImagePicker,
  acceptMissionImages,
} from "./mission-attachments";

function imageFile(name: string, type = "image/png", size = 1024): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("acceptMissionImages", () => {
  it("accepts supported images and reports rejected files", () => {
    const { accepted, rejected } = acceptMissionImages(
      [
        imageFile("mockup.png"),
        imageFile("notes.txt", "text/plain"),
        imageFile("huge.png", "image/png", 6 * 1024 * 1024),
      ],
      0,
    );

    expect(accepted.map((file) => file.name)).toEqual(["mockup.png"]);
    expect(rejected).toHaveLength(2);
    expect(rejected[0]).toContain("notes.txt");
    expect(rejected[1]).toContain("5 MB");
  });

  it("enforces the per-mission image limit", () => {
    const { accepted, rejected } = acceptMissionImages(
      [imageFile("one.png"), imageFile("two.png")],
      MAX_MISSION_IMAGES - 1,
    );

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain(`${MAX_MISSION_IMAGES}`);
  });
});

describe("MissionImagePicker", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("offers the attach control with previews of selected files", () => {
    render(
      <MissionImagePicker files={[imageFile("error.png")]} onChange={() => undefined} />,
    );

    expect(screen.getByRole("button", { name: /attach images/i })).toBeInTheDocument();
    expect(screen.getByText("error.png")).toBeInTheDocument();
  });

  it("accepts images dropped onto the picker", () => {
    const onChange = vi.fn();
    const { container } = render(<MissionImagePicker files={[]} onChange={onChange} />);
    const dropped = imageFile("dropped.png");

    fireEvent.drop(container.firstChild as Element, {
      dataTransfer: { files: [dropped], types: ["Files"] },
    });

    expect(onChange).toHaveBeenCalledWith([dropped]);
  });
});

describe("MissionAttachments", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists the mission images that agents will see", async () => {
    vi.spyOn(catalogApi, "attachments").mockResolvedValue([
      {
        id: "attachment-1",
        objective_id: "objective-1",
        filename: "login-error.png",
        content_type: "image/png",
        size_bytes: 2048,
        created_at: "2026-07-19T10:00:00Z",
      },
    ]);
    vi.spyOn(catalogApi, "attachmentContent").mockResolvedValue(
      new Blob(["x"], { type: "image/png" }),
    );

    render(<MissionAttachments token="local-token" objectiveId="objective-1" />);

    expect(await screen.findByText("login-error.png")).toBeInTheDocument();
    expect(screen.getByText(/images \(1\/6\)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add image/i })).toBeInTheDocument();
  });
});
