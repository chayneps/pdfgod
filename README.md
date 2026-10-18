# 📄 PDFGod — In-Browser PDF Editor (Single-File Web App)

[![Run Live App](https://img.shields.io/badge/🚀_Launch_Live_App-chayneps.github.io%2Fpdfgod-2563eb?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chayneps.github.io/pdfgod/)
[![Single File HTML](https://img.shields.io/badge/📦_Standalone-pdfgod.html-10b981?style=for-the-badge)](https://chayneps.github.io/pdfgod/pdfgod.html)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

> ### 🌐 [Click Here to Run PDFGod Instantly in Your Browser](https://chayneps.github.io/pdfgod/)
> No installation, no backend, no extensions. Runs 100% locally and privately in any modern browser!

A fast, private, and full-featured client-side web application to edit, annotate, sign, redact, and manipulate PDF documents directly in the browser.

> **📦 100% Self-Contained Single File**: The entire application (all UI, CSS, icons, PDF.js, PDF-Lib, and Web Worker) is embedded into **`pdfgod.html`**. You can open it offline, transfer it anywhere, or host it statically with zero build steps and zero dependencies!

---

## ✨ Features & Capabilities

### 🔒 1. 100% Client-Side & Private
- All processing, rendering, and vector modifications happen strictly inside your browser using **HTML5 Canvas**, **PDF.js**, and **PDF-Lib**.
- Works completely **offline** without any internet connection.
- No documents, signatures, or confidential data ever leave your device.

### ✍️ 2. Comprehensive Editing & Annotation Tools
- **Text Insertion & Inline Editing**:
  - Click anywhere on any page to type and place text.
  - Choose from standard fonts (Helvetica, Times Roman, Courier, Arial, Georgia).
  - Configurable font size (8pt to 72pt), color swatches + custom color picker, bold (`B`), italic (`I`).
  - **Clean & Unobtrusive Text Boxes**: No bulky floating bars or headers covering adjacent lines. Tight lines of text remain 100% visible and accessible.
  - **Keyboard Arrow Key Nudging**: While editing or selecting a text box, use the **Arrow keys (Up / Down / Left / Right)** to move the text box by **5px** ("a bit big move"), or hold **<kbd>Shift</kbd> + Arrow keys** for a **1px micro-move** for pixel-perfect line alignment without scrolling the page.
  - **Shift-Select & Move Together**: Hold **<kbd>Shift</kbd>** and click multiple text boxes to select a group. Once selected:
    - **Drag Together**: Dragging any selected text box or its border moves all selected boxes together in real time.
    - **Arrow Nudge Together**: Pressing **Arrow keys** nudges all selected boxes together by **5px**, and **<kbd>Shift</kbd> + Arrow keys** micro-nudges all of them together by **1px**.
  - **Copy & Paste (<kbd>Ctrl/Cmd+C</kbd> / <kbd>Ctrl/Cmd+V</kbd>)**:
    - Press **<kbd>Ctrl+C</kbd> / <kbd>Cmd+C</kbd>** to copy selected text box(es). If multiple text boxes are selected, it copies all of them.
    - Press **<kbd>Ctrl+V</kbd> / <kbd>Cmd+V</kbd>** to paste them onto the active page, preserving their exact relative positions, styling, and fonts.
    - Also copies plain text to the system clipboard for pasting into other apps.
  - **Click Outside to Unselect**: Click anywhere outside the text boxes (on empty page canvas, another page, or on the gray workspace background) to immediately unselect all selected text boxes and commit your edits cleanly without creating unwanted new text boxes.
  - **Group Actions**: Pressing <kbd>Delete</kbd> or <kbd>Backspace</kbd> deletes the entire selected group.
- **Digital Signatures**:
  - **Draw**: Natural, smooth signature pad with ink color options (Dark Slate, Navy Blue, Deep Red) and clear button.
  - **Type**: Type your name and choose from authentic cursive handwriting styles.
  - **Upload**: Import an existing signature image (PNG, JPG, SVG) with transparent background support.
- **Freehand Pen & Highlighter**:
  - Pressure-smooth freehand pen drawing with adjustable stroke width (1px to 16px) and color palette.
  - Semi-transparent highlighter brush (`multiply` blend mode) to mark important text without obscuring it.
- **Vector Shapes**:
  - Rectangles, Circles / Ellipses, Straight Lines, and Directional Arrows.
  - Customizable border colors, fill colors (transparent, white, light tints), stroke thickness, and opacity.
- **Form Filling Stamps**:
  - One-click Checkmarks (**✓**) and Crosses (**✗**) to quickly fill checkboxes and approval boxes on forms.
- **Redaction & Whiteout**:
  - **Whiteout**: Erase/cover unwanted text or errors cleanly with white fill.
  - **Blackout**: Redact confidential numbers, account IDs, or sensitive clauses with solid black bars.
- **Image & Stamp Placement**:
  - Upload logos, official stamps, badges, or diagram images and place them anywhere on the document.

### 📑 3. Page Organization & Multi-Column Viewing
- **Multi-Column Layout Views (1, 2, or 3 Pages in a Row)**:
  - Toggle between **1 in a row** (standard vertical reading), **2 in a row** (side-by-side spread), or **3 in a row** (multi-column overview) via the dropdown beside the page indicator or using shortcuts (<kbd>Alt+1</kbd>, <kbd>Alt+2</kbd>, <kbd>Alt+3</kbd>).
- **Click & Shift-Click Multi-Page Range Selection**:
  - Select individual pages or click and **<kbd>Shift</kbd> + click** to select a contiguous block of pages across the document or sidebar thumbnails.
  - Interactive checkboxes (`☑`) on each page header bar and synchronized glowing selection rings indicate selected pages.
  - **<kbd>Ctrl/Cmd</kbd> + click** toggles individual pages in or out of the selection.
- **Drag-and-Drop Page Rearranging**:
  - Drag any selected page header bar or thumbnail card to rearrange the entire selected range as a single block into any target position.
  - Dynamic drop insertion lines and tooltips provide real-time guidance (e.g. `Move 3 pages (Pages 1–3) to position 5`).
- **Drag-and-Drop External PDF Files**:
  - Drag one or more PDF files directly from your desktop or file manager into the document canvas or between thumbnail cards to insert pages at that exact location.
- **Sidebar Thumbnails**: Visual mini-previews of all pages with page numbers and quick actions.
- **Rotate, Duplicate, & Delete**: Rotate 90°, clone, or delete single pages or entire multi-page selections in bulk.
- **Add Blank Pages**: Insert clean white pages anywhere in the document.

### 💾 4. Save & Export
- **Export to Excel (`.xlsx`)**:
  - Converts every PDF page to its own worksheet in a standard `.xlsx` workbook.
  - **100% Text Preservation**: Retains all original PDF text plus any user annotations without dropping headers, footers, or table contents.
  - **Vector Cell Borders**: Extracts vector lines and rectangles from the PDF and converts them directly into matching thin cell borders in Excel.
  - **Visual Column Alignment**: Aligns text items belonging to the same visual column across data rows.
- **Save Document (`pdf-lib`)**:
  - Saves directly to the document file name specified in the top header.
  - Prompts for replacement confirmation if a file with that name exists, with the option to rename before saving.
  - Preserves original PDF text vectors, metadata, and layers while embedding all annotations, signatures, and drawings.
- **Save As...**:
  - Accessible via the dropdown menu right beside the Save button to save under a new file name.
- **Refresh & Navigation Protection (`beforeunload`)**:
  - Native browser confirmation prompt warns against accidental tab closures or refreshes when unsaved changes exist.
- **Export Page as Image**: Download current page as a 2x high-resolution PNG.
- **Print**: Direct browser print integration.

### ⌨️ 5. Undo / Redo & Keyboard Shortcuts
- Full undo/redo history stack (`Ctrl+Z` / `Ctrl+Y`).
- Interactive selection bounding box with 8 corner/edge resize handles and drag-to-move.
- Keyboard shortcuts for all major tools:

| Shortcut | Action |
| :--- | :--- |
| <kbd>V</kbd> | Select / Move / Resize Tool |
| <kbd>H</kbd> | Hand / Pan Viewport Tool |
| <kbd>T</kbd> | Add Text Tool |
| <kbd>Shift</kbd> + Click Text | Multi-Select / Toggle Multiple Text Boxes |
| <kbd>Arrow Keys</kbd> (in text) | Nudge Selected Text Box(es) by 5px |
| <kbd>Shift</kbd> + <kbd>Arrow Keys</kbd> (in text) | Micro-Nudge Selected Text Box(es) by 1px |
| <kbd>P</kbd> | Freehand Pen Drawing |
| <kbd>Shift</kbd> + <kbd>H</kbd> | Highlighter Tool |
| <kbd>R</kbd> | Whiteout / Redaction Tool |
| <kbd>G</kbd> | Digital Signature Modal |
| <kbd>Del</kbd> / <kbd>Backspace</kbd> | Delete Selected Element(s) |
| <kbd>Ctrl</kbd> / <kbd>Cmd</kbd> + <kbd>C</kbd> | Copy Selected Element(s) |
| <kbd>Ctrl</kbd> / <kbd>Cmd</kbd> + <kbd>V</kbd> | Paste Copied Element(s) |
| <kbd>Ctrl</kbd> / <kbd>Cmd</kbd> + <kbd>D</kbd> | Duplicate Selected Element(s) |
| <kbd>Ctrl</kbd> / <kbd>Cmd</kbd> + <kbd>Z</kbd> | Undo |
| <kbd>Ctrl</kbd> / <kbd>Cmd</kbd> + <kbd>Y</kbd> | Redo |
| <kbd>Ctrl</kbd> / <kbd>Cmd</kbd> + <kbd>S</kbd> | Save PDF Document |
| <kbd>+</kbd> / <kbd>-</kbd> | Zoom In / Out |
| <kbd>?</kbd> | Show Keyboard Shortcuts Modal |

---

## 🚀 How to Run

### Option 1: Run Instantly in Browser (Live Web App)
You can launch and use PDFGod directly in your browser without installing anything:
- **Main App**: **[https://chayneps.github.io/pdfgod/](https://chayneps.github.io/pdfgod/)**
- **Single-File URL**: **[https://chayneps.github.io/pdfgod/pdfgod.html](https://chayneps.github.io/pdfgod/pdfgod.html)**

### Option 2: Run Completely Offline (Single-File HTML)
Download or clone the repository and double-click `pdfgod.html` (or run in terminal):
```bash
open pdfgod.html
```
The app runs 100% offline in Chrome, Safari, Firefox, or Edge with zero dependencies!

### Option 3: Using the Built-In Node Server
```bash
npm start
# Or: node server.js
```
Then navigate to: **`http://localhost:3000`**

### Option 4: Using Python
```bash
python3 -m http.server 3000
```
Then navigate to: **`http://localhost:3000`**

---

## 📁 Project Structure

```
keen-brahmagupta/
├── pdfgod.html             # Main single-page web app
├── server.js               # Zero-dependency local development HTTP server
├── package.json            # NPM scripts & configuration
├── css/
│   ├── main.css            # Base styles, color system, layout, reset, toasts
│   ├── toolbar.css         # Top toolbars, tool buttons, properties bar
│   ├── sidebar.css         # Left sidebar, thumbnail cards, layers list
│   ├── canvas.css          # Viewport, page render, annotation overlay, selection handles
│   └── modals.css          # Native <dialog> styles (Signature pad, shortcuts, save-as)
├── js/
│   ├── app.js              # Application coordinator & global shortcuts
│   ├── pdf-engine.js       # PDF.js rendering & PDF-Lib vector export
│   ├── annotation-manager.js # Annotation state store & undo/redo history
│   ├── canvas-controller.js# Drawing, shape drafting, text editing, dragging, resizing & arrow nudging
│   ├── signature-pad.js    # Signature modal (Draw, Type cursive, Upload)
│   └── ui-controller.js    # UI bindings, zoom, thumbnail sync, save/save-as modals
└── vendor/
    ├── pdf.min.js          # Mozilla PDF.js v3.11
    ├── pdf.worker.min.js   # PDF.js Web Worker
    └── pdf-lib.min.js      # PDF-Lib v1.17
```
