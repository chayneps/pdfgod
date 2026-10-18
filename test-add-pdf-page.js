const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('./vendor/pdf-lib.min.js');

async function testAddPdfPage() {
  console.log('--- Starting Add Page from PDF Test Suite ---');
  const PORT = 22000 + Math.floor(Math.random() * 7000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-test-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  console.log(`1. Launching headless Google Chrome on port ${PORT}...`);
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    HTML_FILE
  ]);

  try {
    await new Promise(r => setTimeout(r, 1500));
    const res = await fetch('http://127.0.0.1:' + PORT + '/json');
    const targets = await res.json();
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let id = 1;
    const send = (method, params) => new Promise(resolve => {
      const curId = id++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === curId) {
          ws.removeEventListener('message', handler);
          resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });

    await send('Runtime.enable');
    const evaluate = async (code) => {
      const wrapped = `(async () => {\n${code}\n})()`;
      const r = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result ? r.result.value : undefined;
    };

    console.log('2. Verifying Branding & UI Controls...');
    const branding = await evaluate(`
      const title = document.title;
      const brandLogo = document.querySelector('.brand-logo span')?.textContent?.trim();
      const addBlankBtn = document.querySelector('[data-action="add-blank-page"]');
      const addPdfBtn = document.querySelector('[data-action="add-pdf-page"]');
      const wrapper = addBlankBtn?.parentElement;
      const children = Array.from(wrapper?.children || []);
      const blankIndex = children.indexOf(addBlankBtn);
      const pdfIndex = children.indexOf(addPdfBtn);
      const fileInput = document.querySelector('#input-add-pdf-page');

      return {
        title,
        brandLogo,
        hasAddBlankBtn: !!addBlankBtn,
        hasAddPdfBtn: !!addPdfBtn,
        hasFileInput: !!fileInput,
        pdfIsDirectlyUnderBlank: pdfIndex === blankIndex + 1,
        wrapperFlexDirection: window.getComputedStyle(wrapper).flexDirection,
        btnText: addPdfBtn?.textContent?.trim()
      };
    `);

    console.log('Branding details:', branding);
    if (!branding.title.includes('PDFGod')) throw new Error(`Document title is not PDFGod: ${branding.title}`);
    if (branding.brandLogo !== 'PDFGod') throw new Error(`Brand text is not PDFGod: ${branding.brandLogo}`);
    if (!branding.hasAddPdfBtn) throw new Error('Missing [data-action="add-pdf-page"] button!');
    if (!branding.pdfIsDirectlyUnderBlank) throw new Error('Add Page from PDF button is NOT directly under Add Blank Page!');
    console.log('✅ Branding and UI structure verified: PDFGod branding & button positioned correctly.');

    console.log('3. Loading ~/Downloads/test_case1.pdf...');
    const testCase1Bytes = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf');
    const base64 = testCase1Bytes.toString('base64');

    const initialLoad = await evaluate(`
      const bin = atob("${base64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer, "test_case1.pdf");
      return {
        numPages: window.pdfEngine.getPageCount(),
        thumbnailsCount: document.querySelectorAll('.thumbnail-card').length,
        pagesInDOM: document.querySelectorAll('.page-wrapper').length
      };
    `);

    console.log('Initial document loaded:', initialLoad);
    if (initialLoad.numPages !== 2) throw new Error(`Expected 2 initial pages, got ${initialLoad.numPages}`);
    if (initialLoad.thumbnailsCount !== 2) throw new Error(`Expected 2 thumbnails, got ${initialLoad.thumbnailsCount}`);
    console.log('✅ Initial test_case1.pdf loaded with 2 pages.');

    console.log('4. Adding test_case1.pdf pages back into the active document...');
    const importResult = await evaluate(`
      const bin = atob("${base64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const res = await window.uiController.addPagesFromPdfBuffer(u8.buffer);
      return {
        res,
        numPages: window.pdfEngine.getPageCount(),
        thumbnailsCount: document.querySelectorAll('.thumbnail-card').length,
        pagesInDOM: document.querySelectorAll('.page-wrapper').length,
        currentPage: window.uiController.currentPage
      };
    `);

    console.log('Import result:', importResult);
    if (importResult.numPages !== 4) throw new Error(`Expected 4 total pages after import, got ${importResult.numPages}`);
    if (importResult.thumbnailsCount !== 4) throw new Error(`Expected 4 thumbnails, got ${importResult.thumbnailsCount}`);
    if (importResult.pagesInDOM !== 4) throw new Error(`Expected 4 page wrappers, got ${importResult.pagesInDOM}`);
    console.log('✅ Successfully added pages from PDF: document now has 4 pages.');

    console.log('5. Exporting combined document as test_case2.pdf...');
    const exportData = await evaluate(`
      const result = await window.pdfEngine.exportPDF(window.uiController.annotationManager, 'test_case2.pdf');
      // Convert Uint8Array to base64
      let binary = '';
      const bytes = result.bytes;
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return {
        filename: result.filename,
        base64: btoa(binary),
        byteLength: len
      };
    `);

    console.log(`Exported filename: ${exportData.filename}, byteLength: ${exportData.byteLength}`);
    const exportedBuffer = Buffer.from(exportData.base64, 'base64');

    const downloadPath = '/Users/pumisake/Downloads/test_case2.pdf';
    const localPath = path.resolve(__dirname, 'test_case2.pdf');
    fs.writeFileSync(downloadPath, exportedBuffer);
    fs.writeFileSync(localPath, exportedBuffer);
    console.log(`Saved exported PDF to:`);
    console.log(`- ${downloadPath}`);
    console.log(`- ${localPath}`);

    console.log('6. Validating exported test_case2.pdf with PDFDocument parser...');
    const loadedDoc = await PDFDocument.load(exportedBuffer);
    const finalPageCount = loadedDoc.getPageCount();
    console.log(`Verified test_case2.pdf page count: ${finalPageCount}`);
    if (finalPageCount !== 4) throw new Error(`Exported PDF has ${finalPageCount} pages, expected 4!`);

    for (let i = 0; i < finalPageCount; i++) {
      const page = loadedDoc.getPage(i);
      const sz = page.getSize();
      console.log(`- Page ${i + 1} dimensions: ${sz.width} x ${sz.height}`);
      if (sz.width <= 0 || sz.height <= 0) throw new Error(`Invalid dimensions for page ${i + 1}`);
    }

    console.log('7. Capturing visual screenshot...');
    await send('Page.enable');
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.resolve(__dirname, 'test-add-pdf-success.png'), Buffer.from(screenshot.data, 'base64'));
    console.log('Screenshot saved to test-add-pdf-success.png');

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! test_case2.pdf created and verified.');
  } finally {
    chrome.kill('SIGKILL');
  }
}

testAddPdfPage().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
