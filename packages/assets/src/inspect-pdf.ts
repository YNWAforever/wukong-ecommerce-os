import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { PDFDocument } from "pdf-lib";
// An isolated Node worker needs a filesystem path, never a bundler module ID.
// Indirect invocation preserves native resolution when Turbopack transforms direct require.resolve calls.
function resolveParserPath(): string {
  for (const base of [
    import.meta.url,
    path.join(process.cwd(), "package.json"),
    path.join(process.cwd(), "apps/web/package.json"),
  ]) {
    try {
      const nativeRequire = Reflect.apply(createRequire, undefined, [
        base,
      ]) as NodeJS.Require;
      const resolved = nativeRequire.resolve("pdf-lib");
      if (typeof resolved === "string" && path.isAbsolute(resolved))
        return resolved;
    } catch {
      /* Try the application root used by packaged Next functions. */
    }
  }
  throw new Error("PDF parser unavailable");
}
export const MAX_SOURCE_PDF_PAGES = 40;
/** Parse untrusted structures in a killable Node worker with a bounded JavaScript heap. Never rasterize here. */
export async function inspectPdf(
  bytes: Uint8Array,
): Promise<{ pageCount: number }> {
  if (typeof PDFDocument.load !== "function")
    throw new Error("PDF parser unavailable");
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads');
      const {PDFDocument}=require(workerData.parserPath);
      (async()=>{try{
        const doc=await PDFDocument.load(workerData.bytes,{ignoreEncryption:false,throwOnInvalidObject:true,updateMetadata:false,parseSpeed:100});
        const count=doc.getPageCount();
        if(count<1||count>workerData.maxPages)throw new Error('page_limit');
        for(const page of doc.getPages()){const size=page.getSize();if(!Number.isFinite(size.width)||!Number.isFinite(size.height)||size.width<=0||size.height<=0||size.width>14400||size.height>14400)throw new Error('page_size');}
        parentPort.postMessage({pageCount:count});
      }catch{parentPort.postMessage({invalid:true});}})();`,
      {
        eval: true,
        workerData: {
          parserPath: resolveParserPath(),
          bytes,
          maxPages: MAX_SOURCE_PDF_PAGES,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      },
    );
    let settled = false;
    const finish = (result?: { pageCount: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      result ? resolve(result) : reject(new Error("invalid_pdf"));
    };
    const timer = setTimeout(() => finish(), 5000);
    worker.once("message", (message) =>
      finish(
        Number.isInteger(message?.pageCount)
          ? { pageCount: message.pageCount }
          : undefined,
      ),
    );
    worker.once("error", () => finish());
    worker.once("exit", () => finish());
  });
}
