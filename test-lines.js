const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function testHeaderLines() {
  const PORT = 21000 + Math.floor(Math.random() * 8000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-test-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');
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
  
  await new Promise(r => setTimeout(r, 1500));
  const res = await fetch('http://127.0.0.1:' + PORT + '/json');
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  
  let id = 1;
  const send = (method, params) => new Promise(res => {
    const curId = id++;
    const handler = (evt) => {
      const data = JSON.parse(evt.data);
      if (data.id === curId) {
        ws.removeEventListener('message', handler);
        res(data.result);
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

  const pdfBytes = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf');
  const base64 = pdfBytes.toString('base64');
  
  console.log('Loading test_case1.pdf into app...');
  await evaluate(`
    const bin = atob("${base64}");
    const u8 = new Uint8Array(bin.length);
    for(let i=0; i<bin.length; i++) u8[i] = bin.charCodeAt(i);
    await window.uiController.loadPdfBuffer(u8.buffer, "test_case1.pdf");
    document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
    await window.canvasController.loadTextItemsForActivePage();
  `);

  console.log('\n=======================================');
  console.log('STEP 1: EDITING PAGE 1 (ALL 3 LINES)');
  console.log('=======================================');


  const testP1 = await evaluate(`
    const results = [];
    const targets = [
      { prefix: 'GOODRICH', newText: 'GOODRICH TERMINAL 2012 XXX' },
      { prefix: 'PO Box', newText: 'PO Box 99999, SURREY, BC V3W 2P5,' },
      { prefix: 'Tel (604)', newText: 'Tel (604) 999-9999 Fax (604) 999-9998' }
    ];
    for (const item of targets) {
      const toolBefore = window.canvasController.activeTool;
      const it = window.canvasController.cachedPageTextItems.find(t => t.str.includes(item.prefix));
      const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
      const rect = layer.getBoundingClientRect();
      const clientX = rect.left + (it ? it.x + 20 : 0);
      const clientY = rect.top + (it ? it.y + 4 : 0);
      const pt = window.canvasController.screenToPdf({ clientX, clientY });
      const hit = window.canvasController.findTextItemAt(pt);

      await window.canvasController.handlePointerDown({
        button: 0,
        clientX,
        clientY,
        target: layer
      });

      const sel = window.uiController.annotationManager.getSelectedAnnotation();
      const pageWrapper = document.querySelector('.page-wrapper[data-page-index="0"]');
      const textarea = pageWrapper.querySelector('.pdf-text-element[data-id="' + sel.id + '"] .pdf-text-content');
      if (textarea) {
        textarea.value = item.newText;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }

      const inCacheAfter = window.canvasController.cachedPageTextItems.some(t => t.str.includes(item.prefix));
      results.push({
        prefix: item.prefix,
        hitStr: hit ? hit.str : null,
        inCacheAfter,
        sel
      });
    }
    return results;
  `);

  testP1.forEach((res, i) => {
    console.log(`Edited Page 1 Line ${i + 1}:`, {
      id: res.sel ? res.sel.id : null,
      text: res.sel ? res.sel.text : null,
      x: res.sel ? res.sel.x : null,
      y: res.sel ? res.sel.y : null,
      width: res.sel ? res.sel.width : null,
      height: res.sel ? res.sel.height : null
    });
  });

  // Check Page 1 DOM heights and overlap
  const page1DomBoxes = await evaluate(`
    window.uiController.annotationManager.deselectAll();
    const els = Array.from(document.querySelectorAll('.page-wrapper[data-page-index="0"] .pdf-text-element'));
    return els.map(el => ({
      text: el.querySelector('.pdf-text-content').value,
      top: el.offsetTop,
      bottom: el.offsetTop + el.offsetHeight,
      height: el.offsetHeight,
      width: el.offsetWidth
    }));
  `);
  console.log('\nPage 1 DOM bounding boxes:', page1DomBoxes);
  
  const p1Overlap12 = page1DomBoxes[0].bottom > page1DomBoxes[1].top;
  const p1Overlap23 = page1DomBoxes[1].bottom > page1DomBoxes[2].top;
  console.log('Page 1: Does Line 1 overlap Line 2?', p1Overlap12);
  console.log('Page 1: Does Line 2 overlap Line 3?', p1Overlap23);

  console.log('\n=======================================');
  console.log('STEP 2: SWITCHING TO PAGE 2 & EDITING');
  console.log('=======================================');

  const testP2 = await evaluate(`
    window.uiController.switchActivePage(1);
    await window.canvasController.loadTextItemsForActivePage();

    const results = [];
    const targets = [
      { prefix: 'GOODRICH', newText: 'ALPHA TERMINAL 2026 LTD' },
      { prefix: 'PO Box', newText: 'PO Box 88888, RICHMOND, BC V6X 1A1,' },
      { prefix: 'Tel (604)', newText: 'Tel (604) 888-8888 Fax (604) 888-8887' }
    ];
    for (const item of targets) {
      const it = window.canvasController.cachedPageTextItems.find(t => t.str.includes(item.prefix));
      const layer = document.querySelector('.page-wrapper[data-page-index="1"] .annotation-layer');
      const rect = layer.getBoundingClientRect();
      const clientX = rect.left + it.x + 20;
      const clientY = rect.top + it.y + 4;
      const pt = window.canvasController.screenToPdf({ clientX, clientY });
      const hit = window.canvasController.findTextItemAt(pt);

      await window.canvasController.handlePointerDown({
        button: 0,
        clientX,
        clientY,
        target: layer
      });

      const sel = window.uiController.annotationManager.getSelectedAnnotation();
      const pageWrapper = document.querySelector('.page-wrapper[data-page-index="1"]');
      const textarea = pageWrapper.querySelector('.pdf-text-element[data-id="' + sel.id + '"] .pdf-text-content');
      if (textarea) {
        textarea.value = item.newText;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }

      const inCacheAfter = window.canvasController.cachedPageTextItems.some(t => t.str.includes(item.prefix));
      results.push({
        prefix: item.prefix,
        hitStr: hit ? hit.str : null,
        inCacheAfter,
        sel
      });
    }
    return results;
  `);

  testP2.forEach((res, i) => {
    console.log(`Edited Page 2 Line ${i + 1}:`, {
      id: res.sel ? res.sel.id : null,
      text: res.sel ? res.sel.text : null,
      x: res.sel ? res.sel.x : null,
      y: res.sel ? res.sel.y : null,
      width: res.sel ? res.sel.width : null,
      height: res.sel ? res.sel.height : null
    });
  });

  // Check Page 2 DOM heights and overlap
  const page2DomBoxes = await evaluate(`
    window.uiController.annotationManager.deselectAll();
    const els = Array.from(document.querySelectorAll('.page-wrapper[data-page-index="1"] .pdf-text-element'));
    return els.map(el => ({
      text: el.querySelector('.pdf-text-content').value,
      top: el.offsetTop,
      bottom: el.offsetTop + el.offsetHeight,
      height: el.offsetHeight,
      width: el.offsetWidth
    }));
  `);
  console.log('\nPage 2 DOM bounding boxes:', page2DomBoxes);
  
  const p2Overlap12 = page2DomBoxes[0].bottom > page2DomBoxes[1].top;
  const p2Overlap23 = page2DomBoxes[1].bottom > page2DomBoxes[2].top;
  console.log('Page 2: Does Line 1 overlap Line 2?', p2Overlap12);
  console.log('Page 2: Does Line 2 overlap Line 3?', p2Overlap23);

  console.log('\n=======================================');
  console.log('STEP 3: EXPORTING AND VERIFYING PDF');
  console.log('=======================================');

  const exportResult = await evaluate(`
    const exportRes = await window.pdfEngine.exportPDF(window.uiController.annotationManager);
    const exportedBytes = exportRes.bytes;
    let bin = '';
    for(let i=0; i<exportedBytes.length; i++) bin += String.fromCharCode(exportedBytes[i]);
    const b64 = btoa(bin);
    
    // Also reload into PDF.js inside the browser to verify text on both pages
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(exportedBytes) }).promise;
    const p1 = await doc.getPage(1);
    const tc1 = await p1.getTextContent();
    const p2 = await doc.getPage(2);
    const tc2 = await p2.getTextContent();

    return {
      byteLength: exportedBytes.length,
      b64: b64,
      p1Strings: tc1.items.map(it => it.str).filter(s => s.trim().length > 0),
      p2Strings: tc2.items.map(it => it.str).filter(s => s.trim().length > 0)
    };
  `);

  console.log('Exported PDF size:', exportResult.byteLength, 'bytes');
  console.log('\nExported Page 1 header items:', exportResult.p1Strings.slice(-3));
  console.log('Exported Page 2 header items:', exportResult.p2Strings.slice(-3));
  console.log('p1 matches for old check:', exportResult.p1Strings.filter(s => s.includes('583-0006') || s.includes('16601') || s.includes('GOODRICH')));
  console.log('p2 matches for old check:', exportResult.p2Strings.filter(s => s.includes('583-0006') || s.includes('16601') || s.includes('GOODRICH')));


  // Save exported PDF to disk for inspection
  const outPdfPath = path.resolve(__dirname, 'test_case1_edited.pdf');
  fs.writeFileSync(outPdfPath, Buffer.from(exportResult.b64, 'base64'));
  console.log('Saved exported PDF to:', outPdfPath);

  // Capture screenshot of UI
  const screenshotData = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve(__dirname, 'test-lines-success.png'), Buffer.from(screenshotData.data, 'base64'));
  console.log('Saved UI screenshot to test-lines-success.png');

  // Assertions
  const p1Line1Ok = exportResult.p1Strings.some(s => s.includes('GOODRICH TERMINAL 2012 XXX'));
  const p1Line2Ok = exportResult.p1Strings.some(s => s.includes('PO Box 99999'));
  const p1Line3Ok = exportResult.p1Strings.some(s => s.includes('999-9999'));
  const p2Line1Ok = exportResult.p2Strings.some(s => s.includes('ALPHA TERMINAL 2026 LTD'));
  const p2Line2Ok = exportResult.p2Strings.some(s => s.includes('PO Box 88888'));
  const p2Line3Ok = exportResult.p2Strings.some(s => s.includes('888-8888'));

  const p1OldGone = !exportResult.p1Strings.some(s => s.includes('583-0006')) &&
                    !exportResult.p1Strings.some(s => s.includes('16601')) &&
                    !exportResult.p1Strings.some(s => s.includes('GOODRICH TERMINAL 2012 LTD'));
  const p2OldGone = !exportResult.p2Strings.some(s => s.includes('583-0006')) &&
                    !exportResult.p2Strings.some(s => s.includes('16601')) &&
                    !exportResult.p2Strings.some(s => s.includes('GOODRICH TERMINAL 2012 LTD'));

  console.log('\n--- VERIFICATION CHECKS ---');
  console.log('Page 1 Line 1 Replaced:', p1Line1Ok);
  console.log('Page 1 Line 2 Replaced:', p1Line2Ok);
  console.log('Page 1 Line 3 Replaced:', p1Line3Ok);
  console.log('Page 2 Line 1 Replaced:', p2Line1Ok);
  console.log('Page 2 Line 2 Replaced:', p2Line2Ok);
  console.log('Page 2 Line 3 Replaced:', p2Line3Ok);
  console.log('Page 1 Old Header Gone:', p1OldGone);
  console.log('Page 2 Old Header Gone:', p2OldGone);
  console.log('Page 1 Overlaps:', p1Overlap12 || p1Overlap23 ? 'FAILED' : 'PASSED (0 overlap)');
  console.log('Page 2 Overlaps:', p2Overlap12 || p2Overlap23 ? 'FAILED' : 'PASSED (0 overlap)');

  chrome.kill();
  if (p1Line1Ok && p1Line2Ok && p1Line3Ok && p2Line1Ok && p2Line2Ok && p2Line3Ok && p1OldGone && p2OldGone && !p1Overlap12 && !p1Overlap23 && !p2Overlap12 && !p2Overlap23) {
    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! ALL 6 LINES ON PAGE 1 & PAGE 2 INDEPENDENTLY REPLACED WITH 0 OVERLAP!');
    process.exit(0);
  } else {
    console.error('\n❌ SOME CHECKS FAILED!');
    process.exit(1);
  }
}

testHeaderLines().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
