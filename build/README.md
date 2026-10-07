# Build resources

- `vortaq-icon-source.png`: the Vortaq app icon, original artwork owned by the project and released
  with it under the MIT licence (see `LICENSE`). It is not derived from any other product's icon.
- `icon.png` (1024 px), `icon-mac.png` (macOS icon grid), `icon.icns`, `icon.ico` and `icons/<n>x<n>.png`
  are generated from it by `scripts/make-icons.py` (Python 3 with Pillow and numpy; the `.icns` needs
  macOS `iconutil`). The script makes the area outside the rounded square transparent and does not
  change anything inside it. Run it again only when the artwork changes, and commit the results.
- `installer.nsh`: additions to the Windows NSIS installer (see the comments in the file).
