import { readFile, writeFile } from "node:fs/promises";
import { convertDrawingToPdf, convertPltToPdf, getTiledPdfLayout, parseHpgl, measureDrawing } from "./core/plt-core.js";
import { decodePltBuffer } from "./core/text-decoding.js";

export async function convertPltFile(inputPath, outputPath, options = {}) {
  const source = decodePltBuffer(await readFile(inputPath));
  const pdf = convertPltToPdf(source, options);
  await writeFile(outputPath, pdf);
}

export { convertPltToPdf, getTiledPdfLayout, parseHpgl, measureDrawing };
export { convertDrawingToPdf };
