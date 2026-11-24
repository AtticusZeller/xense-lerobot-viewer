import { describe, expect, it } from "bun:test";
import { parseTaskSpecYaml } from "../taskSpecYaml";

const EGG_CARTON_YAML = `
name: egg_carton_to_tray
subtasks:
  - name: open_carton
    prompt: "Open the egg carton."
  - name: place_eggs
    prompt: "Take out the eggs one by one and place them in the egg tray."
objects:
  - name: egg_carton
    subtask: open_carton
    event: release
    arm: right
    yaw_symmetry_deg: 180.0
fine_window_s: 1.0
coverage:
  xy_bin_m: 0.05
  yaw_bin_deg: 30.0
  sparse_threshold: 3
`;

describe("parseTaskSpecYaml", () => {
  it("parses egg_carton task_spec.yaml and ignores objects/coverage", () => {
    const spec = parseTaskSpecYaml(EGG_CARTON_YAML);
    expect(spec.name).toBe("egg_carton_to_tray");
    expect(spec.subtasks).toEqual([
      { name: "open_carton", prompt: "Open the egg carton." },
      {
        name: "place_eggs",
        prompt: "Take out the eggs one by one and place them in the egg tray.",
      },
    ]);
  });

  it("supports optional cameras in both block list and flow list forms", () => {
    const yaml = `
# comment header
name: four_stage_task
subtasks:
  - name: pick_lid
    prompt: 'Pick up the lid.' # inline comment
    cameras:
      - observation.images.right_wrist
      - observation.images.head
  - name: place_item
    prompt: "Place the item inside."
    cameras: [observation.images.left_wrist, "observation.images.head"]
`;
    const spec = parseTaskSpecYaml(yaml);
    expect(spec.subtasks).toEqual([
      {
        name: "pick_lid",
        prompt: "Pick up the lid.",
        cameras: ["observation.images.right_wrist", "observation.images.head"],
      },
      {
        name: "place_item",
        prompt: "Place the item inside.",
        cameras: ["observation.images.left_wrist", "observation.images.head"],
      },
    ]);
  });

  it("supports flow mapping items inside subtasks", () => {
    const yaml = `
name: compact
subtasks:
  - {name: step_one, prompt: "First step"}
  - {name: step_two, prompt: "Second step", cameras: [head]}
`;
    const spec = parseTaskSpecYaml(yaml);
    expect(spec.subtasks).toEqual([
      { name: "step_one", prompt: "First step" },
      { name: "step_two", prompt: "Second step", cameras: ["head"] },
    ]);
  });

  it("rejects empty or duplicate subtasks", () => {
    expect(() => parseTaskSpecYaml("name: empty\nsubtasks: []\n")).toThrow();
    expect(() =>
      parseTaskSpecYaml(`
name: dup
subtasks:
  - name: a
    prompt: "one"
  - name: a
    prompt: "two"
`),
    ).toThrow(/Duplicate subtask/);
  });
});
