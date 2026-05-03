import path from "node:path";

import type { ColorMode, DrawingProfile, ResizeMode } from "../types.js";
import { DEFAULT_PALETTE } from "../config/defaultProfile.js";
import { OFFICIAL_PALETTE } from "../config/officialPalette.js";
import { normalizeHexColor } from "../utils/colors.js";

export interface CliOptions {
  image?: string;
  commandsFile?: string;
  profile?: string;
  port?: string;
  send: boolean;
  simulateDevice: boolean;
  listPorts: boolean;
  preview?: string;
  writeCommands?: string;
  size?: number;
  width?: number;
  height?: number;
  brushSize?: 1 | 3 | 7 | 13 | 19 | 27;
  colors?: number;
  threshold?: number;
  baud?: number;
  resizeMode?: ResizeMode;
  mode?: ColorMode;
  palette?: string[];
  simulateAckDelay?: number;
  simulateErrorAt?: number;
  previewScale: number;
  help: boolean;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

export function parseCliArgs(rawArgs: string[]): CliOptions {
  const options: CliOptions = {
    send: false,
    simulateDevice: false,
    listPorts: false,
    previewScale: 12,
    help: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    switch (arg) {
      case "--image":
        options.image = readValue(rawArgs, index, arg);
        index += 1;
        break;
      case "--commands-file":
        options.commandsFile = readValue(rawArgs, index, arg);
        index += 1;
        break;
      case "--profile":
        options.profile = readValue(rawArgs, index, arg);
        index += 1;
        break;
      case "--port":
        options.port = readValue(rawArgs, index, arg);
        index += 1;
        break;
      case "--preview":
        options.preview = readValue(rawArgs, index, arg);
        index += 1;
        break;
      case "--write-commands":
        options.writeCommands = readValue(rawArgs, index, arg);
        index += 1;
        break;
      case "--size":
        options.size = Number.parseInt(readValue(rawArgs, index, arg), 10);
        index += 1;
        break;
      case "--width":
        options.width = Number.parseInt(readValue(rawArgs, index, arg), 10);
        index += 1;
        break;
      case "--height":
        options.height = Number.parseInt(readValue(rawArgs, index, arg), 10);
        index += 1;
        break;
      case "--brush-size":
        {
          const value = Number.parseInt(readValue(rawArgs, index, arg), 10);
          if (value !== 1 && value !== 3 && value !== 7 && value !== 13 && value !== 19 && value !== 27) {
            throw new Error("--brush-size must be one of 1, 3, 7, 13, 19, 27");
          }
          options.brushSize = value;
        }
        index += 1;
        break;
      case "--colors":
        options.colors = Number.parseInt(readValue(rawArgs, index, arg), 10);
        index += 1;
        break;
      case "--threshold":
        options.threshold = Number.parseInt(readValue(rawArgs, index, arg), 10);
        index += 1;
        break;
      case "--baud":
        options.baud = Number.parseInt(readValue(rawArgs, index, arg), 10);
        index += 1;
        break;
      case "--resize":
        options.resizeMode = readValue(rawArgs, index, arg) === "cover" ? "cover" : "contain";
        index += 1;
        break;
      case "--mode":
        {
          const value = readValue(rawArgs, index, arg);
          options.mode = value === "palette" || value === "official" ? value : "mono";
        }
        index += 1;
        break;
      case "--palette":
        options.palette = readValue(rawArgs, index, arg)
          .split(",")
          .map((value) => normalizeHexColor(value));
        index += 1;
        break;
      case "--preview-scale":
        options.previewScale = Number.parseInt(readValue(rawArgs, index, arg), 10);
        index += 1;
        break;
      case "--send":
        options.send = true;
        break;
      case "--simulate-device":
        options.simulateDevice = true;
        break;
      case "--simulate-ack-delay":
        options.simulateAckDelay = Number.parseInt(readValue(rawArgs, index, arg), 10);
        index += 1;
        break;
      case "--simulate-error-at":
        options.simulateErrorAt = Number.parseInt(readValue(rawArgs, index, arg), 10);
        index += 1;
        break;
      case "--list-ports":
        options.listPorts = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function applyCliOptions(profile: DrawingProfile, options: CliOptions): DrawingProfile {
  const width = options.size ?? options.width ?? profile.canvasWidth;
  const height = options.size ?? options.height ?? profile.canvasHeight;
  const colorMode =
    options.mode ??
    (options.colors && options.colors > 2
      ? "palette"
      : profile.colorMode === "official"
        ? "official"
        : profile.colorMode);

  if (colorMode === "official") {
    const colorCount = Math.max(
      2,
      Math.min(options.colors ?? profile.colorCount ?? 32, OFFICIAL_PALETTE.length),
    );
    return {
      ...profile,
      baudRate: options.baud ?? profile.baudRate,
      canvasWidth: width,
      canvasHeight: height,
      brushSize: options.brushSize ?? profile.brushSize,
      resizeMode: options.resizeMode ?? profile.resizeMode,
      colorMode,
      colorCount,
      monoThreshold: options.threshold ?? profile.monoThreshold,
      palette: OFFICIAL_PALETTE.slice(),
    };
  }

  const requestedColors =
    colorMode === "mono"
      ? 2
      : Math.max(2, Math.min(options.colors ?? profile.palette.length, DEFAULT_PALETTE.length));
  const inputPalette = options.palette && options.palette.length > 0 ? options.palette : profile.palette;
  const palette = [...new Set([...inputPalette, ...DEFAULT_PALETTE])].slice(0, requestedColors);

  return {
    ...profile,
    baudRate: options.baud ?? profile.baudRate,
    canvasWidth: width,
    canvasHeight: height,
    brushSize: options.brushSize ?? profile.brushSize,
    resizeMode: options.resizeMode ?? profile.resizeMode,
    colorMode,
    colorCount: requestedColors,
    monoThreshold: options.threshold ?? profile.monoThreshold,
    palette,
  };
}

export function printHelp(): string {
  const exampleImage = path.join(".", "examples", "demo.svg");

  return [
    "Switch Auto Draw CLI",
    "",
    "Usage:",
    "  npm run dev -- --image ./examples/demo.svg --preview ./tmp/demo-preview.png --write-commands ./tmp/demo-commands.txt",
    "  npm run dev -- --commands-file ./examples/smoke-test-commands.txt --port /dev/cu.usbserialXXX --send",
    "  npm run dev -- --commands-file ./examples/smoke-test-commands.txt --send --simulate-device",
    "  npm run dev -- --image ./examples/demo.svg --port /dev/cu.usbmodemXXX --send",
    "",
    "Options:",
    "  --image <path>           Input image path",
    "  --commands-file <path>   Send or inspect an existing command file instead of generating from an image",
    "  --profile <path>         JSON drawing profile",
    "  --port <path>            Serial port for ESP32",
    "  --send                   Stream commands to ESP32 with ACK flow control",
    "  --simulate-device        Run commands against an in-process simulated device instead of a serial port",
    "  --simulate-ack-delay <n> Simulated ACK delay in ms (default: 15)",
    "  --simulate-error-at <n>  Inject one simulated ERR on the nth command to exercise retries",
    "  --list-ports             Print available serial ports and exit",
    "  --preview <path>         Write a PNG preview",
    "  --preview-scale <n>      Preview pixel scale (default: 12)",
    "  --write-commands <path>  Write serialized commands to a text file",
    "  --size <n>               Square canvas size override",
    "  --width <n>              Canvas width override",
    "  --height <n>             Canvas height override",
    "  --brush-size <n>         Brush size override (1, 3, 7, 13, 19, 27)",
    "  --mode mono|palette|official Quantization mode",
    "  --colors <n>             Palette size when using palette mode",
    "  --threshold <n>          Mono threshold (0-255)",
    '  --palette <csv>          Palette override, e.g. "#000000,#ffffff,#ff0000,#0000ff"',
    "  --resize contain|cover   Resize strategy",
    "  --baud <n>               Serial baud rate override",
    "  --help                   Show help",
    "",
    `Bundled demo asset: ${exampleImage}`,
  ].join("\n");
}
