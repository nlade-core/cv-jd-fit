// pdf.js (vendored in vendor/pdfjs) -- loaded on first use. Text is read first
// so matching can start; pages are rendered separately, only when shown.

let pdfjsPromise = null;
export function loadPdfjs() {
  pdfjsPromise ??= import('./vendor/pdfjs/pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    return lib;
  });
  return pdfjsPromise;
}

async function open(file) {
  const lib = await loadPdfjs();
  // pdf.js transfers the buffer to its worker, so every open gets a fresh copy.
  return lib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
    isEvalSupported: false
  });
}

// -> [{ width, height, items }]
export async function readPdfText(file) {
  const task = await open(file);
  try {
    const doc = await task.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      pages.push({ width: vp.width, height: vp.height, items: (await page.getTextContent()).items });
    }
    return pages;
  } finally {
    task.destroy();
  }
}

// -> [{ width, height, canvas }]
export async function renderPdf(file) {
  const task = await open(file);
  try {
    const doc = await task.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const view = page.getViewport({ scale: 2 }); // 2 canvas px per PDF point: sharp at panel widths
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(view.width);
      canvas.height = Math.floor(view.height);
      await page.render({ canvas, viewport: view }).promise;
      pages.push({ width: vp.width, height: vp.height, canvas });
    }
    return pages;
  } finally {
    task.destroy();
  }
}
