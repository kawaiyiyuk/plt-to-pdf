#!/usr/bin/env node
import { convertPltFile } from "./plt-to-pdf.js";

const [, , inputPath, outputPath, ...rest] = process.argv;

if (!inputPath || !outputPath) {
  console.error("Usage: plt-to-pdf <input.plt> <output.pdf> [--units-per-inch 1016] [--margin 36] [--paper-size A4|A3|A2|A1|A0] [--orientation auto|portrait|landscape]");
  process.exit(1);
}

const options = parseArgs(rest);

convertPltFile(inputPath, outputPath, options).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--units-per-inch") {
      options.unitsPerInch = Number(args[++i]);
    } else if (arg === "--margin") {
      options.marginPt = Number(args[++i]);
    } else if (arg === "--line-width") {
      options.lineWidthPt = Number(args[++i]);
    } else if (arg === "--font-size") {
      options.fontSizePt = Number(args[++i]);
    } else if (arg === "--paper-size") {
      options.paperSize = args[++i];
    } else if (arg === "--orientation") {
      options.orientation = args[++i];
    }
  }
  return options;
}
