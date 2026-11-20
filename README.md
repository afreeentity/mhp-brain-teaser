# MHP Brain Teaser website

Public pages for the MHP Brain Teaser app: a short landing page and the privacy policy.

## News feed for the app
`news/build.mjs` reads the RSS/Atom feeds listed in `news/sources.json` and writes `news/news.json`,
which the app's News tab downloads. A GitHub Actions workflow (`.github/workflows/news.yml`) runs it
every hour and commits the file when the list changes. Only headlines, short excerpts and links are
stored; every item opens on its publisher's own site. Sources were chosen because their terms allow
this (public-domain government newsrooms, Creative Commons outlets, and MIT News, which offers its
feeds for syndication); the basis for each is noted under `licences` in `sources.json`.

To add or remove a source, edit `news/sources.json`. To run it by hand: `node news/build.mjs`, or
use "Run workflow" on the Actions tab.
