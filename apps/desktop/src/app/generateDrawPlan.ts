import type { ImageSource } from "../image/loadImage.js";
import { createBrushGrid, gridCellBounds, isGridCellInBounds } from "../brushGrid.js";
import { pixelizeImage } from "../image/pixelize.js";
import { renderPreviewToBuffer } from "../image/renderPreview.js";
import { estimateRuntimeMs, generateScanlineCommands } from "../path/scanline.js";
import { createInitialBrushMenuState, serializeCommands, serializeCommandsWithState } from "../protocol/serializer.js";
import { endCommand, setBrushCommand, setToolCommand, type DrawCommand } from "../protocol/commands.js";
import type { CanvasBounds, ColorDistanceMode, DitherMode, DrawingProfile, PixelMap } from "../types.js";

export interface DrawPlanPathStats {
  lineRunCount: number;
  maxMoveSteps: number;
  longMoveOver50: number;
  longMoveOver100: number;
  longMoveOver200: number;
}

export interface DrawPlan {
  commands: string[];
  pixelMap: PixelMap;
  usedColorIndexes: number[];
  colorCounts: Record<number, number>;
  paletteHexes: string[];
  totalPixels: number;
  estimatedRuntimeMs: number;
  previewPng: Buffer;
  imageBounds: CanvasBounds | null;
  pathStats: DrawPlanPathStats;
}

export interface DualPassDrawPlan extends DrawPlan {
  pass1: DrawPlan;
  pass2: DrawPlan;
  pass1PreviewPng: Buffer;
  correctedPreviewPng: Buffer;
}

function cloneProfileWithBrush(
  profile: DrawingProfile,
  brushSize: DrawingProfile["brushSize"],
  brushShape = profile.brushShape,
): DrawingProfile {
  return {
    ...profile,
    brushSize,
    brushShape,
  };
}

export async function generateDrawPlan(
  imageSource: ImageSource,
  profile: DrawingProfile,
  previewScale = 12,
  options?: {
    imageScalePercent?: number;
    imageOffsetXPercent?: number;
    imageOffsetYPercent?: number;
    removeBackground?: boolean;
    brightness?: number;
    contrast?: number;
    saturation?: number;
    ditherMode?: DitherMode;
    ditherAmount?: number;
    colorDistanceMode?: ColorDistanceMode;
    mergeSimilarColors?: boolean;
    mergeThreshold?: number;
  },
): Promise<DrawPlan> {
  const { pixelMap, usedColorIndexes, colorCounts } = await pixelizeImage(imageSource, profile, options);
  const previewPng = await renderPreviewToBuffer(pixelMap, profile, previewScale);
  const drawCommands = generateScanlineCommands(pixelMap, profile);
  const imageBounds = calculateCanvasBounds(pixelMap, profile);
  const pathStats = calculatePathStats(drawCommands);
  const paletteHexes = Array.from(
    pixelMap
      .flatMap((row) =>
        row
          .filter((pixel) => pixel.alpha > 0 && pixel.colorIndex >= 0)
          .map((pixel) => [pixel.colorIndex, pixel.colorHex] as const),
      )
      .reduce((map, [colorIndex, colorHex]) => map.set(colorIndex, colorHex), new Map<number, string>())
      .entries(),
  )
    .sort((a, b) => a[0] - b[0])
    .map(([, colorHex]) => colorHex);

  return {
    commands: serializeCommands(drawCommands),
    pixelMap,
    usedColorIndexes,
    colorCounts,
    paletteHexes,
    totalPixels: pixelMap.length * (pixelMap[0]?.length ?? 0),
    estimatedRuntimeMs: estimateRuntimeMs(drawCommands, profile),
    previewPng,
    imageBounds,
    pathStats,
  };
}

function createEmptyPixel(x: number, y: number): PixelMap[number][number] {
  return {
    x,
    y,
    colorIndex: -1,
    colorHex: "#ffffff",
    alpha: 0,
  };
}

function readCoarsePixelAtCanvasPixel(coarseMap: PixelMap, x: number, y: number) {
  const coarseX = Math.floor(x / 3);
  const coarseY = Math.floor(y / 3);

  return coarseMap[coarseY]?.[coarseX] ?? null;
}

