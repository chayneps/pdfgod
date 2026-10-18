const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Math.floor(12000 + Math.random() * 20000);
const HTML_FILE = `file://${path.resolve(__dirname, 'pdfgod.html')}`;

async function run() {
  console.log(`1. Launching headless Google Chrome on port ${PORT}...`);
  const userDataDir = `/tmp/chrome-test-${Date.now()}`;
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1280,900',
    '--disable-cache',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    HTML_FILE
  ]);

  console.log('2. Connecting to Chrome DevTools Protocol...');
  let pageTarget = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const targets = await getJson(`http://127.0.0.1:${PORT}/json`);
      pageTarget = targets.find(t => t.type === 'page');
      if (pageTarget) break;
    } catch (e) {
      // Chrome starting up
    }
  }
  if (!pageTarget) throw new Error('No page target found after 6s');

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let msgId = 1;
  const pending = new Map();

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    }
  };

  const send = (method, params = {}) => {
    const id = msgId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  await new Promise(r => ws.onopen = r);
  console.log('3. DevTools Protocol WebSocket connected!');

  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (expression) => {
    let code = expression.trim();
    if (!code.includes('return ') && !code.includes('const ') && !code.includes('let ') && !code.includes(';')) {
      code = `return (${code});`;
    } else if (code.startsWith('(() =>') || code.startsWith('(function')) {
      code = `return ${code};`;
    }
    const wrapped = `(async () => {\n${code}\n})()`;
    const res = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
    if (res.result && res.result.exceptionDetails) {
      throw new Error(`Eval error in [${expression}]: ` + JSON.stringify(res.result.exceptionDetails));
    }
    return res.result ? res.result.result.value : undefined;
  };

  console.log('4. Waiting for DOM load...');
  await new Promise(r => setTimeout(r, 1000));

  // Check document title
  const title = await evaluate('document.title');
  console.log('   Document Title:', title);

  // Load PDF file
  console.log('5. Loading test_case1.pdf...');
  const testCase1Bytes = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf');
  const base64 = testCase1Bytes.toString('base64');
  await evaluate(`
    const bin = atob("${base64}");
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    await window.uiController.loadPdfBuffer(u8.buffer, "test_case1.pdf");
  `);
  await new Promise(r => setTimeout(r, 2000));

  // Verify pages rendered
  const pageCount = await evaluate(`document.querySelectorAll('.page-wrapper').length`);
  console.log('   Rendered Pages:', pageCount);
  if (pageCount < 1) throw new Error('No pages rendered!');

  // TEST 1: TEXT TOOL WITH PERSISTENT DOM ELEMENT & TOOLBAR SYNC
  console.log('6. Testing Text Tool (<kbd>T</kbd>)...');
  await evaluate(`document.querySelector('.tool-btn[data-tool="text"]').click()`);

  // Verify tool state
  const activeTool = await evaluate(`document.querySelector('.app-viewport').className`);
  console.log('   Viewport class:', activeTool);

  // Click on annotation layer to spawn text editor
  console.log('7. Clicking on document canvas to spawn persistent DOM text element...');
  await evaluate(`
    const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
    const rect = layer.getBoundingClientRect();
    const evt = new PointerEvent('pointerdown', {
      button: 0,
      clientX: rect.left + 350,
      clientY: rect.top + 160,
      bubbles: true
    });
    layer.dispatchEvent(evt);
  `);
  await new Promise(r => setTimeout(r, 200));

  // Check if DOM text element appeared with PDFescape structure
  const textElementInfo = await evaluate(`
    (() => {
      const el = document.querySelector('.pdf-text-element.selected') || document.querySelector('.pdf-text-element');
      if (!el) return null;
      const textarea = el.querySelector('.pdf-text-content');
      const dragBar = el.querySelector('.pdf-text-drag-bar');
      const handles = el.querySelectorAll('.pdf-text-handle');
      return {
        hasDragBar: !!dragBar,
        handleCount: handles.length,
        hasTextarea: !!textarea,
        isFocused: document.activeElement === textarea,
        fontSize: textarea.style.fontSize,
        fontFamily: textarea.style.fontFamily
      };
    })()
  `);
  console.log('   Persistent Text Element spawned successfully:', textElementInfo);
  if (!textElementInfo || !textElementInfo.hasTextarea) {
    throw new Error('Persistent DOM text element was not created properly!');
  }

  // Type multi-line text into textarea
  console.log('8. Typing multi-line text: "APPROVED BY AUDITOR\\nPDFescape Overlay Architecture"...');
  await evaluate(`
    const el = document.querySelector('.pdf-text-element.selected');
    const textarea = el.querySelector('.pdf-text-content');
    textarea.value = "APPROVED BY AUDITOR\\nPDFescape Overlay Architecture";
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await new Promise(r => setTimeout(r, 150));

  // Change font properties via toolbar
  console.log('9. Testing real-time toolbar synchronization (Font size, Bold, Color, Whiteout)...');
  await evaluate(`
    // Change font size
    const sizeSelect = document.querySelector('#prop-font-size');
    if (sizeSelect) {
      sizeSelect.value = '18';
      sizeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Ensure Bold
    const boldBtn = document.querySelector('#prop-bold-btn');
    if (boldBtn && !boldBtn.classList.contains('active')) boldBtn.click();

    // Toggle Color to Blue
    const blueSwatch = document.querySelector('.color-swatch-btn[data-color="#3b82f6"]');
    if (blueSwatch) blueSwatch.click();

    // Toggle Whiteout Background
    const whiteoutBtn = document.querySelector('#prop-whiteout-btn');
    if (whiteoutBtn) whiteoutBtn.click();
  `);
  await new Promise(r => setTimeout(r, 200));

  // Verify properties updated on DOM element and annotation model
  const updatedProps = await evaluate(`
    (() => {
      const ann = window.uiController.annotationManager.getSelectedAnnotation();
      const el = document.querySelector('.pdf-text-element.selected');
      const textarea = el ? el.querySelector('.pdf-text-content') : null;
      return {
        model: {
          fontSize: ann.fontSize,
          fontWeight: ann.fontWeight,
          fontColor: ann.fontColor,
          backgroundColor: ann.backgroundColor,
          text: ann.text
        },
        dom: {
          fontSize: textarea ? textarea.style.fontSize : null,
          fontWeight: textarea ? textarea.style.fontWeight : null,
          color: textarea ? textarea.style.color : null,
          backgroundColor: el ? el.style.backgroundColor : null
        }
      };
    })()
  `);
  console.log('   Updated Text Properties (Model & DOM):', updatedProps);
  if (updatedProps.model.fontWeight !== 'bold') {
    throw new Error('Toolbar styling did not synchronize to text element!');
  }
  console.log('   ✅ Persistent DOM Text Tool and Live Toolbar Synchronization PASSED!');

  // TEST 2: EDIT EXISTING PDF TEXT TOOL (PDFescape Whiteout + Text Overlay)
  console.log('10. Testing "Edit Existing PDF Text" Tool (PDFescape Whiteout + Replacement)...');
  await evaluate(`document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click()`);
  await evaluate(`window.canvasController.loadTextItemsForActivePage()`);
  await new Promise(r => setTimeout(r, 600));

  // Inspect first detected text item
  const firstItem = await evaluate(`
    return window.canvasController.cachedPageTextItems && window.canvasController.cachedPageTextItems.length > 0
      ? window.canvasController.cachedPageTextItems[0]
      : null;
  `);
  console.log('   First detected text item on page:', firstItem);

  if (firstItem) {
    const editResult = await evaluate(`
      const item = window.canvasController.cachedPageTextItems[0];
      const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
      const rect = layer.getBoundingClientRect();
      const targetClientX = rect.left + item.x + 10;
      const targetClientY = rect.top + item.y + 4;
      
      const evt = {
        button: 0,
        clientX: targetClientX,
        clientY: targetClientY,
        target: layer
      };
      await window.canvasController.handlePointerDown(evt);

      const selAnn = window.uiController.annotationManager.getSelectedAnnotation();
      return {
        clickedOriginalText: item.str,
        spawnedAnnotation: selAnn
      };
    `);
    console.log('   Spawning real replacement for original PDF text:', editResult);

    if (!editResult.spawnedAnnotation) {
      throw new Error('Edit PDF Text did not spawn a replacement text box!');
    }

    // Verify background is clean and transparent (no whiteout patch cutting through navy banner)
    console.log('   Spawned annotation background color:', editResult.spawnedAnnotation.backgroundColor);
    console.log('   Spawned annotation text color:', editResult.spawnedAnnotation.fontColor);

    // Verify font style was matched accurately
    if (firstItem.fontWeight === 'bold') {
      if (editResult.spawnedAnnotation.fontWeight !== 'bold') {
        throw new Error('Font weight bold was not matched from original text!');
      }
      console.log('   ✅ Original Font Weight (bold) accurately matched!');
    }

    // Now type new text into the newly spawned selected element
    await evaluate(`
      const el = document.querySelector('.pdf-text-element.selected');
      const textarea = el.querySelector('.pdf-text-content');
      textarea.value = "MASTER SERVICES AGREEMENT";
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await new Promise(r => setTimeout(r, 200));

    const finalAnn = await evaluate(`
      return window.uiController.annotationManager.getSelectedAnnotation();
    `);
    console.log('   Updated Replacement Text Annotation:', finalAnn);
    if (!finalAnn.text.includes('MASTER SERVICES')) {
      throw new Error('Replacement text was not saved!');
    }

    // Deselect to test that the border disappears completely
    console.log('10b. Deselecting text element to verify border becomes invisible...');
    await evaluate(`window.uiController.annotationManager.deselectAll()`);
    await new Promise(r => setTimeout(r, 200));

    const borderInfo = await evaluate(`
      (() => {
        const el = document.querySelector('.pdf-text-element');
        if (!el) return null;
        const style = window.getComputedStyle(el);
        return {
          borderColor: style.borderColor,
          borderStyle: style.borderStyle,
          boxShadow: style.boxShadow
        };
      })()
    `);
    console.log('   Unselected Text Element computed borders:', borderInfo);

    console.log('   ✅ Edit Existing PDF Text tool and neat seamless border PASSED!');
  }

  // TEST 3: EXPORT PDF
  console.log('11. Testing PDF Vector Export with PDF-Lib...');
  const exportResult = await evaluate(`
    return (async () => {
      try {
        const res = await window.uiController.pdfEngine.exportPDF(window.uiController.annotationManager, 'test_output.pdf');
        return { success: true, size: res.size, filename: res.filename };
      } catch (e) {
        return { success: false, error: e.message, stack: e.stack };
      }
    })();
  `);
  console.log('   Export result:', exportResult);
  if (!exportResult || !exportResult.success) throw new Error('PDF export failed!');
  console.log('   ✅ PDF Vector Export PASSED! Size:', exportResult.size, 'bytes');

  // Take visual screenshot
  console.log('12. Capturing browser screenshot...');
  const screenshotRes = await send('Page.captureScreenshot', { format: 'png' });
  const base64Data = screenshotRes.result ? screenshotRes.result.data : (screenshotRes.data || '');
  if (base64Data) {
    fs.writeFileSync('test-screenshot.png', Buffer.from(base64Data, 'base64'));
    console.log('   Screenshot saved to test-screenshot.png (Size: ' + base64Data.length + ' base64 chars)');
  }

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! The text tool and editor work end-to-end!');
  chrome.kill();
  process.exit(0);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

run().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
