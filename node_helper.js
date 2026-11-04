const NodeHelper = require("node_helper");
const { execFile } = require("node:child_process");
const path = require("node:path");

// Runtime PDF processing is embedded here so no standalone converter is required.
// PyMuPDF supplies the vector drawing information used by the calendar parser.
const PYTHON_SCRIPT = String.raw`import argparse
import csv
from datetime import date, datetime, timezone
import json
import sys
from pathlib import Path
from urllib.parse import quote
import re
import os
import tempfile
import requests
import pymupdf as fitz

ORGANIZATION_ID = '464debc4-4de1-4bc7-bd45-614c8eca81e9'
API_URL = 'https://selfserviceapi.waste2x.dk/api/PDFCalendar/GetPDFCalendar/{address_id}/{year}'
SEARCH_URL = 'https://selfserviceapi.waste2x.dk/api/Customer/Customer/SearchCustomer/{query}'
COLUMNS = ['WeekStarting','Farligt','Have','Stor','Pap','Papir','Plast','Drikke','Glas','Metal','Rest','Mad']
# Fill-color of background rectangles; these are *PDF-vector* colors, not OCR.
COLORS = {
    (0.039, 0.404, 0.220): ('Have',),
    (0.710, 0.604, 0.396): ('Pap',),
    (0.067, 0.067, 0.067): ('Stor',),
    (0.078, 0.522, 0.749): ('Papir','Plast','Drikke'),
    (0.333, 0.420, 0.463): ('Glas','Metal'),
    (0.051, 0.659, 0.349): ('Rest','Mad'),
}

def color_close(color, target, tol=0.012):
    return len(color) == len(target) and all(abs(a-b) < tol for a,b in zip(color, target))

def request_headers(accept):
    return {
        'Accept': accept,
        'organizationid': ORGANIZATION_ID,
        'Origin': 'https://selvbetjening.waste2x.dk',
        'Referer': 'https://selvbetjening.waste2x.dk/',
    }


def normalize(s):
    return ' '.join(s.casefold().split())


def lookup_customer_id(address, postal_code=None):
    """Return one unambiguous Waste2x customerId for the requested address.

    The address query uses the '%' wildcard observed in the website's XHR.
    Never select the first partial match without checking its full address.
    """
    query_address = address.strip()
    if not query_address:
        raise ValueError('Address must not be empty')
    # The API's customer search is for an address string, not a numeric ID.
    # If user supplied "Example Street 123, 0000 Example City", search the street part and
    # check the full location in the result.
    street = query_address.split(',', 1)[0].strip()
    query = quote(street + '%', safe='')
    response = requests.get(SEARCH_URL.format(query=query),
                            headers=request_headers('application/json'), timeout=40)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or not isinstance(payload.get('items'), list):
        raise ValueError('Unexpected Waste2x address search response')

    expected_street = normalize(street)
    expected_full = normalize(query_address)
    postcode = (postal_code or '').strip()
    matches = []
    for item in payload['items']:
        if not isinstance(item, dict):
            continue
        location = item.get('location')
        customer_id = item.get('customerId')
        if not isinstance(location, str) or not isinstance(customer_id, int):
            continue
        location_norm = normalize(location)
        # Exact comparison before the first comma prevents matching 159A/159B.
        if normalize(location.split(',', 1)[0]) != expected_street:
            continue
        if ',' in query_address and location_norm != expected_full:
            continue
        if postcode and not re.search(r'\b' + re.escape(postcode) + r'\b', location):
            continue
        matches.append((customer_id, location))

    unique = list(dict.fromkeys(matches))
    if len(unique) != 1:
        description = 'no exact match' if not unique else f'{len(unique)} matches'
        raise ValueError(
            f'Address lookup: {description} for {address!r}. '
            'Check the address and postal code.'
        )
    return unique[0]


def download_pdf(year, address_id):
    url = API_URL.format(address_id=address_id, year=year)
    response = requests.get(url, headers=request_headers('application/pdf'), timeout=40)
    response.raise_for_status()
    if not response.content.startswith(b'%PDF-'):
        raise ValueError('Waste2x did not return a PDF')
    return response.content

def extract_rows(pdf_bytes, year, expected_address=None):
    with fitz.open(stream=pdf_bytes, filetype='pdf') as doc:
        if len(doc) != 2:
            raise ValueError('Unexpected page count (expected 2)')
        if expected_address:
            # Compare normalized text without depending on capitalization or whitespace.
            actual = ' '.join(doc[0].get_text().casefold().split())
            expected = ' '.join(expected_address.casefold().split())
            if expected not in actual:
                raise ValueError(f'PDF address does not match --expected-address: {expected_address!r}')
        data = {}
        for page_number, page in enumerate(doc):
            if abs(page.rect.width-842)>3 or abs(page.rect.height-595)>3:
                raise ValueError('PDF page size changed; layout review required')
            footer = page.get_text(clip=fitz.Rect(0, 544, page.rect.width, page.rect.height))
            footer_years = set(re.findall(r'\b20\d{2}\b', footer))
            if footer_years != {str(year)}:
                raise ValueError(f'PDF calendar year does not match requested year {year}')
            for drawing in page.get_drawings():
                c = drawing['fill']
                r = drawing['rect']
                if c is None or not (110 < r.y0 < 544):
                    continue
                # Icons appear as solid 6-12 pt wide, 6-12 pt tall background rectangles.
                if not (5.8 <= r.width <= 14.2 and 5.8 <= r.height <= 14.2):
                    continue
                keys = set()
                for color, columns in COLORS.items():
                    if color_close(c, color):
                        keys.update(columns)
                if not keys:
                    continue
                month_index = round((r.x0 - 117.0) / 134.3)
                # use full page's 6 fixed month columns instead: right-edge icons x around
                # 115, 250, 384, 518, 653, 787. Small offsets for overlapping icons.
                if not (0 <= month_index < 6):
                    continue
                expected_right_icon_x = 118.3 + 134.33 * month_index
                if abs(r.x0 - expected_right_icon_x) > 26:
                    continue
                row_index = round((r.y0 - 116.7) / 13.8)
                if not (0 <= row_index < 31):
                    continue
                if abs(r.y0 - (116.7+row_index*13.8)) > 1.0:
                    continue
                month = page_number * 6 + month_index + 1
                try:
                    day = date(year, month, row_index+1)
                except ValueError:
                    raise ValueError(f'Icon found on invalid date: {month}/{row_index+1}')
                data.setdefault(day,set()).update(keys)
        if len(data) < 30:
            raise ValueError(f'Only {len(data)} dates found. PDF layout may have changed')
        if not any('Have' in types for types in data.values()):
            raise ValueError('No garden waste dates found')
        rows = []
        for day, types in sorted(data.items()):
            rows.append({col: (day.strftime('%m/%d/%y') if col=='WeekStarting' else int(col in types)) for col in COLUMNS})
        return rows

def write_atomic(rows, output, reference_year):
    # Keep at most the selected calendar year and its preceding year.
    # Parse the two-digit CSV year explicitly within the supported 2000s.
    retained = {}
    for row in rows:
        month, day, short_year = map(int, row['WeekStarting'].split('/'))
        if not 0 <= short_year <= 99:
            raise ValueError('Invalid two-digit CSV year')
        collection_date = date(2000 + short_year, month, day)
        if reference_year - 1 <= collection_date.year <= reference_year:
            retained[collection_date] = row
    rows = [retained[day] for day in sorted(retained)]
    if not rows:
        raise ValueError('No collection dates within the two-year retention window')
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.waste-', suffix='.csv', dir=output.parent)
    try:
        with os.fdopen(fd,'w',newline='',encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=COLUMNS, lineterminator='\n')
            writer.writeheader()
            writer.writerows(rows)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, output)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return len(rows)

def main():
    parser=argparse.ArgumentParser(description='Waste2x → MagicMirror² CSV')
    parser.add_argument('--year',type=int,default=date.today().year)
    parser.add_argument('--address', required=True, help='Exact street address')
    parser.add_argument('--postal-code', required=True, help='Four-digit postal code')
    parser.add_argument('--expected-address',help='Verify that the PDF contains this address')
    parser.add_argument('--output',type=Path,default=Path('collections.csv'))
    parser.add_argument('--organization-id', default=ORGANIZATION_ID)
    parser.add_argument('--json', action='store_true', help='Report successful conversion as JSON')
    args=parser.parse_args()
    if not 2000 <= args.year <= 2099:
        parser.error('--year must be between 2000 and 2099 (CSV uses two-digit years)')
    if not args.address.strip() or not re.fullmatch(r'\d{4}', args.postal_code.strip()):
        parser.error('A nonempty address and a four-digit postal code are required')
    # Keep the existing request functions compatible with standalone imports.
    globals()['ORGANIZATION_ID'] = args.organization_id
    try:
        address_id, matched_location = lookup_customer_id(args.address, args.postal_code)
        print(f'Address found: {matched_location} (customerId={address_id})', file=sys.stderr)
        expected_address = matched_location
        pdf_bytes = download_pdf(args.year, address_id)
        downloaded_at = datetime.now(timezone.utc).isoformat()
        rows=extract_rows(pdf_bytes,args.year,expected_address)
        if args.expected_address:
            extract_rows(pdf_bytes, args.year, args.expected_address)
        date_count = write_atomic(rows, args.output, args.year)
    except Exception as error:
        parser.exit(1, f'Update failed: {error}\n')
    if args.json:
        print(json.dumps({'dateCount': date_count, 'downloadedAt': downloaded_at, 'year': args.year}))
    else:
        print(f'{date_count} dates written to {args.output}')

if __name__=='__main__':
    main()
`;

