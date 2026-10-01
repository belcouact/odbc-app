"""Publish the script templates to Supabase and refresh their download page.

Usage (from the backend directory):

    .venv\\Scripts\\python.exe publish_templates.py
    .venv\\Scripts\\python.exe publish_templates.py --no-upload

Steps:
  1. collect every ``*.py`` in ``custom script/`` — the same folder the exe
     bundles, so the page and the app can never offer different scripts
  2. upload each one to the ``templates/`` folder of the Supabase bucket that
     already serves app updates, together with a generated ``index.html`` (a
     copy-button page for sharing) and a ``templates.json`` catalog
  3. upload each template's sample dashboard (``EXAMPLE_FILES``) to
     ``templates/examples/`` and name it in the catalog, so the app's template
     picker can link to a finished example of what the script produces
  4. read every public URL back and compare the bytes, so a link that would
     serve a stale copy is caught here instead of by a user
  5. write the same page and catalog to ``backend\\template_page.html`` and
     ``backend\\templates.json``

The catalog matters to the app: a public storage URL cannot list a folder, so
``templates.json`` is how ODBC Query discovers which scripts are published and
offers them in the Script page's template picker.  Their ``*.py`` files are read
straight from the bucket, so a template fix reaches every user without a new
build.

Supabase Storage rewrites ``text/html`` to ``text/plain`` with
``X-Content-Type-Options: nosniff`` (anti-phishing on the shared storage
domain), so the ``index.html`` in the bucket is a stored artifact, not a
viewable page.  ``template_page.html`` is the copy to open in a browser or drop
on an intranet share — its buttons fetch the published templates, so hosting
the page is a one-time job: a template fix only needs this script re-run.
That same rewrite is why the app fetches an example dashboard's bytes and opens
them as a Blob instead of linking to the object URL directly.

A template fix therefore ships by running this one command — no exe rebuild and
no version bump.  It reuses release.py's URL/key helpers, so the two publishers
cannot disagree about which bucket they write to; the service-role key comes
from the same two files (``%APPDATA%\\ODBCQueryApp\\supabase_key``, else
``backend\\.supabase_key``).  Without a key the page is written to
``template_page.html`` and the equivalent curl commands are printed.

The page and catalog are generated from the folder rather than edited by hand,
so neither can drift from the files they point at.
"""
import hashlib
import html
import json
import os
import re
import sys
import time
from pathlib import Path
from string import Template
from urllib.parse import quote

import release

ROOT = Path(__file__).resolve().parent
TEMPLATES_DIR = ROOT / "custom script"
PREFIX = "templates"
PAGE_NAME = f"{PREFIX}/index.html"
# Read by the app to discover what is published (a storage URL cannot list).
CATALOG_NAME = f"{PREFIX}/templates.json"
# The viewable copy of the page: Supabase serves the bucket's index.html as
# text/plain, so this file is the one to open in a browser or host on a share.
LOCAL_PAGE = ROOT / "template_page.html"
LOCAL_CATALOG = ROOT / "templates.json"

# Sample dashboards, published so the app's template picker can show what a
# script produces.  They are the copies the app opens from this bucket, so the
# example a user previews in the picker is the one the script generates today.
# They live here and NOT in ``frontend/public``: everything in that folder is
# copied into the build and bundled into the exe, which added ~19 MB of embedded
# ECharts to a single-file build that never reads these files at runtime.
EXAMPLES_DIR = ROOT / "templates" / "examples"
EXAMPLES_PREFIX = f"{PREFIX}/examples"
# Template stem -> sample dashboard file name.  A template with no entry (or
# whose file is missing) is published without an example link.
EXAMPLE_FILES = {
    "analyze-mesa-yield": "yield_trend_charts.html",
    "analyze-process-params": "Process_param_trend.html",
    "analyze-tautona-data": "Laminate_Analysis.html",
    "analyze-machine-uptime": "machine_up_down_timeline.html",
    "analyze-lims-raw-genealogy": "raw_item_statistical_report.html",
    "analyze-color-data": "color_data.html",
}

