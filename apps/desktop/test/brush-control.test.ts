import assert from "node:assert/strict";
import { test } from "node:test";

import { setBrushCommand, setToolCommand } from "../src/protocol/commands.js";
import { serializeCommands } from "../src/protocol/serializer.js";

test("setBrush expands from default pen round7 to square1", () => {
  assert.deepEqual(serializeCommands([setBrushCommand(1, "square")]), [
    "X",
    "X",
    "M -2 1",
    "A",
    "B",
  ]);
});

test("setBrush skips when the target is already selected", () => {
  assert.deepEqual(serializeCommands([setBrushCommand(7, "round")]), []);
});

test("setBrush tracks prior brush state", () => {
  assert.deepEqual(
    serializeCommands([
      setBrushCommand(3, "square"),
      setBrushCommand(1, "square"),
    ]),
    ["X", "X", "M -1 1", "A", "B", "X", "X", "M -1 0", "A", "B"],
  );
});

test("setTool switches between pen and eraser", () => {
  assert.deepEqual(
    serializeCommands([
      setToolCommand("eraser"),
      setToolCommand("pen"),
    ]),
    ["X", "M 1 0", "X", "B", "X", "M -1 0", "X", "B"],
  );
});

