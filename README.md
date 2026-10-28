# DocSearch

Offline, plain-language search over your operating manuals, as an installable web app for the iPad.
Search finds the right pages; tap a result to open the PDF at that page with the matching words highlighted.

## Put it online (once)

Upload these files together to a GitHub Pages repo (same folder, no sub-folders):

    index.html  styles.css  app.js  lib.js  worker.js  glossary.json  abbreviations.json  exclude.json  sw.js  manifest.json  icon-180.png  icon-192.png  icon-512.png

Open the page in Safari on the iPad, then Share > Add to Home Screen. Always open it from the Home Screen icon afterwards.

## First run (needs internet, once)

1. Open the app from the Home Screen icon while online. Tap **Documents**, then **Add or replace PDFs**, and select all the PDFs.
2. The first time, it downloads the search model (about 35 MB) and the PDF viewer code, then indexes each PDF.
   Keep the app open and the iPad awake and charging. Indexing is slow once, then never again for that file.
3. After that the app works fully offline, including opening PDFs.

## Index on a PC, use it on the iPad (recommended)

Indexing is slow (roughly 1 passage per second on one PC thread; the whole set is likely hours). Do it once on a PC:

1. On the PC run `python3 serve.py` in this folder and open `http://localhost:8000/?threads=4`
   (multi-threaded and faster; if it errors, use plain `http://localhost:8000/`).
2. Add all PDFs and wait for indexing to finish.
3. Documents > **Export index**. This saves `docsearch-index.bin` (tens of MB).
4. Move that file to the iPad (AirDrop, iCloud Drive, email).
5. On the iPad: Documents > **Add or replace PDFs** (just saves them, no waiting if an index already exists)
   and **Import index file**. Import the index first, then add the same PDFs; the list warns if a PDF differs from the indexed version.

When a manual is revised: re-add it on the PC, export again, import again on the iPad.

## Page labels and headings

Each result shows the nearest numbered heading (for example "10.4.5.2 The Procedure for a Monitored Approach"), the printed page ("Page 10-187 · Section 10: Operating Procedures") and the PDF page. For an index built earlier, the app reads this from the PDF once in the background (about a minute, no re-indexing); the Documents list is usable meanwhile.

## Abbreviations (abbreviations.json)

About 500 abbreviations and their meanings, collected from the abbreviation lists in the OM, SOP, FAM and FCTM. Typing "NNC" or "non-normal checklist" finds
pages that use either. It works the same way as the glossary, so you can add or fix entries: each line is `["ABBREVIATION", "Meaning", "Another meaning"]`.
Reload the page after editing. Words that are also ordinary English (IF, TO, SET, OFF) are left out on purpose.

## Leaving chapters out (exclude.json)

`exclude.json` lists page-number prefixes to leave out of the search, per document, for example `{"FCOM": ["PI.", "PD."]}` leaves out the
FCOM performance chapters (pages numbered PI.xx.xx and PD.xx.xx). Those pages stay readable in the viewer, they just never appear in results and are not indexed,
which makes indexing much faster and results cleaner. Table-of-contents pages are always left out. Re-index a document after changing this.

## Updating a manual

Documents > Add or replace PDFs, and pick the new revision with the same file name. It replaces the old copy and re-indexes it.
Different file name = it is added next to the old one, so delete the old one.

## Notes

- Your PDFs and the index are stored inside the app on the iPad (IndexedDB). Keep your originals in Files as the backup.
  If iPadOS ever clears the app's storage, import again.
- The page shown as "PDF p.300" is the PDF's own page number (what the viewer jumps to). The printed page label
  (for example "EQUIPMENT/FURNISHINGS 25 Page 14 of 44") is shown next to it when the manual has one.
- Search results are a lookup aid. Always read the page and check the revision date against the official document.
- Scanned (image-only) PDFs have no text to search; this app does not do OCR.

## Glossary (glossary.json)

A plain list of groups of words that mean the same thing for searching, for example
`["generator", "gen", "idg", "engine driven generator"]`. If your question contains any word in a group,
a passage containing any other word in the group counts as a match too, and the alternatives are
shown with the matching passages. Add your own groups (company abbreviations, the way pilots say things).
Keep each group to genuine synonyms; loose groups add noise. Reload the page after editing.

## Civil Aviation Regulations (CARs)

The SACAA site shows the regulations as live web pages, so there is no PDF to download. `get_cars.py`
(a separate tool, not part of the app, in its own folder) saves chosen Parts as PDFs:

    python get_cars.py 61 91 121

It writes one `CAR Part NN.pdf` per Part, with a header on every page ("CAR Part 91 - General Aviation and
Operating Flight Rules"). Add those PDFs in the app like any other document. Results are labelled with the
regulation number (for example "91.06.8") and titled with the regulation's own heading. The list-of-regulations
pages at the front of each Part are left out of the search, because they only repeat the titles.

## Document groups

`groups.json` sorts the document pills into labelled groups (Company, Aircraft, Regulations, Reference). Each group lists
words; a document joins the first group that has a word its name starts with (or contains at a word boundary).
Anything unmatched appears under "Other". Tap a group name to include or leave out the whole group. To move a
document, change its word in `groups.json`. No re-indexing needed.