# Title, applicable data and the detail rows shown in the app's template table.
# A template that is not listed here is still published: it gets a title from its
# file name and a description from the first meaningful line of its docstring.
# ``requires`` / ``optional`` / ``outputs`` feed the expandable detail row, so
# they must match what the script actually reads and produces.
TEMPLATE_INFO = {
    "analyze-mesa-yield": {
        "title": "Mesa Yield",
        "applies_to": "Mesa yield data",
        "description": (
            "Groups the loaded rows by MAIN_GROUP_DESCRIPTION and charts allocated, "
            "issued and FMI totals per work order in a self-contained HTML page."
        ),
        "requires": [
            "MAIN_GROUP_DESCRIPTION",
            "MAIN_GROUP",
            "JDE_WO_NUMBER",
            "ALLOCATED_NET",
            "ISSUED_NET",
            "FMI_TOTAL",
            "PLANNED_YIELD",
            "FMI_GOOD",
            "OVERRUN",
            "FMI_DATE",
        ],
        "outputs": [
            "One self-contained HTML page, opened in your browser",
            "Allocated, issued and FMI totals charted per work order, grouped by "
            "MAIN_GROUP_DESCRIPTION",
            "Planned yield, good quantity and overrun rolled up per work order",
        ],
    },
    "analyze-process-params": {
        "title": "Process Parameters",
        "applies_to": "Process parameter / machine log data",
        "description": (
            "Overlays every parameter column on one zoomable ECharts line chart with "
            "Date_Time on the x-axis. Runs in the editor, or standalone on a sql_*.xlsx."
        ),
        "requires": [
            "Date_Time",
            "One column per parameter to trend (any numeric column)",
        ],
        "optional": [
            "WOL",
            "Prefix",
            "Suffix",
            "WCenter",
            "Operation",
            "Product",
            "DEVICE_NUM",
            "EVENT_ID",
        ],
        "outputs": [
            "One self-contained HTML dashboard, opened in your browser",
            "A single zoomable ECharts line chart overlaying every parameter column",
            "Date_Time on the x-axis, with the extra metadata used for grouping "
            "and hover",
        ],
    },
    "analyze-tautona-data": {
        "title": "Laminate Lab Results",
        "applies_to": "Tautona laminate lab test data",
        "description": (
            "Profiling stats, Cp/Cpk/Ppk capability, SPC I-MR control charts and a "
            "categorical Pareto for laminate lab results, in one searchable page."
        ),
        "requires": ["MG_DESC", "ANALYSIS", "RESULT_NAME", "RESPONSE2"],
        "optional": [
            "WOL",
            "LAM_DATE",
            "IN_SPEC",
            "SPEC_RULE",
            "LSL",
            "USL",
            "LCL",
            "UCL",
            "MAIN_GROUP",
            "DESCRIPTION",
            "UNITS",
        ],
        "outputs": [
            "Laminate_Analysis.html — one self-contained, searchable page",
            "Profiling statistics and an out-of-spec overview per group",
            "Cp / Cpk / Ppk capability with histograms",
            "SPC I-MR control charts and a categorical Pareto",
            "Pop-up chart modals when a laminate (MG_DESC) is clicked",
        ],
    },
    "analyze-machine-uptime": {
        "title": "Machine Uptime",
        "applies_to": "Machine / resource downtime event data",
        "description": (
            "Turns machine downtime events into an uptime dashboard: uptime, planned "
            "and unplanned downtime percentages, a status timeline, duration "
            "histograms and a gravure-change analysis."
        ),
        "requires": [
            "event_start_date",
            "status",
            "description",
            "dt_mins",
        ],
        "optional": [
            "mes_resource",
        ],
        "outputs": [
            "One self-contained HTML dashboard, opened in your browser",
            "Uptime %, planned downtime % and unplanned downtime % KPIs",
            "Machine status timeline (running / planned / unplanned) with a machine "
            "picker and date range",
            "Event duration histogram and a selected-event trend chart",
            "Gravure change analysis: changeover counts, gravure-to-gravure vs "
            "gravure-to-cleaning split and an interval detail table",
        ],
    },
    "analyze-color-data": {
        "title": "Color Data",
        "applies_to": "Color_Data lab colour measurements (LD / Raw / Laminate)",
        "description": (
            "Lab colour explorer in one five-tab page: an LD heat map, unmatched "
            "Raw items, laminate ΔE scoring, LD redundancy checking and a Pantone "
            "match."
        ),
        "requires": [
            "Sample_type",
            "LD_item",
            "L",
            "a",
            "b",
        ],
        "optional": [
            "Raw_item",
            "DATE",
            "NAME",
            "Batch",
            "Hex",
            "WOL",
            "Product",
            "Description",
        ],
        "outputs": [
            "One self-contained HTML page with five tabs, opened in your browser",
            "LD heat map: one row per LD_item coloured by the mean of its LD "
            "samples; clicking an item opens its ΔE-by-batch detail view",
            "Unmatched Raw and Laminate tables with CMC(2:1) ΔE scoring "
            "against a selectable reference LD_item",
            "LD Redundancy: repeat LD_items within a textile clustered at a "
            "Group ΔE, listed overall / by group / as a matrix / as a colour "
            "grid, with a redundant-items CSV export",
            "Match Pantone: the nearest LD_item or unmatched Raw_item to a "
            "Pantone TCX colour by CMC(2:1)",
        ],
    },
    "analyze-lims-raw-genealogy": {
        "title": "Lims Raw Genealogy",
        "applies_to": "LIMS raw item / raw lot quantity data",
        "description": (
            "Summarises raw lot quantities per raw item with a searchable stats "
            "table, a boxplot per raw lot and a per-item histogram drill-down."
        ),
        "requires": [
            "raw_item",
            "raw_lot",
            "raw_lot_qty",
        ],
        "outputs": [
            "One self-contained HTML report, opened in your browser",
            "KPIs: valid source rows, unique item-lot groups and raw item count",
            "Searchable, sortable table of unique raw lots, total / min / max / "
            "average / median quantity per raw_item",
            "ECharts boxplot of summed raw_lot_qty per raw lot",
            "Per-item histogram modal with bin-size and quantity range controls "
            "plus a raw lot details table",
        ],
    },
}


