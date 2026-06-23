import { readFile, writeFile } from "node:fs/promises";
import { convertDrawingToPdf, convertPltToPdf, getTiledPdfLayout, parseHpgl, measureDrawing } from "./core/plt-core.js";

export async function convertPltFile(inputPath, outputPath, options = {}) {
  const source = await readFile(inputPath, "utf8");
  const pdf = convertPltToPdf(source, options);
  await writeFile(outputPath, pdf);
}

export { convertPltToPdf, getTiledPdfLayout, parseHpgl, measureDrawing };
export { convertDrawingToPdf };
