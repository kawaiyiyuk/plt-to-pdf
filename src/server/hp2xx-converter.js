import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { measureDrawing, parseHpgl } from "../core/plt-core.js";
import { decodePltBuffer } from "../core/text-decoding.js";
import { buildPdfFromSvg, getSvgPdfLayout } from "./svg-to-pdf.js";
import { ConversionTimeoutError } from "./http-errors.js";

const DEFAULT_HP2XX_PATH = resolve("tools/hp2xx");
const DEFAULT_UNITS_PER_INCH = 1016;

export async function convertPltBufferWithHp2xx(buffer, options = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "plt-to-pdf-"));
  const inputPath = join(tempDir, "input.plt");
  const svgPath = join(tempDir, "output.svg");

  try {
    const extracted = extractHpglText(buffer, options);
    await writeFile(inputPath, extracted.buffer);
    const source = buffer.toString("latin1");
    const strippedSource = extracted.buffer.toString("latin1");
    const size = measurePltSizeMm(source, options);
    await runHp2xx(inputPath, svgPath, size, options);
    const strippedMetrics = measureDrawing(parseHpgl(strippedSource), Number(options.unitsPerInch ?? DEFAULT_UNITS_PER_INCH));
    const rawSvg = await readSvgOrCreateBlank(svgPath, strippedMetrics, options);
    const svg = applyLineWidthOverride(rawSvg, options);
    const textOptions = {
      ...options,
      hpglMetrics: strippedMetrics,
      textLabels: extracted.labels
    };
    const layout = getSvgPdfLayout(svg, textOptions);
    const pdf = buildPdfFromSvg(svg, textOptions);
    return { pdf, svg, layout };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readSvgOrCreateBlank(svgPath, metrics, options = {}) {
  try {
    return await readFile(svgPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    const unitsPerInch = Number(options.unitsPerInch ?? DEFAULT_UNITS_PER_INCH);
    const widthPt = Math.max(1, (metrics.width / unitsPerInch) * 72);
    const heightPt = Math.max(1, (metrics.height / unitsPerInch) * 72);
    return `<svg width="100%" height="100%" viewBox="0 0 ${widthPt.toFixed(3)} ${heightPt.toFixed(3)}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  }
}

function applyLineWidthOverride(svg, options = {}) {
  const lineWidthMm = Number(options.lineWidthMm);
  if (!Number.isFinite(lineWidthMm) || lineWidthMm <= 0) {
    return svg;
  }
  const strokeWidth = `stroke-width:${lineWidthMm.toFixed(3)}mm`;
  if (svg.includes("stroke-width:")) {
    return svg.replace(/stroke-width\s*:\s*[^;"]+/g, strokeWidth);
  }
  return svg.replace(/(<g\b[^>]*style=")([^"]*)(")/g, (_match, start, style, end) => {
    const separator = style.trim().endsWith(";") || style.trim() === "" ? "" : "; ";
    return `${start}${style}${separator} ${strokeWidth};${end}`;
  });
}

function measurePltSizeMm(source, options = {}) {
  const unitsPerInch = Number(options.unitsPerInch ?? 1016);
  const drawing = parseHpgl(source);
  const metrics = measureDrawing(drawing, unitsPerInch);
  return {
    widthMm: Math.max(1, (metrics.width / unitsPerInch) * 25.4),
    heightMm: Math.max(1, (metrics.height / unitsPerInch) * 25.4)
  };
}

function extractHpglText(buffer, options = {}) {
  const unitsPerInch = Number(options.unitsPerInch ?? DEFAULT_UNITS_PER_INCH);
  const unitsPerMm = unitsPerInch / 25.4;
  const bytes = new Uint8Array(buffer);
  const output = [];
  const labels = [];
  let index = 0;
  let mode = "absolute";
  let currentPosition = { x: 0, y: 0 };
  let charSizeUnits = {
    width: 0.285 * 10 * unitsPerMm,
    height: 0.375 * 10 * unitsPerMm
  };
  let direction = { x: 1, y: 0 };

  while (index < bytes.length) {
    const commandStart = index;
    const command = readCommand(bytes, index);
    if (!command) {
      output.push(bytes[index]);
      index += 1;
      continue;
    }
    index += 2;

    if (command === "LB") {
      const textStart = index;
      while (index < bytes.length && bytes[index] !== 0x03 && bytes[index] !== 0x3b) {
        index += 1;
      }
      const textBytes = bytes.slice(textStart, index);
      const text = decodeTextBytes(textBytes).trimEnd();
      if (text) {
        labels.push({
          text,
          x: currentPosition.x,
          y: currentPosition.y,
          widthUnits: charSizeUnits.width,
          heightUnits: charSizeUnits.height,
          direction: { ...direction }
        });
      }
      if (index < bytes.length) {
        index += 1;
      }
      continue;
    }

    while (index < bytes.length && bytes[index] !== 0x3b) {
      index += 1;
    }
    const argText = Buffer.from(bytes.slice(commandStart + 2, index)).toString("latin1");
    if (index < bytes.length) {
      index += 1;
    }

    output.push(...bytes.slice(commandStart, index));
    const nums = parseNumberList(argText);
    switch (command) {
      case "IN":
        mode = "absolute";
        currentPosition = { x: 0, y: 0 };
        charSizeUnits = {
          width: 0.285 * 10 * unitsPerMm,
          height: 0.375 * 10 * unitsPerMm
        };
        direction = { x: 1, y: 0 };
        break;
      case "PA":
        mode = "absolute";
        updatePosition(nums, mode);
        break;
      case "PR":
        mode = "relative";
        updatePosition(nums, mode);
        break;
      case "PU":
      case "PD":
        updatePosition(nums, mode);
        break;
      case "SI":
        if (Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
          charSizeUnits = {
            width: nums[0] * 10 * unitsPerMm,
            height: nums[1] * 10 * unitsPerMm
          };
        }
        break;
      case "DI":
        if (Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
          direction = { x: nums[0], y: nums[1] };
        }
        break;
      default:
        break;
    }
  }

  return {
    buffer: Buffer.from(output),
    labels
  };

  function updatePosition(nums, currentMode) {
    if (nums.length < 2) return;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      currentPosition = currentMode === "relative"
        ? { x: currentPosition.x + nums[i], y: currentPosition.y + nums[i + 1] }
        : { x: nums[i], y: nums[i + 1] };
    }
  }
}

function readCommand(bytes, index) {
  if (index + 1 >= bytes.length) return null;
  const first = upperAscii(bytes[index]);
  const second = upperAscii(bytes[index + 1]);
  if (!isAsciiLetter(first) || !isAsciiLetter(second)) return null;
  return String.fromCharCode(first, second);
}

function upperAscii(value) {
  return value >= 0x61 && value <= 0x7a ? value - 0x20 : value;
}

function isAsciiLetter(value) {
  return value >= 0x41 && value <= 0x5a;
}

function decodeTextBytes(bytes) {
  return decodePltBuffer(bytes);
}

function parseNumberList(text) {
  if (!text.trim()) return [];
  return text
    .split(/[, \t\r\n]+/)
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function runHp2xx(inputPath, outputPath, size, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const timeoutMs = Number(options.timeoutMs);
    const hp2xxPath = resolveHp2xxPath(options);
    let settled = false;
    const child = spawn(hp2xxPath, [
      "-q",
      "-m",
      "svg",
      "-w",
      size.widthMm.toFixed(3),
      "-h",
      size.heightMm.toFixed(3),
      "-f",
      outputPath,
      inputPath
    ], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout = [];
    const stderr = [];
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new ConversionTimeoutError());
      }, timeoutMs)
      : null;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      callback();
    };

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        const output = Buffer.concat([...stdout, ...stderr]).toString("utf8").trim();
        reject(new Error(output || `hp2xx exited with code ${code}`));
      });
    });
  });
}

function resolveHp2xxPath(options = {}) {
  return String(options.hp2xxPath || process.env.HP2XX_PATH || DEFAULT_HP2XX_PATH);
}
