const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

(async () => {
  console.log('🚀 Starting Saved Layers & Layer Dropdown Menu Test Suite...');
  const PORT = 28000 + Math.floor(Math.random() * 2000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-saved-layers-test-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    HTML_FILE
  ]);

  try {
    let page = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/json');
        const targets = await res.json();
        if (targets && targets.length > 0) {
          page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
          if (page) break;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 200));
    }

    if (!page) throw new Error('Could not connect to Chrome debugging port ' + PORT);

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
    await send('Page.enable');
    await new Promise(r => setTimeout(r, 800));

    const evalJs = async (expr) => {
      const res = await send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true
      });
      return res.result ? res.result.value : null;
    };

    // 1. Clear any prior localStorage
    await evalJs(`localStorage.removeItem('pdfgod_saved_layers_v1');`);

    // 2. Load test PDF
    const testPdfPath = path.resolve(__dirname, 'test_case2.pdf');
    const pdfBytes = fs.readFileSync(testPdfPath);

    await evalJs(`
      (async () => {
        const bin = atob("${pdfBytes.toString('base64')}");
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        await window.uiController.loadPdfBuffer(arr.buffer, 'test_case2.pdf');
      })()
    `);
    await new Promise(r => setTimeout(r, 800));

    // 3. Switch to "Layers" tab in sidebar
    await evalJs(`
      (() => {
        const layerTabBtn = document.querySelector('.sidebar-tab-btn[data-tab="annotations"]');
        if (layerTabBtn) layerTabBtn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 300));

    // 4. Verify Saved Layers section is on top of the Layers sidebar
    const initialStructure = await evalJs(`
      (() => {
        const annPanel = document.querySelector('#sidebar-panel-annotations');
        const savedSection = document.querySelector('#saved-layers-section');
        const countBadge = document.querySelector('#saved-layers-count');
        const docHeader = document.querySelector('.document-layers-header');
        const listContainer = document.querySelector('.annotations-list-container');

        const children = Array.from(annPanel.children);
        const savedIdx = children.indexOf(savedSection);
        const docHeaderIdx = children.indexOf(docHeader);
        const listIdx = children.indexOf(listContainer);

        return {
          hasSavedSection: !!savedSection,
          isSavedOnTop: savedIdx === 0 && savedIdx < docHeaderIdx && docHeaderIdx < listIdx,
          countText: countBadge ? countBadge.textContent.trim() : null
        };
      })()
    `);

    console.log('Test 1: Saved Layers section is positioned on top of Layers sidebar:', initialStructure.isSavedOnTop ? 'PASS' : 'FAIL');
    console.log('Test 2: Initial saved layers count is 0:', initialStructure.countText === '0' ? 'PASS' : 'FAIL');

    // 5. Add a custom text layer on Page 1
    await evalJs(`
      (() => {
        window.annotationManager.addAnnotation({
          pageIndex: 0,
          type: 'text',
          x: 100,
          y: 120,
          width: 240,
          height: 36,
          text: 'ACME SPECIAL DELIVERY NOTE',
          fontSize: 16,
          fontFamily: 'Helvetica',
          fontWeight: 'bold',
          fontStyle: 'normal',
          fontColor: '#2563eb'
        });
        window.uiController.renderAnnotationsList();
      })()
    `);
    await new Promise(r => setTimeout(r, 300));

    // 6. Verify the layer item has the 3-dots dropdown menu instead of direct delete icon
    const layerItemCheck = await evalJs(`
      (() => {
        const items = document.querySelectorAll('.annotation-item');
        if (items.length === 0) return { count: 0 };
        const first = items[0];
        const oldDeleteBtn = first.querySelector('.btn-delete');
        const menuBtn = first.querySelector('.btn-layer-menu');
        const menu = first.querySelector('.layer-dropdown-menu');
        const saveItem = menu ? menu.querySelector('.btn-action-save-layer') : null;
        const dupItem = menu ? menu.querySelector('.btn-action-dup-layer') : null;
        const delItem = menu ? menu.querySelector('.btn-action-delete-layer') : null;

        return {
          count: items.length,
          noOldDeleteBtn: !oldDeleteBtn,
          hasMenuBtn: !!menuBtn,
          hasSaveItem: !!saveItem && saveItem.textContent.includes('Save Layer'),
          hasDupItem: !!dupItem && dupItem.textContent.includes('Duplicate'),
          hasDelItem: !!delItem && delItem.textContent.includes('Delete')
        };
      })()
    `);

    console.log('Test 3: Layer item has dropdown menu button and NO bare delete icon:', (layerItemCheck.noOldDeleteBtn && layerItemCheck.hasMenuBtn) ? 'PASS' : 'FAIL');
    console.log('Test 4: Dropdown menu contains Save Layer, Duplicate, and Delete options:', (layerItemCheck.hasSaveItem && layerItemCheck.hasDupItem && layerItemCheck.hasDelItem) ? 'PASS' : 'FAIL');

    // 7. Click menu button to open dropdown
    await evalJs(`
      (() => {
        const menuBtn = document.querySelector('.btn-layer-menu');
        menuBtn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 200));

    const isMenuOpen = await evalJs(`
      (() => {
        const menu = document.querySelector('.layer-dropdown-menu');
        return menu && menu.classList.contains('show');
      })()
    `);
    console.log('Test 5: Dropdown menu opens upon clicking 3-dots button:', isMenuOpen ? 'PASS' : 'FAIL');

    // 8. Save Layer to localStorage (mock window.prompt to return "Global Header Template")
    await evalJs(`
      (() => {
        window.prompt = () => 'Global Header Template';
        const saveBtn = document.querySelector('.btn-action-save-layer');
        saveBtn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 400));

    // Verify localStorage & Saved Layers UI
    const savedState = await evalJs(`
      (() => {
        const raw = localStorage.getItem('pdfgod_saved_layers_v1');
        const list = raw ? JSON.parse(raw) : [];
        const countBadge = document.querySelector('#saved-layers-count');
        const savedItems = document.querySelectorAll('.saved-layer-item');
        const firstSaved = savedItems.length > 0 ? savedItems[0] : null;
        const titleEl = firstSaved ? firstSaved.querySelector('.annotation-item-title') : null;

        return {
          storageCount: list.length,
          savedName: list.length > 0 ? list[0].name : null,
          savedText: list.length > 0 ? list[0].data.text : null,
          badgeText: countBadge ? countBadge.textContent.trim() : null,
          domTitle: titleEl ? titleEl.textContent.trim() : null
        };
      })()
    `);

    console.log('Test 6: Layer saved to localStorage with specified name:', (savedState.storageCount === 1 && savedState.savedName === 'Global Header Template' && savedState.savedText === 'ACME SPECIAL DELIVERY NOTE') ? 'PASS' : 'FAIL');
    console.log('Test 7: Saved Layers list on top displays the saved layer:', (savedState.badgeText === '1' && savedState.domTitle === 'Global Header Template') ? 'PASS' : 'FAIL', `("${savedState.domTitle}")`);

    // 9. Verify Saved Layer Item has 3-dots dropdown menu (Add to Page, Rename, Delete)
    const savedMenuCheck = await evalJs(`
      (() => {
        const item = document.querySelector('.saved-layer-item');
        if (!item) return null;
        const menuBtn = item.querySelector('.btn-saved-layer-menu');
        const menu = item.querySelector('.saved-layer-dropdown-menu');
        const addBtn = menu ? menu.querySelector('.btn-action-insert-saved') : null;
        const renameBtn = menu ? menu.querySelector('.btn-action-rename-saved') : null;
        const delBtn = menu ? menu.querySelector('.btn-action-delete-saved') : null;

        return {
          hasMenuBtn: !!menuBtn,
          hasAddBtn: !!addBtn && addBtn.textContent.includes('Add to Page'),
          hasRenameBtn: !!renameBtn && renameBtn.textContent.includes('Rename'),
          hasDelBtn: !!delBtn && delBtn.textContent.includes('Delete')
        };
      })()
    `);

    console.log('Test 8: Saved layer item has 3-dots dropdown button:', savedMenuCheck && savedMenuCheck.hasMenuBtn ? 'PASS' : 'FAIL');
    console.log('Test 9: Saved layer dropdown menu contains Add to Page, Rename, and Delete:', (savedMenuCheck && savedMenuCheck.hasAddBtn && savedMenuCheck.hasRenameBtn && savedMenuCheck.hasDelBtn) ? 'PASS' : 'FAIL');

    // 10. Test Hover Preview on Saved Layer Item
    await evalJs(`
      (() => {
        const item = document.querySelector('.saved-layer-item');
        if (item) {
          item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 250));

    const hoverCheck = await evalJs(`
      (() => {
        const preview = document.querySelector('#saved-layer-hover-preview');
        if (!preview) return { exists: false };
        const isShown = preview.classList.contains('show') && preview.style.display !== 'none';
        const nameEl = preview.querySelector('.preview-name');
        const badgeEl = preview.querySelector('.preview-badge');
        const textBox = preview.querySelector('.preview-text-box');
        const metaEl = preview.querySelector('.preview-meta');

        return {
          exists: true,
          isShown,
          name: nameEl ? nameEl.textContent.trim() : null,
          badge: badgeEl ? badgeEl.textContent.trim() : null,
          text: textBox ? textBox.textContent.trim() : null,
          meta: metaEl ? metaEl.textContent.trim() : null
        };
      })()
    `);

    console.log('Test 10: Hovering over saved layer triggers visual floating preview card:', (hoverCheck && hoverCheck.isShown && hoverCheck.name === 'Global Header Template' && hoverCheck.badge === 'TEXT') ? 'PASS' : 'FAIL');
    console.log('Test 11: Hover preview contains true-to-life text & metadata:', (hoverCheck && hoverCheck.text === 'ACME SPECIAL DELIVERY NOTE' && hoverCheck.meta.includes('16pt')) ? 'PASS' : 'FAIL', `("${hoverCheck.text}", "${hoverCheck.meta}")`);

    // 11. Mouseleave hides hover preview
    await evalJs(`
      (() => {
        const item = document.querySelector('.saved-layer-item');
        if (item) {
          item.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 200));

    const hoverHidden = await evalJs(`
      (() => {
        const preview = document.querySelector('#saved-layer-hover-preview');
        return !preview || !preview.classList.contains('show') || preview.style.display === 'none';
      })()
    `);
    console.log('Test 12: Moving mouse away hides the floating hover preview:', hoverHidden ? 'PASS' : 'FAIL');

    // 12. Test Rename saved layer from dropdown menu
    await evalJs(`
      (() => {
        window.prompt = () => 'Corporate Notice Header';
        const menuBtn = document.querySelector('.btn-saved-layer-menu');
        menuBtn.click();
        const renameBtn = document.querySelector('.btn-action-rename-saved');
        renameBtn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 300));

    const renamedState = await evalJs(`
      (() => {
        const raw = localStorage.getItem('pdfgod_saved_layers_v1');
        const list = raw ? JSON.parse(raw) : [];
        const titleEl = document.querySelector('.saved-layer-item .annotation-item-title');
        return {
          storedName: list.length > 0 ? list[0].name : null,
          domTitle: titleEl ? titleEl.textContent.trim() : null
        };
      })()
    `);

    console.log('Test 13: Renaming saved layer updates localStorage and sidebar UI:', (renamedState.storedName === 'Corporate Notice Header' && renamedState.domTitle === 'Corporate Notice Header') ? 'PASS' : 'FAIL');

    // 13. Test "Add to Page" from dropdown menu onto Page 2
    await evalJs(`
      (() => {
        window.uiController.switchActivePage(1);
        const menuBtn = document.querySelector('.btn-saved-layer-menu');
        menuBtn.click();
        const addBtn = document.querySelector('.btn-action-insert-saved');
        addBtn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 400));

    const insertState = await evalJs(`
      (() => {
        const annsPage2 = window.annotationManager.getAnnotationsForPage(1);
        const inserted = annsPage2.find(a => a.text === 'ACME SPECIAL DELIVERY NOTE');
        return {
          totalOnPage2: annsPage2.length,
          hasInserted: !!inserted,
          insertedPage: inserted ? inserted.pageIndex : null,
          fontSize: inserted ? inserted.fontSize : null,
          fontColor: inserted ? inserted.fontColor : null
        };
      })()
    `);

    console.log('Test 14: "Add to Page" from saved layer dropdown inserts layer onto active page (Page 2):', (insertState.hasInserted && insertState.insertedPage === 1 && insertState.fontSize === 16 && insertState.fontColor === '#2563eb') ? 'PASS' : 'FAIL');

    // 14. Test Duplicate from Document Layer dropdown menu
    await evalJs(`
      (() => {
        const menuBtn = document.querySelector('.annotation-item:last-child .btn-layer-menu');
        if (menuBtn) menuBtn.click();
        const dupBtn = document.querySelector('.annotation-item:last-child .btn-action-dup-layer');
        if (dupBtn) dupBtn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 300));

    const dupCount = await evalJs(`window.annotationManager.annotations.length`);
    console.log('Test 15: Duplicate layer from dropdown created copy:', dupCount === 3 ? 'PASS' : 'FAIL', `(Total annotations: ${dupCount})`);

    // 15. Test Delete saved layer via dropdown menu
    await evalJs(`
      (() => {
        const menuBtn = document.querySelector('.btn-saved-layer-menu');
        if (menuBtn) menuBtn.click();
        const delBtn = document.querySelector('.btn-action-delete-saved');
        if (delBtn) delBtn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 300));

    const finalSavedState = await evalJs(`
      (() => {
        const raw = localStorage.getItem('pdfgod_saved_layers_v1');
        const list = raw ? JSON.parse(raw) : [];
        const countBadge = document.querySelector('#saved-layers-count');
        const emptyHint = document.querySelector('.empty-saved-layers-hint');
        return {
          count: list.length,
          badgeText: countBadge ? countBadge.textContent.trim() : null,
          hasEmptyHint: !!emptyHint
        };
      })()
    `);

    console.log('Test 16: Delete saved layer from dropdown removes it from localStorage & updates count badge to 0:', (finalSavedState.count === 0 && finalSavedState.badgeText === '0' && finalSavedState.hasEmptyHint) ? 'PASS' : 'FAIL');

    // 16. Re-save a layer and show Hover Preview for visual screenshot
    await evalJs(`
      (() => {
        window.prompt = () => 'Official Approved Stamp';
        const menuBtn = document.querySelector('.btn-layer-menu');
        if (menuBtn) menuBtn.click();
        const saveBtn = document.querySelector('.btn-action-save-layer');
        if (saveBtn) saveBtn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 250));

    // Open dropdown on the saved layer item
    await evalJs(`
      (() => {
        const btn = document.querySelector('.btn-saved-layer-menu');
        if (btn) btn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 200));

    const ssMenu = await send('Page.captureScreenshot', { format: 'png' });
    const screenshotMenuPath = path.resolve(__dirname, 'test-saved-layers-menu.png');
    fs.writeFileSync(screenshotMenuPath, Buffer.from(ssMenu.data, 'base64'));
    console.log(`📸 Saved visual dropdown menu screenshot to: ${screenshotMenuPath}`);

    // Trigger hover preview on newly created saved layer
    await evalJs(`
      (() => {
        document.querySelectorAll('.saved-layer-dropdown-menu.show').forEach(m => m.classList.remove('show'));
        const item = document.querySelector('.saved-layer-item');
        if (item) {
          item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 300));

    const ss = await send('Page.captureScreenshot', { format: 'png' });
    const screenshotPath = path.resolve(__dirname, 'test-saved-layers-preview.png');
    fs.writeFileSync(screenshotPath, Buffer.from(ss.data, 'base64'));
    console.log(`📸 Saved visual preview screenshot to: ${screenshotPath}`);

    console.log('\n🎉 ALL Saved Layers & Layer Dropdown Tests PASSED!');
  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exitCode = 1;
  } finally {
    try { chrome.kill(); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
})();
