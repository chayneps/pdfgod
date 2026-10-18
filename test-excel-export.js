const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

async function runExcelExportTest() {
  console.log('Starting automated Excel export test in headless Chrome...');
  const PORT = 25000 + Math.floor(Math.random() * 4000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-excel-test-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--window-size=1280,900',
    HTML_FILE
  ]);

  try {
    await new Promise(r => setTimeout(r, 1500));
    const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let msgId = 1;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = msgId++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === id) {
          ws.removeEventListener('message', handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Runtime.enable');
    const pdfPath = '/Users/pumisake/Downloads/test_case1.pdf';
    const base64Pdf = fs.readFileSync(pdfPath).toString('base64');

    console.log('1. Evaluating in browser: verifying UI button & loading PDF...');
    const evalRes = await send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        // 1. Check UI Export button in template
        const excelBtn = document.querySelector('#btn-export-excel');
        if (!excelBtn) {
          throw new Error('#btn-export-excel button missing in DOM');
        }

        // 2. Load test_case1.pdf
        const bin = atob("${base64Pdf}");
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);

        await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
        await sleep(500);

        // 2b. Test real text edit with redaction:
        // Redact "CENTURION" from page 0 stream and add replacement text annotation
        const itemsP0 = await window.pdfEngine.getTextItems(0);
        const centurionItem = itemsP0.find(it => it.str === 'CENTURION');
        if (centurionItem) {
          await window.pdfEngine.redactTextFromPage(0, centurionItem.str, centurionItem.rawTx, centurionItem.rawTy);
        }
        window.annotationManager.addAnnotation({
          pageIndex: 0,
          type: 'text',
          text: 'PACIFIC CENTURION',
          originalText: 'CENTURION',
          isOriginalReplacement: true,
          x: 68.3,
          y: 116.3,
          width: 120,
          height: 15,
          fontWeight: 'bold',
        });

        // 2c. Add user annotations (text and rect) to test user annotation export
        window.annotationManager.addAnnotation({
          pageIndex: 0,
          type: 'text',
          text: 'SPECIAL HANDLING NOTE',
          x: 17.91,
          y: 745.0,
          width: 150,
          height: 14,
          fontWeight: 'bold',
        });
        window.annotationManager.addAnnotation({
          pageIndex: 0,
          type: 'rect',
          x: 17.91,
          y: 740.0,
          width: 200,
          height: 20,
        });

        // 3. Test interactive filename prompt flow:
        // A. Trigger export without arguments -> must open dialog asking for filename
        console.log('   Starting exportToExcel() without arguments...');
        let interactivePromise = window.uiController.exportToExcel();
        await sleep(200);

        const dialog = document.querySelector('#dialog-save-as');
        const input = document.querySelector('#input-save-as-name');
        const titleSpan = dialog ? dialog.querySelector('.modal-title span') : null;
        const submitBtn = dialog ? dialog.querySelector('#btn-confirm-save-as') : null;

        if (!dialog || !dialog.open) {
          throw new Error('Expected #dialog-save-as to be open when exporting to Excel without arguments');
        }
        if (titleSpan.textContent !== 'Export to Excel') {
          throw new Error('Expected dialog title "Export to Excel", got: ' + titleSpan.textContent);
        }
        if (submitBtn.textContent !== 'Export') {
          throw new Error('Expected submit button text "Export", got: ' + submitBtn.textContent);
        }
        if (input.value !== 'test_case1.xlsx') {
          throw new Error('Expected prefilled filename "test_case1.xlsx", got: ' + input.value);
        }

        // B. Test cancellation
        console.log('   Testing cancel flow...');
        const cancelBtn = dialog.querySelector('#btn-cancel-save-as');
        cancelBtn.click();
        const cancelRes = await interactivePromise;
        if (!cancelRes || cancelRes.exported !== false || cancelRes.reason !== 'cancelled_by_user') {
          throw new Error('Expected cancelled result, got: ' + JSON.stringify(cancelRes));
        }
        await sleep(100);

        // C. Trigger again and confirm with custom name
        console.log('   Triggering export again and submitting custom filename...');
        interactivePromise = window.uiController.exportToExcel();
        await sleep(200);
        input.value = "test_case1_out.xlsx";
        submitBtn.click();
        const res = await interactivePromise;
        if (!res || !res.exported || res.filename !== "test_case1_out.xlsx") {
          throw new Error("Interactive exportToExcel returned unexpected result: " + JSON.stringify(res));
        }

        // D. Test replacing: export again with the same filename -> replaces without blocking
        console.log('   Triggering export again with same filename (replace test)...');
        const replaceRes = await window.uiController.exportToExcel("test_case1_out.xlsx");
        if (!replaceRes || !replaceRes.exported) {
          throw new Error("Replace export failed: " + JSON.stringify(replaceRes));
        }

        // 4. Return result with base64 encoded bytes
        const bytes = res.bytes;
        let binaryStr = '';
        for (let i = 0; i < bytes.length; i++) {
          binaryStr += String.fromCharCode(bytes[i]);
        }
        return {
          exported: res.exported,
          filename: res.filename,
          size: res.size,
          sheetCount: res.sheetCount,
          base64: btoa(binaryStr),
        };
      })()`
    });

    if (evalRes.exceptionDetails) {
      throw new Error('Browser execution error: ' + JSON.stringify(evalRes.exceptionDetails));
    }

    const exportResult = evalRes.result.value;
    console.log('Browser exported successfully:', {
      filename: exportResult.filename,
      size: exportResult.size,
      sheetCount: exportResult.sheetCount,
    });

    const outXlsxPath = path.resolve(__dirname, 'test_case1_exported.xlsx');
    const xlsxBuf = Buffer.from(exportResult.base64, 'base64');
    fs.writeFileSync(outXlsxPath, xlsxBuf);
    console.log(`Saved output .xlsx to ${outXlsxPath} (${xlsxBuf.length} bytes)`);

    // 5. Verification using Python script
    console.log('\n2. Verifying .xlsx workbook structure, text preservation, column alignment, and cell borders...');
    const verifyScriptPath = path.resolve(__dirname, 'verify-excel.py');
    const pyRes = spawnSync('python3', [verifyScriptPath, outXlsxPath], { stdio: 'inherit' });
    if (pyRes.status !== 0) {
      throw new Error(`Python verification failed with exit code ${pyRes.status}`);
    }

    console.log('\n✅ Automated test completed successfully with 100% assertions passed!');
  } finally {
    try {
      chrome.kill('SIGKILL');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

runExcelExportTest().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