function buildDualPassCorrectionMap(targetMap: PixelMap, coarseMap: PixelMap): PixelMap {
  return targetMap.map((row, y) =>
    row.map((targetPixel, x) => {
      const coarsePixel = readCoarsePixelAtCanvasPixel(coarseMap, x, y);
      const coarseColorIndex =
        coarsePixel && coarsePixel.alpha > 0 && coarsePixel.colorIndex >= 0
          ? coarsePixel.colorIndex
          : -1;

      if (targetPixel.alpha <= 0 || targetPixel.colorIndex < 0) {
        return createEmptyPixel(x, y);
      }

      if (targetPixel.colorIndex === coarseColorIndex) {
        return createEmptyPixel(x, y);
      }

      return {
        ...targetPixel,
        x,
        y,
        alpha: 255,
      };
    }),
  );
}

function buildDualPassEraseMap(targetMap: PixelMap, coarseMap: PixelMap): PixelMap {
  return targetMap.map((row, y) =>
    row.map((targetPixel, x) => {
      const coarsePixel = readCoarsePixelAtCanvasPixel(coarseMap, x, y);
      const hasCoarse = Boolean(coarsePixel && coarsePixel.alpha > 0 && coarsePixel.colorIndex >= 0);

      if (!hasCoarse || (targetPixel.alpha > 0 && targetPixel.colorIndex >= 0)) {
        return createEmptyPixel(x, y);
      }

      return {
        x,
        y,
        colorIndex: 0,
        colorHex: "#000000",
        alpha: 255,
      };
    }),
  );
}

function buildDualPassCorrectedPreviewMap(targetMap: PixelMap): PixelMap {
  return targetMap.map((row, y) =>
    row.map((targetPixel, x) => {
      if (targetPixel.alpha <= 0 || targetPixel.colorIndex < 0) {
        return createEmptyPixel(x, y);
      }

      return {
        ...targetPixel,
        x,
        y,
        alpha: 255,
      };
    }),
  );
}

function scanlineBody(commands: DrawCommand[]): DrawCommand[] {
  return commands.filter((command) => (
    command.type !== "inputConfig" &&
    command.type !== "setBrush" &&
    command.type !== "end"
  ));
}

function countVisiblePixels(pixelMap: PixelMap): number {
  return pixelMap.flatMap((row) => row.filter((pixel) => pixel.alpha > 0 && pixel.colorIndex >= 0)).length;
}

function combinePathStats(left: DrawPlanPathStats, right: DrawPlanPathStats): DrawPlanPathStats {
  return {
    lineRunCount: left.lineRunCount + right.lineRunCount,
    maxMoveSteps: Math.max(left.maxMoveSteps, right.maxMoveSteps),
    longMoveOver50: left.longMoveOver50 + right.longMoveOver50,
    longMoveOver100: left.longMoveOver100 + right.longMoveOver100,
    longMoveOver200: left.longMoveOver200 + right.longMoveOver200,
  };
}

