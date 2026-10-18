const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8149;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

async function runTests() {
  await new Promise(resolve => server.listen(PORT, resolve));
  console.log(`Server listening on http://localhost:${PORT}`);

  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const debugPort = 9358;
  const userDataDir = `/tmp/chrome-test-dd-pdf-${Date.now()}`;

  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--window-size=1440,900',
    `http://localhost:${PORT}/pdfgod.html`
  ]);

  await new Promise(r => setTimeout(r, 2500));

  try {
    const targetsRes = await fetch(`http://localhost:${debugPort}/json`);
    const targets = await targetsRes.json();
    const pageTarget = targets.find(t => t.type === 'page');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = msgId++;
      const listener = (event) => {
        const data = JSON.parse(event.data);
        if (data.id === id) {
          ws.removeEventListener('message', listener);
          resolve(data.result);
        }
      };
      ws.addEventListener('message', listener);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Runtime.enable');

    const evalRes = await send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const { PDFDocument, StandardFonts, rgb } = window.PDFLib;

        // Helper to create a labeled PDF File object with specified page labels
        async function createLabeledPdfFile(filename, pageLabels, bgRgb = [1, 1, 1]) {
          const doc = await PDFDocument.create();
          const font = await doc.embedFont(StandardFonts.HelveticaBold);
          for (const label of pageLabels) {
            const page = doc.addPage([500, 400]);
            page.drawRectangle({ x: 0, y: 0, width: 500, height: 400, color: rgb(bgRgb[0], bgRgb[1], bgRgb[2]) });
            page.drawText(label, { x: 50, y: 200, size: 28, font, color: rgb(0.1, 0.1, 0.1) });
          }
          const bytes = await doc.save();
          return new File([bytes], filename, { type: 'application/pdf' });
        }

        // Helper to read the first text item on each display page in the current document
        async function getDocumentPageLabels() {
          const count = window.pdfEngine.getPageCount();
          const labels = [];
          for (let i = 0; i < count; i++) {
            const items = await window.pdfEngine.getTextItems(i);
            const txt = items.map(it => it.str).join(' ').trim();
            labels.push(txt);
          }
          return labels;
        }

        // Helper to create a DataTransfer with File objects
        function makeFileDataTransfer(files) {
          const dt = new DataTransfer();
          for (const f of files) {
            dt.items.add(f);
          }
          return dt;
        }

        // 1. Load initial 2-page PDF: ["BASE_P1", "BASE_P2"]
        const baseFile = await createLabeledPdfFile('base.pdf', ['BASE_P1', 'BASE_P2']);
        await window.uiController.loadFile(baseFile);
        await sleep(300);

        const initialLabels = await getDocumentPageLabels();

        // 2. Test hover state on/around "Add Page from PDF" button
        const addPdfBtn = document.querySelector('[data-action="add-pdf-page"]');
        const addWrapper = document.querySelector('.add-page-wrapper');
        const normalBtnText = addPdfBtn.querySelector('span').textContent;
        const normalBorderColor = getComputedStyle(addPdfBtn).borderColor;

        const pdfExtraBottom = await createLabeledPdfFile('extra-bottom.pdf', ['EXTRA_BOTTOM']);
        const dtHover = makeFileDataTransfer([pdfExtraBottom]);

        addWrapper.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dtHover
        }));

        const hoverHasClass = addPdfBtn.classList.contains('drag-over') && addWrapper.classList.contains('drag-over');
        const hoverBtnText = addPdfBtn.querySelector('span').textContent;
        const hoverBorderColor = getComputedStyle(addPdfBtn).borderColor;

        // Dispatch dragleave outside wrapper
        addWrapper.dispatchEvent(new DragEvent('dragleave', {
          bubbles: true,
          cancelable: true,
          relatedTarget: document.body,
          dataTransfer: dtHover
        }));

        const afterLeaveHasClass = addPdfBtn.classList.contains('drag-over') || addWrapper.classList.contains('drag-over');
        const afterLeaveBtnText = addPdfBtn.querySelector('span').textContent;

        // 3. Test dropping ONLY non-PDF files on the "Add Page from PDF" button -> should do nothing
        const nonPdf1 = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
        const nonPdf2 = new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
        const dtNonPdf = makeFileDataTransfer([nonPdf1, nonPdf2]);

        addPdfBtn.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dtNonPdf
        }));
        await sleep(300);
        const labelsAfterNonPdfDrop = await getDocumentPageLabels();

        // 4. Test dropping MIXED files (non-PDF + 2 PDF files) around "Add Page from PDF" button (.add-page-wrapper)
        // Should ignore non-PDFs and append only the PDFs at the bottom
        const mixedPdf1 = await createLabeledPdfFile('mixed1.pdf', ['MIXED_PDF_1']);
        const mixedPdf2 = await createLabeledPdfFile('mixed2.pdf', ['MIXED_PDF_2']);
        const dtMixed = makeFileDataTransfer([nonPdf1, mixedPdf1, nonPdf2, mixedPdf2]);

        addWrapper.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dtMixed
        }));
        await sleep(500);
        const labelsAfterMixedDrop = await getDocumentPageLabels();

        // 5. Add an annotation on page index 1 ("BASE_P2") to verify annotation pageIndex shifting when inserting between pages
        window.annotationManager.addAnnotation({
          type: 'text',
          pageIndex: 1,
          x: 100,
          y: 100,
          text: 'Note on BASE_P2',
          fontSize: 16,
          color: '#000000'
        });

        // 6. Test dropping a PDF file BETWEEN Page 1 and Page 2 in the sidebar thumbnail list
        const betweenThumbPdf = await createLabeledPdfFile('between-thumb.pdf', ['INSERTED_BETWEEN_1_AND_2']);
        const dtBetweenThumb = makeFileDataTransfer([betweenThumbPdf]);
        const thumbCards = document.querySelectorAll('.thumbnail-card');
        const card0Rect = thumbCards[0].getBoundingClientRect();
        const card1Rect = thumbCards[1].getBoundingClientRect();
        // Coordinate in the gap between card 0 and card 1 (or bottom half of card 0)
        const gapY = (card0Rect.bottom + card1Rect.top) / 2;

        // First test dragover on thumbnailList in the gap
        const thumbList = document.querySelector('.thumbnail-list');
        thumbList.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientY: gapY,
          dataTransfer: dtBetweenThumb
        }));
        const gapIndicatorShown = thumbCards[0].classList.contains('drag-over-bottom') || thumbCards[1].classList.contains('drag-over-top');

        // Drop in the gap between card 0 and card 1
        thumbList.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientY: gapY,
          dataTransfer: dtBetweenThumb
        }));
        await sleep(500);
        const labelsAfterThumbBetweenDrop = await getDocumentPageLabels();
        const annPageIndexAfterInsert = window.annotationManager.annotations[0].pageIndex;

        // 7. Test dropping a PDF file BEFORE Page 1 (top half of card 0)
        const beforeFirstPdf = await createLabeledPdfFile('before-first.pdf', ['INSERTED_AT_VERY_TOP']);
        const dtBeforeFirst = makeFileDataTransfer([beforeFirstPdf]);
        const newThumbCards = document.querySelectorAll('.thumbnail-card');
        const newCard0Rect = newThumbCards[0].getBoundingClientRect();
        const topHalfY = newCard0Rect.top + 10;

        newThumbCards[0].dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientY: topHalfY,
          dataTransfer: dtBeforeFirst
        }));
        await sleep(500);
        const labelsAfterTopDrop = await getDocumentPageLabels();

        // 8. Test dropping a PDF file between pages in the main viewport (.document-container)
        const viewportBetweenPdf = await createLabeledPdfFile('viewport-between.pdf', ['VIEWPORT_INSERTED']);
        const dtViewportBetween = makeFileDataTransfer([viewportBetweenPdf]);
        const pageWrappers = document.querySelectorAll('.page-wrapper');
        const pw0Rect = pageWrappers[0].getBoundingClientRect();
        const pw1Rect = pageWrappers[1].getBoundingClientRect();
        const vpGapY = (pw0Rect.bottom + pw1Rect.top) / 2;

        const viewport = document.querySelector('.app-viewport');
        viewport.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientY: vpGapY,
          dataTransfer: dtViewportBetween
        }));
        const vpIndicatorShown = pageWrappers[0].classList.contains('page-drop-bottom') || pageWrappers[1].classList.contains('page-drop-top');

        viewport.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientY: vpGapY,
          dataTransfer: dtViewportBetween
        }));
        await sleep(500);
        const labelsAfterViewportBetweenDrop = await getDocumentPageLabels();

        return {
          initialLabels,
          hoverState: {
            normalBtnText,
            hoverHasClass,
            hoverBtnText,
            normalBorderColor,
            hoverBorderColor,
            afterLeaveHasClass,
            afterLeaveBtnText
          },
          labelsAfterNonPdfDrop,
          labelsAfterMixedDrop,
          gapIndicatorShown,
          labelsAfterThumbBetweenDrop,
          annPageIndexAfterInsert,
          labelsAfterTopDrop,
          vpIndicatorShown,
          labelsAfterViewportBetweenDrop
        };
      })()`
    });

    const result = evalRes.result.value;
    console.log('Drag & Drop PDF Test Result:', JSON.stringify(result, null, 2));

    if (!result) {
      throw new Error('Evaluation returned null/undefined: ' + JSON.stringify(evalRes));
    }

    // Assertions
    if (JSON.stringify(result.initialLabels) !== JSON.stringify(['BASE_P1', 'BASE_P2'])) {
      throw new Error('Unexpected initialLabels: ' + JSON.stringify(result.initialLabels));
    }
    if (!result.hoverState.hoverHasClass || result.hoverState.hoverBtnText !== 'Drop PDF to Add Pages') {
      throw new Error('Hover state on Add Page from PDF button did not activate properly: ' + JSON.stringify(result.hoverState));
    }
    if (result.hoverState.afterLeaveHasClass || result.hoverState.afterLeaveBtnText !== 'Add Page from PDF') {
      throw new Error('Hover state did not reset after dragleave: ' + JSON.stringify(result.hoverState));
    }
    if (JSON.stringify(result.labelsAfterNonPdfDrop) !== JSON.stringify(['BASE_P1', 'BASE_P2'])) {
      throw new Error('Non-PDF drop should do nothing, but got: ' + JSON.stringify(result.labelsAfterNonPdfDrop));
    }
    if (JSON.stringify(result.labelsAfterMixedDrop) !== JSON.stringify(['BASE_P1', 'BASE_P2', 'MIXED_PDF_1', 'MIXED_PDF_2'])) {
      throw new Error('Mixed files drop should add only PDFs at the bottom, but got: ' + JSON.stringify(result.labelsAfterMixedDrop));
    }
    if (!result.gapIndicatorShown) {
      throw new Error('Gap indicator between thumbnail cards was not shown on dragover');
    }
    if (JSON.stringify(result.labelsAfterThumbBetweenDrop) !== JSON.stringify(['BASE_P1', 'INSERTED_BETWEEN_1_AND_2', 'BASE_P2', 'MIXED_PDF_1', 'MIXED_PDF_2'])) {
      throw new Error('Drop between thumbnail cards 0 and 1 failed, got: ' + JSON.stringify(result.labelsAfterThumbBetweenDrop));
    }
    if (result.annPageIndexAfterInsert !== 2) {
      throw new Error(`Expected annotation on BASE_P2 to shift from index 1 to 2, got ${result.annPageIndexAfterInsert}`);
    }
    if (JSON.stringify(result.labelsAfterTopDrop) !== JSON.stringify(['INSERTED_AT_VERY_TOP', 'BASE_P1', 'INSERTED_BETWEEN_1_AND_2', 'BASE_P2', 'MIXED_PDF_1', 'MIXED_PDF_2'])) {
      throw new Error('Drop before first thumbnail card failed, got: ' + JSON.stringify(result.labelsAfterTopDrop));
    }
    if (!result.vpIndicatorShown) {
      throw new Error('Gap indicator between pages in main viewport was not shown on dragover');
    }
    if (JSON.stringify(result.labelsAfterViewportBetweenDrop) !== JSON.stringify(['INSERTED_AT_VERY_TOP', 'VIEWPORT_INSERTED', 'BASE_P1', 'INSERTED_BETWEEN_1_AND_2', 'BASE_P2', 'MIXED_PDF_1', 'MIXED_PDF_2'])) {
      throw new Error('Drop between pages in main viewport failed, got: ' + JSON.stringify(result.labelsAfterViewportBetweenDrop));
    }

    console.log('✅ ALL DRAG & DROP PDF TESTS PASSED!');
    ws.close();
  } finally {
    chrome.kill();
    server.close();
  }
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
