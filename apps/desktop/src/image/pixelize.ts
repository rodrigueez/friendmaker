import type { ColorDistanceMode, DitherMode, DrawingProfile, PixelizationResult, RawImageData } from "../types.js";
import { createBrushGrid } from "../brushGrid.js";
import type { ImageSource } from "./loadImage.js";
import { autoRemoveBackground } from "./removeBackground.js";
import { resizeImage } from "./resizeImage.js";
import { quantizePixels } from "./quantize.js";

function collapsePixelMapForBrush(
  pixelMap: PixelizationResult["pixelMap"],
  profile: DrawingProfile,
): PixelizationResult["pixelMap"] {
  const grid = createBrushGrid(profile);
  const collapsed: PixelizationResult["pixelMap"] = [];

  for (let logicalY = 0; logicalY < grid.gridHeight; logicalY += 1) {
    const row = [];
    const originY = grid.originY + logicalY * grid.brushSize;

    for (let logicalX = 0; logicalX < grid.gridWidth; logicalX += 1) {
      const originX = grid.originX + logicalX * grid.brushSize;
      const colorCounts = new Map<
        number,
        {
          count: number;
          colorHex: string;
        }
      >();

      let fallbackPixel:
        | {
            colorIndex: number;
            colorHex: string;
          }
        | null = null;

      for (let dy = 0; dy < grid.brushSize; dy += 1) {
        const y = originY + dy;

        if (y >= pixelMap.length) {
          break;
        }

        const sourceRow = pixelMap[y];

        if (!sourceRow) {
          continue;
        }

        for (let dx = 0; dx < grid.brushSize; dx += 1) {
          const x = originX + dx;

          if (x >= sourceRow.length) {
            break;
          }

          const pixel = sourceRow[x];

          if (!pixel || pixel.alpha <= 0 || pixel.colorIndex < 0) {
            continue;
          }

          if (!fallbackPixel) {
            fallbackPixel = {
              colorIndex: pixel.colorIndex,
              colorHex: pixel.colorHex,
            };
          }

          const existing = colorCounts.get(pixel.colorIndex);

          if (existing) {
            existing.count += 1;
          } else {
            colorCounts.set(pixel.colorIndex, {
              count: 1,
              colorHex: pixel.colorHex,
            });
          }
        }
      }

      if (colorCounts.size === 0) {
        row.push({
          x: logicalX,
          y: logicalY,
          colorIndex: -1,
          colorHex: "#ffffff",
          alpha: 0,
        });
        continue;
      }

      let selectedColorIndex = fallbackPixel?.colorIndex ?? 0;
      let selectedColorHex = fallbackPixel?.colorHex ?? "#000000";
      let selectedCount = -1;

      for (const [colorIndex, info] of colorCounts.entries()) {
        if (info.count > selectedCount) {
          selectedColorIndex = colorIndex;
          selectedColorHex = info.colorHex;
          selectedCount = info.count;
        }
      }

      row.push({
        x: logicalX,
        y: logicalY,
        colorIndex: selectedColorIndex,
        colorHex: selectedColorHex,
        alpha: 255,
      });
    }

    collapsed.push(row);
  }

  return collapsed;
}

export async function pixelizeImage(
  imageSource: ImageSource,
  profile: DrawingProfile,
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
  },
): Promise<PixelizationResult> {
  const resizeOptions = {
    width: profile.canvasWidth,
    height: profile.canvasHeight,
    resizeMode: profile.resizeMode,
    ...(options?.imageScalePercent !== undefined
      ? { scalePercent: options.imageScalePercent }
      : {}),
    ...(options?.imageOffsetXPercent !== undefined
      ? { offsetXPercent: options.imageOffsetXPercent }
      : {}),
    ...(options?.imageOffsetYPercent !== undefined
      ? { offsetYPercent: options.imageOffsetYPercent }
      : {}),
  };
  const resizedImage = await resizeImage(imageSource, resizeOptions);
  const rawImage = applyImageAdjustments(
    options?.removeBackground ? autoRemoveBackground(resizedImage) : resizedImage,
    {
      brightness: options?.brightness ?? 0,
      contrast: options?.contrast ?? 0,
      saturation: options?.saturation ?? 0,
    },
  );

  const fullPixelMap = quantizePixels(rawImage, {
    colorMode: profile.colorMode,
    colorCount: profile.colorCount,
    monoThreshold: profile.monoThreshold,
    palette: profile.palette,
    ditherMode: options?.ditherMode ?? "none",
    ditherAmount: options?.ditherAmount ?? 1,
    distanceMode: options?.colorDistanceMode ?? "weighted",
  });
  const pixelMap = collapsePixelMapForBrush(fullPixelMap, profile);

  const usedColorIndexes = Array.from(
    new Set(
      pixelMap.flatMap((row) =>
        row.filter((pixel) => pixel.alpha > 0).map((pixel) => pixel.colorIndex),
      ),
    ),
  ).sort((a, b) => a - b);

  return {
    pixelMap,
    usedColorIndexes,
  };
}

function applyImageAdjustments(
  image: RawImageData,
  options: {
    brightness: number;
    contrast: number;
    saturation: number;
  },
): RawImageData {
  if (options.brightness === 0 && options.contrast === 0 && options.saturation === 0) {
    return image;
  }

  const data = Buffer.from(image.data);
  const contrast = (options.contrast + 100) / 100;
  const saturation = (options.saturation + 100) / 100;

  for (let offset = 0; offset < data.length; offset += image.channels) {
    let r = data[offset] ?? 0;
    let g = data[offset + 1] ?? 0;
    let b = data[offset + 2] ?? 0;

    r += options.brightness;
    g += options.brightness;
    b += options.brightness;
    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;

    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    r = luminance + (r - luminance) * saturation;
    g = luminance + (g - luminance) * saturation;
    b = luminance + (b - luminance) * saturation;

    data[offset] = Math.max(0, Math.min(255, Math.round(r)));
    data[offset + 1] = Math.max(0, Math.min(255, Math.round(g)));
    data[offset + 2] = Math.max(0, Math.min(255, Math.round(b)));
  }

  return {
    ...image,
    data,
  };
}