def _docstring_summary(path: Path) -> str:
    """First meaningful line of a module docstring (for unlisted templates)."""
    text = path.read_text(encoding="utf-8", errors="replace")
    match = re.match(r'\s*(?:#[^\n]*\n)*\s*(?:"""|\'\'\')(.*?)(?:"""|\'\'\')', text, re.S)
    if not match:
        return ""
    for line in match.group(1).splitlines():
        line = line.strip()
        # Skip a leading "name.py" line, which several scripts use as a header.
        if line and not line.endswith(".py"):
            return line
    return ""


def _title_from_stem(stem: str) -> str:
    return stem.removeprefix("analyze-").replace("-", " ").replace("_", " ").title()


def _human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)


def _html_title(path: Path) -> str:
    """``<title>`` of a sample dashboard, else a title-cased file name."""
    match = _TITLE_RE.search(path.read_text(encoding="utf-8", errors="replace"))
    if not match:
        return path.stem.replace("_", " ").title()
    return html.unescape(" ".join(match.group(1).split()))


def _example(item_stem: str) -> dict | None:
    """The sample dashboard for a template stem, or None if it is not shipped."""
    name = EXAMPLE_FILES.get(item_stem, "")
    path = EXAMPLES_DIR / name if name else None
    if path is None or not path.is_file():
        return None
    return {
        "path": path,
        "name": path.name,
        # Object key inside the bucket; also what the app builds its URL from.
        "object": f"{EXAMPLES_PREFIX}/{path.name}",
        "label": _html_title(path),
        "size": _human_size(path.stat().st_size),
        # Kept for the read-back check, not shown on the page.
        "sha256": release.sha256_of(path),
    }


