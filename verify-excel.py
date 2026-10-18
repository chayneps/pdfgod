import zipfile, sys, xml.etree.ElementTree as ET

xlsx_path = sys.argv[1]
z = zipfile.ZipFile(xlsx_path)

# Verify ZIP contents
namelist = z.namelist()
required_files = [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/sharedStrings.xml',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml'
]
for rf in required_files:
    assert rf in namelist, f"Missing required file in XLSX archive: {rf}"

# Verify Workbook Sheets
wb = ET.fromstring(z.read('xl/workbook.xml'))
sheets = [s.attrib['name'] for s in wb.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheet')]
assert sheets == ['Page 1', 'Page 2'], f"Expected ['Page 1', 'Page 2'], got {sheets}"
print(f"✓ Valid 2-sheet workbook: {sheets}")

# Verify Shared Strings & 100% Text Preservation
sst = ET.fromstring(z.read('xl/sharedStrings.xml'))
all_strings = set(t.text.strip() for t in sst.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t') if t.text)
raw_strings = [t.text if t.text else '' for t in sst.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t')]

must_have = [
    'GOODRICH TERMINAL 2012 LTD',
    'PO Box 16601, SURREY, BC V3W 2P5,',
    'Tel (604) 583-0006 Fax (604) 584-0006',
    'Page 1',
    'Page 2',
    'Delivery Slip',
    'No. 3042-1',
    'Customer',
    'PACIFIC CENTURION',  # Edited replacement text
    'CENTURION LUMBER LTD',
    'Ship To',
    'VANTERM',
    '3070 HENRY ROAD',
    'Chemainus, BC',
    'V0R 1K5',
    'CA',
    'Phone: 250-246-4791',
    '1300 Stewart Street',
    'VANCOUVER, BC CANADA',
    'V5L 4X5',
    'Phone:',
    'Ship Date',
    '10/07/2026',
    'Cust Ord No.',
    'CAN1033042',
    'Order No.',
    '487225',
    'Carrier',
    'GOODRICH',
    'Container No.',
    'TGHU6400249',
    'Seal No.',
    '117431',
    'Yard Location',
    'DYKE',
    'VGM',
    '28390',
    'Cargo Weight',
    '24500 kgs',
    'Tare Weight',
    '3890 kgs',
    'VGM Weight',
    '28390 kgs',
    'Booking Number',
    'Destination',
    'TOKYO',
    'Vessel',
    'EVER SHINE',
    'Voyage',
    'NWX010N19',
    'Total Pkgs',
    '12',
    'Summary',
    'Description',
    'Pcs',
    'FBM',
    'M3',
    'Summary Totals: (12 Tags)',
    'Package Details',
    'Tag No.',
    'Inv Grp.',
    "14'",
    "18'",
    "20'",
    'CLM',
    '154998',
    '154239',
    'T1523476',
    'T1523488',
    'T1523498',
    'T1523529',
    'T1523549',
    'T1525105',
    'T1525116',
    'T1516494',
    'T1516517',
    'T1512373',
    'T1515746',
    'T1526356',
    'Product Total:',
    'Product Pkg Tally:',
    "5/14'",
    "2/20'",
    "2/18' 1/20'",
    "1/18' 1/20'",
    'Report Totals:',
    'Report Pkg Tally:',
    "5/14' 3/18' 4/20'",
    '12 Tags',
    '% of Lengths:',
    "49.8/14' 18.1/18' 32.0/20'",
    "Driver 's",
    "Shipper's",
    "Receiver's",
    'Signature _________________________ Date __________',
    "Print Driver's Name ________________________________",
    'SPECIAL HANDLING NOTE',
]

missing = [s for s in must_have if s not in all_strings]
assert len(missing) == 0, f"Missing {len(missing)} required strings: {missing}"
print(f"✓ 100% of text items preserved ({len(must_have)} key strings verified including replacement text)")

# Verify Column Consistency Across Rows
tag_cols = set()
customer_cols = set()
ship_date_cols = set()
clm_cols = set()
order_no_cols = set()
ship_to_cols = set()
pcs_cols = set()
fbm_cols = set()
m3_cols = set()
tally_label_cols = set()
tally_val_cols = set()

customer_lines = {'PACIFIC CENTURION', 'CENTURION LUMBER LTD', '3070 HENRY ROAD', 'Chemainus, BC', 'V0R 1K5', 'Phone: 250-246-4791'}
ship_date_vals = {'10/07/2026', '487225', 'TGHU6400249', 'DYKE', '24500 kgs', '28390 kgs', 'TOKYO', 'NWX010N19'}
ship_to_lines = {'VANTERM', '1300 Stewart Street', 'VANCOUVER, BC CANADA', 'V5L 4X5', 'Phone:'}

for sheet_file in ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']:
    tree = ET.fromstring(z.read(sheet_file))
    rows = tree.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row')
    for r in rows:
        row_num = int(r.attrib['r'])
        cells = r.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c')
        for c in cells:
            ref = c.attrib['r']
            col = ''.join([ch for ch in ref if ch.isalpha()])
            val_el = c.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')
            txt = raw_strings[int(val_el.text)] if val_el is not None and val_el.text else ''
            
            if txt.startswith('T15'):
                tag_cols.add(col)
            if txt in customer_lines:
                customer_cols.add(col)
            if sheet_file.endswith('sheet1.xml') and row_num in range(12, 20) and txt in ship_date_vals:
                ship_date_cols.add(col)
            if txt == 'CLM':
                clm_cols.add(col)
            if txt in {'154998', '154239'}:
                order_no_cols.add(col)
            if txt in ship_to_lines and row_num in range(7, 12):
                ship_to_cols.add(col)
            if txt == 'Pcs' or (sheet_file.endswith('sheet1.xml') and row_num in range(21, 27) and col == 'G'):
                pcs_cols.add(col)
            if txt == 'FBM' or (sheet_file.endswith('sheet1.xml') and row_num in range(21, 27) and col == 'H'):
                fbm_cols.add(col)
            if txt == 'M3' or (sheet_file.endswith('sheet1.xml') and row_num in range(21, 27) and col == 'I'):
                m3_cols.add(col)
            if txt in {'Product Pkg Tally:', 'Report Pkg Tally:', '% of Lengths:'}:
                tally_label_cols.add(col)
            if txt in {"5/14'", "2/20'", "2/18' 1/20'", "1/18' 1/20'", "5/14' 3/18' 4/20'", "49.8/14' 18.1/18' 32.0/20'"}:
                tally_val_cols.add(col)

assert tag_cols == {'A'}, f"Tag No. columns mismatch: {tag_cols}"
assert customer_cols == {'B'}, f"Customer columns mismatch: {customer_cols}"
assert ship_date_cols == {'B'}, f"Ship Date columns mismatch: {ship_date_cols}"
assert clm_cols == {'C'}, f"CLM columns mismatch: {clm_cols}"
assert order_no_cols == {'D'}, f"Order No. columns mismatch: {order_no_cols}"
assert ship_to_cols == {'E'}, f"Ship To columns mismatch: {ship_to_cols}"
assert pcs_cols == {'G'}, f"Pcs columns mismatch: {pcs_cols}"
assert fbm_cols == {'H'}, f"FBM columns mismatch: {fbm_cols}"
assert m3_cols == {'I'}, f"M3 columns mismatch: {m3_cols}"
assert tally_label_cols == {'A'}, f"Tally labels mismatch: {tally_label_cols}"
assert tally_val_cols == {'B'}, f"Tally values mismatch: {tally_val_cols}"
print("✓ Column alignment verified: all items in visual columns map to the exact same column letter across rows")

# Verify Borders and Styles
styles = ET.fromstring(z.read('xl/styles.xml'))
borders = styles.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}border')
assert len(borders) == 16, f"Expected 16 border definitions in styles.xml, got {len(borders)}"

cellXfs = styles.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}cellXfs/{http://schemas.openxmlformats.org/spreadsheetml/2006/main}xf')
assert len(cellXfs) == 65, f"Expected 65 cell styles, got {len(cellXfs)}"

# Check Sheet 1 table box cells have bordered styles
sheet1 = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
table_box_cells = sheet1.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row[@r="30"]/{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c')
table_box_styles = [int(c.attrib.get('s', '0')) for c in table_box_cells]
bordered = [s for s in table_box_styles if s > 1]
assert len(bordered) > 0, "Table box cells missing border styles"
print(f"✓ Cell borders verified: styles.xml has 16 borders and Sheet 1 table rows apply cell border styles ({len(bordered)} bordered cells in Row 30)")

# Check Product Total row (Row 35) does NOT have vertical borders bleeding onto it
row35_cells = sheet1.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row[@r="35"]/{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c')
for c in row35_cells:
    s = int(c.attrib.get('s', '0'))
    if s > 0:
        border_mask = (s - 1) // 4
        # bit 2 (4) is left border, bit 3 (8) is right border
        assert (border_mask & 4) == 0, f"Cell {c.attrib['r']} has unexpected left border bleeding: mask={border_mask}"
        assert (border_mask & 8) == 0, f"Cell {c.attrib['r']} has unexpected right border bleeding: mask={border_mask}"
print("✓ Verified Product Total row has no bleeding vertical borders")

print("\n🎉 ALL AUTOMATED EXCEL EXPORT TESTS PASSED SUCCESSFULLY!")