module.exports = NodeHelper.create({
  start: function () { this.running = false; },

  socketNotificationReceived: function (notification, config) {
    if (notification !== "MYGARBAGEDATE_UPDATE") return;
    const automaticYear = config.year == null || config.year === "auto";
    const year = automaticYear ? new Date().getFullYear() : Number(config.year);
    const report = (ok, error, result = {}) => this.sendSocketNotification("MYGARBAGEDATE_STATUS", {
      instanceId: config.instanceId, year, ok, error, ...result
    });
    if (this.running) { report(false, "An update is already running; retrying at the next interval"); return; }
    const address = config.address ?? "";
    const postalCode = config.postalCode ?? "";
    const expectedAddress = config.expectedAddress ?? "";
    if (!Number.isInteger(year) || year < 2000 || year > 2099 ||
        typeof address !== "string" || typeof postalCode !== "string" || typeof expectedAddress !== "string" ||
        !address.trim() || !/^\d{4}$/.test(postalCode.trim()) ||
        typeof config.organizationId !== "string" || !config.organizationId || typeof config.outputFile !== "string" || !config.outputFile ||
        typeof config.pythonPath !== "string" || !config.pythonPath) {
      report(false, "Invalid configuration: address and a four-digit postalCode string are required"); return;
    }
    const args = ["-c", PYTHON_SCRIPT,
      "--year", String(year),
      "--organization-id", config.organizationId,
      "--output", path.resolve(this.path, config.outputFile), "--json"
    ];
    args.push("--address", address.trim(), "--postal-code", postalCode.trim());
    if (expectedAddress.trim()) args.push("--expected-address", expectedAddress.trim());
    this.running = true;
    execFile(config.pythonPath, args, { cwd: this.path, timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      this.running = false;
      if (error) {
        const message = (stderr || error.message).trim().slice(0, 2000);
        console.error("[MMM-MyGarbageDate-BODK]", message);
        report(false, message);
      } else {
        try {
          const result = JSON.parse(stdout);
          if (!Number.isInteger(result.dateCount) || result.dateCount < 30 || !Number.isFinite(Date.parse(result.downloadedAt))) {
            throw new Error("Invalid conversion result");
          }
          console.log("[MMM-MyGarbageDate-BODK]", stdout.trim());
          report(true, undefined, { dateCount: result.dateCount, downloadedAt: result.downloadedAt });
        } catch (parseError) {
          console.error("[MMM-MyGarbageDate-BODK]", parseError.message);
          report(false, "Could not read conversion result");
        }
      }
    });
  }
});
