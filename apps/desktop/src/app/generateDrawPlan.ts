import type { ImageSource } from "../image/loadImage.js";
import { createBrushGrid, gridCellBounds, isGridCellInBounds } from "../brushGrid.js";
import { pixelizeImage } from "../image/pixelize.js";
import { renderPreviewToBuffer } from "../image/renderPreview.js";
import { estimateRuntimeMs, generateScanlineCommands, type PathStrategy } from "../path/scanline.js";
import { serializeCommands } from "../protocol/serializer.js";
import type { DrawCommand } from "../protocol/commands.js";
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

function cloneProfileWithBrushSize(profile: DrawingProfile, brushSize: DrawingProfile["brushSize"]): DrawingProfile {
  return {
    ...profile,
    brushSize,
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
    pathStrategy?: PathStrategy;
  },
): Promise<DrawPlan> {
  const { pixelMap, usedColorIndexes, colorCounts } = await pixelizeImage(imageSource, profile, options);
  const previewPng = await renderPreviewToBuffer(pixelMap, profile, previewScale);
  const drawCommands = generateScanlineCommands(pixelMap, profile, options?.pathStrategy);
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

function buildDualPassCorrectedPreviewMap(targetMap: PixelMap, coarseMap: PixelMap): PixelMap {
  return targetMap.map((row, y) =>
    row.map((targetPixel, x) => {
      const coarsePixel = readCoarsePixelAtCanvasPixel(coarseMap, x, y);
      const hasTarget = targetPixel.alpha > 0 && targetPixel.colorIndex >= 0;
      const hasCoarse = Boolean(coarsePixel && coarsePixel.alpha > 0 && coarsePixel.colorIndex >= 0);
      const selected = hasTarget ? targetPixel : hasCoarse ? coarsePixel : null;

      if (!selected) {
        return createEmptyPixel(x, y);
      }

      return {
        x,
        y,
        colorIndex: selected.colorIndex,
        colorHex: selected.colorHex,
        alpha: 255,
      };
    }),
  );
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
    pathStrategy?: PathStrategy;
  },
): Promise<DualPassDrawPlan> {
  const coarseProfile = cloneProfileWithBrushSize(profile, 3);
  const fineProfile = cloneProfileWithBrushSize(profile, 1);
  const pass1 = await generateDrawPlan(imageSource, coarseProfile, previewScale, options);
  const { pixelMap: targetMap, usedColorIndexes, colorCounts } = await pixelizeImage(imageSource, fineProfile, options);
  const correctionMap = buildDualPassCorrectionMap(targetMap, pass1.pixelMap);
  const correctedPreviewMap = buildDualPassCorrectedPreviewMap(targetMap, pass1.pixelMap);
  const pass2Commands = generateScanlineCommands(correctionMap, fineProfile);
  const pass2PathStats = calculatePathStats(pass2Commands);
  const pass2PreviewPng = await renderPreviewToBuffer(correctionMap, fineProfile, previewScale);
  const correctedPreviewPng = await renderPreviewToBuffer(correctedPreviewMap, fineProfile, previewScale);
  const pass2: DrawPlan = {
    commands: serializeCommands(pass2Commands),
    pixelMap: correctionMap,
    usedColorIndexes,
    colorCounts,
    paletteHexes: pass1.paletteHexes,
    totalPixels: correctionMap.flatMap((row) => row.filter((pixel) => pixel.alpha > 0)).length,
    estimatedRuntimeMs: estimateRuntimeMs(pass2Commands, fineProfile),
    previewPng: pass2PreviewPng,
    imageBounds: calculateCanvasBounds(correctionMap, fineProfile),
    pathStats: pass2PathStats,
  };

  return {
    ...pass2,
    commands: [...pass1.commands, ...pass2.commands],
    pixelMap: correctedPreviewMap,
    usedColorIndexes,
    colorCounts,
    paletteHexes: pass1.paletteHexes,
    totalPixels: targetMap.flatMap((row) => row.filter((pixel) => pixel.alpha > 0)).length,
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