def collect_templates() -> list[dict]:
    """Every ``*.py`` template, with the details the page and the upload need."""
    items = []
    for path in sorted(TEMPLATES_DIR.glob("*.py")):
        info = TEMPLATE_INFO.get(path.stem, {})
        stat = path.stat()
        # Only keep the detail lists that actually carry text, so an unlisted
        # template does not publish empty sections.
        details = {
            key: [str(value) for value in info.get(key, [])]
            for key in ("requires", "optional", "outputs")
            if info.get(key)
        }
        item = {
            "path": path,
            "name": path.name,
            "title": info.get("title") or _title_from_stem(path.stem),
            "applies_to": info.get("applies_to", ""),
            "description": info.get("description") or _docstring_summary(path),
            "details": details,
            "size": _human_size(stat.st_size),
            "updated": time.strftime("%Y-%m-%d", time.localtime(stat.st_mtime)),
            # Kept for the read-back check, not shown on the page.
            "sha256": release.sha256_of(path),
        }
        example = _example(path.stem)
        if example:
            item["example"] = example
        items.append(item)
    return items


def public_base(manifest_url: str) -> str:
    """Public manifest URL -> ``.../storage/v1/object/public/<bucket>``."""
    return manifest_url.rsplit("/", 1)[0]


CARD = Template("""    <article class="card">
      <h2>$title</h2>
      <p class="file"><code>$filename</code></p>
      <p class="applies">Applies to: $applies</p>
      <p class="desc">$description</p>
      <p class="meta">$size &middot; updated $updated</p>
      <button type="button" class="btn" data-url="$url" aria-live="polite">Copy</button>
    </article>""")

PAGE = Template("""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>ODBC Query — Script Templates</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#f4f5f7; --card:#ffffff; --ink:#15171c; --muted:#5c6473;
  --line:#e3e6ec; --accent:#1f6feb; --on-accent:#ffffff; --danger:#b3261e;
  --radius:14px;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1014; --card:#161a21; --ink:#e9ebef; --muted:#98a1b0;
    --line:#252a33; --accent:#5b95fb; --on-accent:#07101f; --danger:#f2b8b5;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font:16px/1.55 "Lora",Georgia,"Times New Roman",serif;
}
.wrap{max-width:1080px; margin:0 auto; padding:24px 16px 48px}
header h1{font-size:1.55rem; line-height:1.25; margin:0 0 10px; letter-spacing:-.01em}
.lede{margin:0; color:var(--muted); max-width:62ch}
.grid{display:grid; gap:14px; margin:24px 0 8px; grid-template-columns:1fr}
.card{
  display:flex; flex-direction:column; gap:8px; padding:18px;
  background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
  transition:box-shadow .15s ease;
}
.card h2{font-size:1.1rem; margin:0}
.file{margin:0; font-size:.85rem; color:var(--muted); word-break:break-all}
.file code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.applies{margin:0; font-size:.85rem; color:var(--muted)}
.desc{margin:0; flex:1}
.meta{margin:0; font-size:.8rem; color:var(--muted)}
.btn{
  display:inline-flex; align-items:center; justify-content:center; width:100%;
  min-height:48px; padding:12px 20px; margin-top:4px; border:0; border-radius:10px;
  background:var(--accent); color:var(--on-accent); font:inherit; font-weight:600;
  cursor:pointer; -webkit-tap-highlight-color:transparent;
}
.btn:active{transform:translateY(1px)}
.btn:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.btn[disabled]{cursor:progress; opacity:.7}
.btn.is-error{background:var(--danger)}
.how{margin-top:32px; padding:18px; background:var(--card);
  border:1px solid var(--line); border-radius:var(--radius)}
.how h2{font-size:1.05rem; margin:0 0 8px}
.how ol{margin:0; padding-left:20px; color:var(--muted)}
.how li{margin:4px 0}
.how code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.9em}
footer{margin-top:28px; color:var(--muted); font-size:.8rem}
/* Tablet and up: cards side by side, buttons sized to their label so a mouse
   does not have to cross a full-width bar. */
@media (min-width:768px){
  .wrap{padding:32px 24px 56px}
  header h1{font-size:2rem}
  .grid{grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:16px; margin-top:28px}
  .btn{width:auto; align-self:flex-start; min-width:132px}
}
@media (hover:hover){
  .btn:hover{filter:brightness(1.07)}
  .card:hover{box-shadow:0 8px 24px rgba(0,0,0,.1)}
}
@media (prefers-reduced-motion:reduce){ *{transition:none !important} }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>ODBC Query — Script Templates</h1>
  <p class="lede">Copy-ready copies of the analysis scripts that ship with ODBC&nbsp;Query.
  Fixes and new templates appear here without waiting for an app update, so the script you
  copy is always the current one.</p>
</header>
<main>
  <section class="grid">
$cards
  </section>
  <section class="how">
    <h2>How to use a template</h2>
    <ol>
      <li>Press <strong>Copy</strong> on a template — the whole script goes to the clipboard.</li>
      <li>In ODBC Query, open the <strong>Script</strong> page and paste into the editor (Ctrl&nbsp;+&nbsp;V).</li>
      <li>Choose the data source and run it — the grid rows arrive as a list of dicts called <code>data</code>.</li>
    </ol>
  </section>
</main>
<footer>
  <p>$count template(s) &middot; page last published $published</p>
</footer>
</div>
<script>
(function () {
  "use strict";

  // The scripts live in a public storage bucket, so the button fetches the
  // bytes on click instead of linking a file: the visitor always gets the
  // current copy, and nothing is written to their Downloads folder.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // Plain http:// intranet hosts are not a secure context, so fall back to
    // the older selection-based copy.
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
      document.body.removeChild(area);
      if (ok) { resolve(); } else { reject(new Error("copy blocked")); }
    });
  }

  function flash(button, message, failed) {
    button.textContent = message;
    button.classList.toggle("is-error", !!failed);
    clearTimeout(button.dataset.timer);
    button.dataset.timer = setTimeout(function () {
      button.textContent = "Copy";
      button.classList.remove("is-error");
    }, 1800);
  }

  var buttons = document.querySelectorAll(".btn");
  Array.prototype.forEach.call(buttons, function (button) {
    button.addEventListener("click", function () {
      if (button.disabled) { return; }
      button.disabled = true;
      fetch(button.dataset.url, { cache: "no-store" })
        .then(function (response) {
          if (!response.ok) { throw new Error("HTTP " + response.status); }
          return response.text();
        })
        .then(copyText)
        .then(function () { flash(button, "Copied", false); })
        .catch(function () { flash(button, "Copy failed", true); })
        .then(function () { button.disabled = false; });
    });
  });
})();
</script>
</body>
</html>
""")


