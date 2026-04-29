import React, { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Select } from "@/components/ui/Select";

function Harness({ initial = "image" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <Select value={value} onValueChange={setValue}>
        <Select.Trigger aria-label="kind" data-testid="kind-trigger">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="image" data-testid="kind-image">
            Image set
          </Select.Item>
          <Select.Item value="video" data-testid="kind-video">
            Video
          </Select.Item>
        </Select.Content>
      </Select>
      <output data-testid="current-value">{value}</output>
    </div>
  );
}

describe("Select primitive (v3.0)", () => {
  it("renders the trigger with the current value text", () => {
    const { getByTestId } = render(<Harness initial="image" />);
    const trigger = getByTestId("kind-trigger");
    expect(trigger.textContent).toContain("Image set");
  });

  it("changes value when an item is clicked", async () => {
    const { findByTestId, getByTestId } = render(<Harness initial="image" />);
    const trigger = getByTestId("kind-trigger");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    const videoItem = await findByTestId("kind-video");
    fireEvent.click(videoItem);
    expect(getByTestId("current-value").textContent).toBe("video");
  });
});