export async function generateDualPassDrawPlan(
  imageSource: ImageSource,
  profile: DrawingProfile,
  previewScale = 12,
  options?: {
    imageScalePercent?: number;
    imageOffsetXPercent?: number;
    imageOffsetYPercent?: number;
    removeBackground?: boolean;
    brightness?: number;
    contrast?: number;
    saturation?: number;
    ditherMode?: DitherMode;
    ditherAmount?: number;
    colorDistanceMode?: ColorDistanceMode;
    mergeSimilarColors?: boolean;
    mergeThreshold?: number;
  },
): Promise<DualPassDrawPlan> {
  const coarseProfile = cloneProfileWithBrush(profile, 3, "square");
  const fineProfile = cloneProfileWithBrush(profile, 1, "square");
  const pass1 = await generateDrawPlan(imageSource, coarseProfile, previewScale, options);
  const pass1DrawCommands = generateScanlineCommands(pass1.pixelMap, coarseProfile);
  const pass1Serialized = serializeCommandsWithState(pass1DrawCommands, createInitialBrushMenuState());
  pass1.commands = pass1Serialized.commands;
  pass1.estimatedRuntimeMs = estimateRuntimeMs(pass1DrawCommands, coarseProfile);
  pass1.pathStats = calculatePathStats(pass1DrawCommands);

  const { pixelMap: targetMap, usedColorIndexes, colorCounts } = await pixelizeImage(imageSource, fineProfile, options);
  const eraseMap = buildDualPassEraseMap(targetMap, pass1.pixelMap);
  const paintMap = buildDualPassCorrectionMap(targetMap, pass1.pixelMap);
  const correctedPreviewMap = buildDualPassCorrectedPreviewMap(targetMap);
  const eraseCommands = generateScanlineCommands(eraseMap, fineProfile);
  const paintCommands = generateScanlineCommands(paintMap, fineProfile);
  const pass2Commands: DrawCommand[] = [...paintCommands.slice(0, 1)];

  if (countVisiblePixels(eraseMap) > 0) {
    pass2Commands.push(
      setToolCommand("eraser"),
      setBrushCommand(1, "square"),
      ...scanlineBody(eraseCommands),
    );
  }

  if (countVisiblePixels(paintMap) > 0) {
    pass2Commands.push(
      setToolCommand("pen"),
      setBrushCommand(1, "square"),
      ...scanlineBody(paintCommands),
    );
  } else if (countVisiblePixels(eraseMap) > 0) {
    pass2Commands.push(setToolCommand("pen"));
  }

  pass2Commands.push(endCommand());
  const pass2PathStats = calculatePathStats(pass2Commands);
  const pass2Serialized = serializeCommandsWithState(pass2Commands, pass1Serialized.brushState);
  const pass2PreviewPng = await renderPreviewToBuffer(paintMap, fineProfile, previewScale);
  const correctedPreviewPng = await renderPreviewToBuffer(correctedPreviewMap, fineProfile, previewScale);
  const pass2: DrawPlan = {
    commands: pass2Serialized.commands,
    pixelMap: paintMap,
    usedColorIndexes,
    colorCounts,
    paletteHexes: pass1.paletteHexes,
    totalPixels: countVisiblePixels(eraseMap) + countVisiblePixels(paintMap),
    estimatedRuntimeMs: estimateRuntimeMs(pass2Commands, fineProfile),
    previewPng: pass2PreviewPng,
    imageBounds: calculateCanvasBounds(correctedPreviewMap, fineProfile),
    pathStats: pass2PathStats,
  };

  return {
    ...pass2,
    commands: [...pass1.commands, ...pass2.commands],
    pixelMap: correctedPreviewMap,
    usedColorIndexes,
    colorCounts,
    paletteHexes: pass1.paletteHexes,
    totalPixels: countVisiblePixels(targetMap),
    estimatedRuntimeMs: pass1.estimatedRuntimeMs + pass2.estimatedRuntimeMs,
    previewPng: correctedPreviewPng,
    imageBounds: calculateCanvasBounds(correctedPreviewMap, fineProfile),
    pathStats: combinePathStats(pass1.pathStats, pass2.pathStats),
    pass1,
    pass2,
    pass1PreviewPng: pass1.previewPng,
    correctedPreviewPng,
  };
}

export function calculateCanvasBounds(pixelMap: PixelMap, profile: DrawingProfile): CanvasBounds | null {
  const grid = createBrushGrid(profile);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;

  for (const row of pixelMap) {
    for (const pixel of row) {
      if (pixel.alpha <= 0 || pixel.colorIndex < 0) {
        continue;
      }

      if (!isGridCellInBounds(grid, pixel)) {
        continue;
      }

      const bounds = gridCellBounds(grid, pixel);

      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    maxX,
    maxY,
  };
}

export function calculatePathStats(commands: DrawCommand[]): DrawPlanPathStats {
  let lineRunCount = 0;
  let maxMoveSteps = 0;
  let longMoveOver50 = 0;
  let longMoveOver100 = 0;
  let longMoveOver200 = 0;

  for (const command of commands) {
    if (command.type === "line") {
      lineRunCount += 1;
      continue;
    }

    if (command.type !== "move") {
      continue;
    }

    const steps = Math.abs(command.dx) + Math.abs(command.dy);
    maxMoveSteps = Math.max(maxMoveSteps, steps);

    if (steps > 50) {
      longMoveOver50 += 1;
    }

    if (steps > 100) {
      longMoveOver100 += 1;
    }

    if (steps > 200) {
      longMoveOver200 += 1;
    }
  }

  return {
    lineRunCount,
    maxMoveSteps,
    longMoveOver50,
    longMoveOver100,
    longMoveOver200,
  };
}