def build_page(items: list[dict], base: str) -> str:
    """The page, generated from the folder so it cannot go stale.

    Each card carries the object's public URL in ``data-url``; the button fetches
    that URL and copies the script, so there is no file to download.
    """
    cards = "\n".join(
        CARD.substitute(
            title=html.escape(item["title"]),
            filename=html.escape(item["name"]),
            applies=html.escape(item["applies_to"] or "Any loaded data"),
            description=html.escape(item["description"]),
            size=item["size"],
            updated=item["updated"],
            url=html.escape(f"{base}/{PREFIX}/{item['name']}", quote=True),
        )
        for item in items
    )
    return PAGE.substitute(
        cards=cards,
        count=len(items),
        published=time.strftime("%Y-%m-%d %H:%M"),
    )


def build_catalog(items: list[dict]) -> str:
    """The JSON catalog the app reads to list the published templates.

    It mirrors the folder exactly like the page does, and is uploaded in the same
    run, so the picker inside ODBC Query can never offer a script the bucket does
    not serve.
    """
    return json.dumps(
        {
            "published": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "templates": [
                {
                    "name": item["name"],
                    "stem": Path(item["name"]).stem,
                    "title": item["title"],
                    "applies_to": item.get("applies_to", ""),
                    "description": item["description"],
                    "details": item.get("details", {}),
                    "size": item["size"],
                    "updated": item["updated"],
                    # What the picker links to as this template's example output.
                    "example": (
                        {
                            "name": item["example"]["name"],
                            "object": item["example"]["object"],
                            "label": item["example"]["label"],
                            "size": item["example"]["size"],
                        }
                        if item.get("example")
                        else None
                    ),
                }
                for item in items
            ],
        },
        indent=2,
        ensure_ascii=False,
    ) + "\n"


