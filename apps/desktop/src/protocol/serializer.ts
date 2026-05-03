import type { DrawCommand } from "./commands.js";
import type { BrushShape, BrushSize } from "../types.js";

type BrushTool = "pen" | "eraser";

export interface BrushSelection {
  size: BrushSize;
  shape: BrushShape;
}

export interface BrushMenuState {
  currentTool: BrushTool;
  brushes: Record<BrushTool, BrushSelection>;
}

const BRUSH_SIZE_COLUMNS: BrushSize[] = [1, 3, 7, 13, 19, 27];

export function createInitialBrushMenuState(): BrushMenuState {
  return {
    currentTool: "pen",
    brushes: {
      pen: { size: 7, shape: "round" },
      eraser: { size: 3, shape: "round" },
    },
  };
}

function cloneBrushMenuState(state: BrushMenuState): BrushMenuState {
  return {
    currentTool: state.currentTool,
    brushes: {
      pen: { ...state.brushes.pen },
      eraser: { ...state.brushes.eraser },
    },
  };
}

function serializeMove(dx: number, dy: number): string[] {
  if (dx === 0 && dy === 0) {
    return [];
  }

  return [`M ${dx} ${dy}`];
}

function getBrushColumn(size: BrushSize): number {
  const column = BRUSH_SIZE_COLUMNS.indexOf(size);

  if (column < 0) {
    throw new Error(`Unsupported brush size: ${size}`);
  }

  return column;
}

export function expandSetBrush(state: BrushMenuState, target: BrushSelection): string[] {
  const current = state.brushes[state.currentTool];

  if (current.size === target.size && current.shape === target.shape) {
    return [];
  }

  const currentColumn = getBrushColumn(current.size);
  const targetColumn = getBrushColumn(target.size);
  const currentRow = current.shape === "round" ? 0 : 1;
  const targetRow = target.shape === "round" ? 0 : 1;
  const commands = [
    "X",
    "X",
    ...serializeMove(targetColumn - currentColumn, targetRow - currentRow),
    "A",
    "B",
  ];

  state.brushes[state.currentTool] = { ...target };
  return commands;
}

export function expandSetTool(state: BrushMenuState, targetTool: BrushTool): string[] {
  if (state.currentTool === targetTool) {
    return [];
  }

  const dx = targetTool === "eraser" ? 1 : -1;
  state.currentTool = targetTool;
  return ["X", ...serializeMove(dx, 0), "X", "B"];
}

export function serializeCommand(command: DrawCommand): string {
  switch (command.type) {
    case "inputConfig":
      return `CFG INPUT ${command.buttonPressMs} ${command.inputDelayMs} ${command.homeMs}`;
    case "home":
      return "H";
    case "move":
      return `M ${command.dx} ${command.dy}`;
    case "line":
      return `L ${command.dx} ${command.dy}`;
    case "draw":
      return "P";
    case "press":
      return command.button;
    case "color":
      return `C ${command.index}`;
    case "basicPaletteReset":
      return "BC RESET";
    case "paletteConfig":
      return `PC ${command.slot} ${command.colorHex}`;
    case "basicPaletteConfig":
      return `BC ${command.slot} ${command.row} ${command.col}`;
    case "setBrush":
      throw new Error("setBrush is stateful; use serializeCommands instead");
    case "setTool":
      throw new Error("setTool is stateful; use serializeCommands instead");
    case "wait":
      return `W ${command.ms}`;
    case "pause":
      return "S";
    case "resume":
      return "R";
    case "end":
      return "E";
    default:
      throw new Error(`Unknown command: ${JSON.stringify(command)}`);
  }
}

export function serializeCommandsWithState(
  commands: DrawCommand[],
  initialBrushState = createInitialBrushMenuState(),
): { commands: string[]; brushState: BrushMenuState } {
  const brushState = cloneBrushMenuState(initialBrushState);
  const serialized: string[] = [];

  for (const command of commands) {
    switch (command.type) {
      case "setBrush":
        serialized.push(...expandSetBrush(brushState, command));
        break;
      case "setTool":
        serialized.push(...expandSetTool(brushState, command.tool));
        break;
      default:
        serialized.push(serializeCommand(command));
        break;
    }
  }

  return {
    commands: serialized,
    brushState,
  };
}

export function serializeCommands(commands: DrawCommand[]): string[] {
  return serializeCommandsWithState(commands).commands;
}
