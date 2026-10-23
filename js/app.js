/**
 * Main Application Bootstrap
 * Initializes PDF Editor modules and global event listeners.
 */

document.addEventListener('DOMContentLoaded', () => {
  // 1. Initialize Core Models & Engines
  const annotationManager = new window.AnnotationManager();
  const pdfEngine = new window.PDFEngine();
  annotationManager.pdfEngine = pdfEngine;

  // 2. Viewport container
  const docContainer = document.querySelector('.document-container');
  const canvasController = new window.CanvasController(docContainer, annotationManager, pdfEngine);

  // 3. UI Controller
  const uiController = new window.UIController(pdfEngine, annotationManager, canvasController);
  window.uiController = uiController;
  window.annotationManager = annotationManager;
  window.pdfEngine = pdfEngine;
  window.canvasController = canvasController;

  // 4. Signature Dialog Controller
  const sigDialog = document.querySelector('#dialog-signature');
  const sigPadController = new window.SignaturePadController(sigDialog, annotationManager, canvasController);
  window.sigPadController = sigPadController;

  // 5. Ensure Favicon (SVG in HTML head + synchronous PNG fallback via Path2D)
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.scale(64 / 24, 64 / 24);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(new Path2D('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'));
    ctx.stroke(new Path2D('M14 2v6h6'));
    ctx.stroke(new Path2D('M10 13l2 2 4-4'));

    let pngLink = document.querySelector('link[rel="alternate icon"]');
    if (!pngLink) {
      pngLink = document.createElement('link');
      pngLink.rel = 'alternate icon';
      pngLink.type = 'image/png';
      document.head.appendChild(pngLink);
    }
    pngLink.href = canvas.toDataURL('image/png');
  } catch (err) {}

  // Global Dropdown Toggles
  document.addEventListener('click', (e) => {
    // If clicked inside dropdown toggle button
    const toggleBtn = e.target.closest('[data-dropdown-toggle]');
    if (toggleBtn) {
      const targetMenuId = toggleBtn.dataset.dropdownToggle;
      const targetMenu = document.getElementById(targetMenuId);
      if (targetMenu) {
        const isShown = targetMenu.classList.contains('show');
        // Close all dropdowns
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
        if (!isShown) targetMenu.classList.add('show');
        e.stopPropagation();
        return;
      }
    }

    // If clicked outside any dropdown menu, close all
    if (!e.target.closest('.dropdown-menu')) {
      document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
    }
  });

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    // Skip if typing in an input or textarea
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

    const isCtrlOrCmd = e.ctrlKey || e.metaKey;

    // Undo: Ctrl+Z
    if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      annotationManager.undo();
      return;
    }

    // Redo: Ctrl+Y or Ctrl+Shift+Z
    if ((isCtrlOrCmd && e.key.toLowerCase() === 'y') || (isCtrlOrCmd && e.shiftKey && e.key.toLowerCase() === 'z')) {
      e.preventDefault();
      annotationManager.redo();
      return;
    }

    // Save/Export: Ctrl+S
    if (isCtrlOrCmd && e.key.toLowerCase() === 's') {
      e.preventDefault();
      document.querySelector('#btn-export-pdf').click();
      return;
    }

    // Print Document: Ctrl+P / Cmd+P
    if (isCtrlOrCmd && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      if (uiController) {
        uiController.printDocument();
      } else {
        const btn = document.querySelector('#btn-print-header') || document.querySelector('#btn-print-doc');
        if (btn) btn.click();
      }
      return;
    }

    // Zoom shortcuts
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      document.querySelector('#btn-zoom-in').click();
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      document.querySelector('#btn-zoom-out').click();
      return;
    }

    // Tool switching shortcuts
    if (!isCtrlOrCmd && !e.altKey) {
      if (e.key.toLowerCase() === 'v') {
        const btn = document.querySelector('.tool-btn[data-tool="select"]');
        if (btn) btn.click();
      } else if (e.key.toLowerCase() === 'e') {
        const btn = document.querySelector('.tool-btn[data-tool="edit-pdf-text"]');
        if (btn) btn.click();
      } else if (e.key.toLowerCase() === 'h' && !e.shiftKey) {
        const btn = document.querySelector('.tool-btn[data-tool="pan"]');
        if (btn) btn.click();
      } else if (e.key.toLowerCase() === 'h' && e.shiftKey) {
        const btn = document.querySelector('.tool-btn[data-tool="highlighter"]');
        if (btn) btn.click();
      } else if (e.key.toLowerCase() === 't') {
        const btn = document.querySelector('.tool-btn[data-tool="text"]');
        if (btn) btn.click();
      } else if (e.key.toLowerCase() === 'p') {
        const btn = document.querySelector('.tool-btn[data-tool="draw"]');
        if (btn) btn.click();
      } else if (e.key.toLowerCase() === 'r') {
        const btn = document.querySelector('.tool-btn[data-tool="whiteout"]');
        if (btn) btn.click();
      } else if (e.key.toLowerCase() === 'g') {
        sigPadController.open();
      } else if (e.key === '?') {
        const shortcutsDialog = document.querySelector('#dialog-shortcuts');
        if (shortcutsDialog) shortcutsDialog.showModal();
      }
    }
  });

  console.log('PDFGod Web App initialized.');
});