def upload_templates(manifest_url: str, key: str, items: list[dict], page: str,
                     catalog: str) -> None:
    """Upload every template, then the page and the catalog, into the update bucket."""
    auth = {"Authorization": f"Bearer {key}", "x-upsert": "true"}
    print(f"\nUploading {len(items)} template(s):", flush=True)
    for item in items:
        release.http(
            release.object_url(manifest_url, f"{PREFIX}/{item['name']}"), "POST",
            # Object names are reused, so keep the TTL short: a cached copy
            # would hand out the previous version of the script.
            {**auth, "Content-Type": "text/plain; charset=utf-8",
             "cache-control": "max-age=60"},
            item["path"].read_bytes(),
        )
        print(f"  {item['name']}  ({item['size']})")
    examples = [item for item in items if item.get("example")]
    if examples:
        print(f"\nUploading {len(examples)} example output(s):", flush=True)
        for item in examples:
            example = item["example"]
            release.http(
                release.object_url(manifest_url, example["object"]), "POST",
                # The bucket normalises html to text/plain with nosniff; the app
                # renders the fetched bytes itself, so only the bytes matter.
                {**auth, "Content-Type": "text/html; charset=utf-8",
                 "cache-control": "max-age=60"},
                example["path"].read_bytes(),
            )
            print(f"  {example['object']}  ({example['size']})")
    for name, body, content_type in ((CATALOG_NAME, catalog.encode("utf-8"),
                                      "application/json; charset=utf-8"),
                                     (PAGE_NAME, page.encode("utf-8"),
                                      "text/html; charset=utf-8")):
        release.http(
            release.object_url(manifest_url, name), "POST",
            {**auth, "Content-Type": content_type, "cache-control": "max-age=60"},
            body,
        )
        print(f"  {name}")


def verify_public(base: str, items: list[dict], page: str) -> None:
    """Read every published object back and compare it with the local file.

    The object names are reused on each publish, so a stale CDN copy is the one
    failure that matters: it would hand a user the previous script while the
    page looks current.  The CDN can lag a write briefly, so a mismatch is
    reported as a warning rather than failing the run.
    """
    stamp = int(time.time())
    print("\nVerifying the published objects (cache-busted read-back):")
    bad = []
    for item in items:
        url = f"{base}/{PREFIX}/{item['name']}?v={stamp}"
        try:
            status, body = release.http(url, "GET", {"Cache-Control": "no-cache"})
        except SystemExit as exc:
            bad.append(item["name"])
            print(f"  FAIL {item['name']}: {exc}")
            continue
        digest = hashlib.sha256(body).hexdigest()
        if status == 200 and digest == item["sha256"]:
            print(f"  OK   {item['name']}  (HTTP {status}, sha256 matches the local file)")
        else:
            bad.append(item["name"])
            print(f"  FAIL {item['name']}  (HTTP {status}, sha256 {digest[:12]}…)")

    for item in items:
        example = item.get("example")
        if not example:
            continue
        url = f"{base}/{quote(example['object'], safe='/')}?v={stamp}"
        try:
            status, body = release.http(url, "GET", {"Cache-Control": "no-cache"})
        except SystemExit as exc:
            bad.append(example["object"])
            print(f"  FAIL {example['object']}: {exc}")
            continue
        digest = hashlib.sha256(body).hexdigest()
        if status == 200 and digest == example["sha256"]:
            print(f"  OK   {example['object']}  (HTTP {status}, sha256 matches the local file)")
        else:
            bad.append(example["object"])
            print(f"  FAIL {example['object']}  (HTTP {status}, sha256 {digest[:12]}…)")

    try:
        status, body = release.http(
            f"{base}/{PAGE_NAME}?v={stamp}", "GET", {"Cache-Control": "no-cache"})
        served = body.decode("utf-8", "replace")
    except SystemExit as exc:
        print(f"  FAIL {PAGE_NAME}: {exc}")
        return
    missing = [item["name"] for item in items if item["name"] not in served]
    if status == 200 and not missing and served == page:
        print(f"  OK   {PAGE_NAME}  (HTTP {status}, lists all {len(items)} template(s))")
    else:
        print(f"  FAIL {PAGE_NAME}  (HTTP {status}, "
              f"missing: {', '.join(missing) if missing else 'none — served copy differs'})")

    names = {item["name"] for item in items}
    try:
        status, body = release.http(
            f"{base}/{CATALOG_NAME}?v={stamp}", "GET", {"Cache-Control": "no-cache"})
        listed = json.loads(body.decode("utf-8", "replace"))
        published = {entry.get("name") for entry in listed["templates"]
                     if isinstance(entry, dict)}
    except (SystemExit, ValueError, KeyError, TypeError) as exc:
        print(f"  FAIL {CATALOG_NAME}: {exc}")
        return
    if status == 200 and published == names:
        print(f"  OK   {CATALOG_NAME}  (HTTP {status}, lists all {len(names)} template(s))")
    else:
        print(f"  FAIL {CATALOG_NAME}  (HTTP {status}, lists "
              f"{len(published & names)} of {len(names)} template(s))")

    if bad:
        print(f"\nWARNING: {len(bad)} object(s) did not serve the expected bytes — the CDN "
              f"may need a minute. Re-check before sharing the page.")


def print_manual_upload(manifest_url: str, items: list[dict]) -> None:
    """Copy-paste curl commands for when no service-role key is available."""
    uploads = [(f"{PREFIX}/{item['name']}", item["path"], "text/plain; charset=utf-8")
               for item in items]
    uploads += [(item["example"]["object"], item["example"]["path"],
                 "text/html; charset=utf-8")
                for item in items if item.get("example")]
    uploads.append((CATALOG_NAME, LOCAL_CATALOG, "application/json; charset=utf-8"))
    uploads.append((PAGE_NAME, LOCAL_PAGE, "text/html; charset=utf-8"))
    print("\nSame thing from the command line (needs your service_role key):")
    for name, local, content_type in uploads:
        print(f'  curl.exe -X POST "{release.object_url(manifest_url, name)}" \\')
        print('    -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \\')
        print(f'    -H "x-upsert: true" -H "Content-Type: {content_type}" \\')
        print(f'    --data-binary "@{local}"')


def write_local(page: str, catalog: str) -> None:
    """Mirror the published objects into the backend folder.

    ``--no-upload`` and the no-key path need them as files for the printed curl
    commands, and they are handy for reading the catalog by hand.
    """
    LOCAL_PAGE.write_text(page, encoding="utf-8")
    LOCAL_CATALOG.write_text(catalog, encoding="utf-8")


def main() -> None:
    if not TEMPLATES_DIR.is_dir():
        raise SystemExit(f"Template folder not found: {TEMPLATES_DIR}")
    items = collect_templates()
    if not items:
        raise SystemExit(f"No *.py templates found in {TEMPLATES_DIR}")
    print(f"Templates: {', '.join(item['name'] for item in items)}")

    manifest_url = release.read_manifest_url()
    if not manifest_url:
        raise SystemExit("No manifest URL configured — cannot derive the bucket.")
    base = public_base(manifest_url)
    page = build_page(items, base)
    catalog = build_catalog(items)

    if "--no-upload" in sys.argv:
        write_local(page, catalog)
        print(f"\nPage and catalog written to {LOCAL_PAGE.parent} (--no-upload: nothing was uploaded)")
        print_manual_upload(manifest_url, items)
        return

    key = release.upload_key(release.expected_project_ref(manifest_url))
    if not key:
        write_local(page, catalog)
        print(f"\nNo Supabase key found, so nothing was uploaded — page and catalog "
              f"written to {LOCAL_PAGE.parent}.")
        print("  Save the service-role key on a single line in")
        print(f"  {Path(os.environ.get('APPDATA', '~')) / 'ODBCQueryApp' / 'supabase_key'}")
        print_manual_upload(manifest_url, items)
        return

    upload_templates(manifest_url, key, items, page, catalog)
    verify_public(base, items, page)
    write_local(page, catalog)
    print(f"\nCatalog: {base}/{CATALOG_NAME}   (the app reads this)")
    print(f"Page: {base}/{PAGE_NAME}")
    print(f"Viewable copy: {LOCAL_PAGE}")
    print("Share the viewable copy; its buttons keep working for future templates too.")


if __name__ == "__main__":
    main()
