# Corporate theme conformance

This site follows the **Skunkworks Africa canonical company gateway**:
https://github.com/skunkworks-africa/www

## Shared design source

| Mirrored file | Canonical upstream | Source blob SHA |
| --- | --- | --- |
| `styles.css` | [skunkworks-africa/www/styles.css](https://github.com/skunkworks-africa/www/blob/main/styles.css) | `aaae82c79645d842ab626d76ecd2fa9e93c84dc1` |
| `adaptive-shell.css` | [skunkworks-africa/www/adaptive-shell.css](https://github.com/skunkworks-africa/www/blob/main/adaptive-shell.css) | `d479aed1c69238cd17d01b05b4109bc87c989aa3` |
| `theme-init.js` | [skunkworks-africa/www/theme-init.js](https://github.com/skunkworks-africa/www/blob/main/theme-init.js) | `3fefd69cc52b7e71ac515682d6e7c9398e99d139` |
| `assets/skunkworks-global-footer.css` | [skunkworks-africa/www/assets/skunkworks-global-footer.css](https://github.com/skunkworks-africa/www/blob/main/assets/skunkworks-global-footer.css) | `76f3f9ce3afb4b4edfb6a09975c269abc7607df9` |
| `assets/skunkworks-global-footer.js` | [skunkworks-africa/www/assets/skunkworks-global-footer.js](https://github.com/skunkworks-africa/www/blob/main/assets/skunkworks-global-footer.js) | `449ea8a5dec72fb2bee3b028cf7938f586f3b999` |
| `site.js` | [skunkworks-africa/www/site.js](https://github.com/skunkworks-africa/www/blob/main/site.js) | `a887776fb6e44a3851d8889104be568878d94621` |

Stylesheets and theme initialization retain the original classes and values. The copied `site.js` is narrowed to mobile navigation behavior, and global footer JS adds best-effort browser storage handling for the theme picker. The source SHAs above identify upstream origins, not byte-identical hashes for the two adapted scripts. The MCP-specific stylesheet `mcp.css` adds layout for code samples, tables and other project content without redefining global brand colors.

The corporate logo and favicon are referenced from the canonical corporate host rather than introducing a second product mark. Header primary navigation follows **Solutions → Services → Academy → Skunkworks** with the Store in a separate Shop action. The standard global footer, theme picker and `skunkworks-theme` persistence are copied from corporate source.

## Contract
- Light mode = white canvas, black foreground, black header.
- Dark mode = black canvas, white foreground, white header.
- Monochrome only; muted foreground and outlines use opacity-derived tones.
- Inter with Segoe UI, Roboto and system fallbacks.
- One primary global header; mobile burger menu.
- Shared Skunkworks global footer and system / light / dark preference.
- Visible keyboard focus, reduced motion, mobile responsive layout.
- The MCP site is a developer documentation/download surface, not the corporate, store or learning authority.

## Refreshing shared files

When `skunkworks-africa/www` updates a canonical style or footer:
1. Compare the listed upstream blobs with the new main branch.
2. Copy shared styles verbatim into both root and `docs/`; preserve the documented MCP-specific adaptations for `site.js` and the footer script.
3. Review whether the brand component requires corresponding HTML markup changes.
4. Re-run `npm test` and conduct a light/dark/mobile/keyboard smoke test.
5. Review the source and merge through a pull request.

We deliberately avoid hotlinking executable scripts or CSS from the main site, so an outage or a breaking deployment elsewhere cannot silently change this site. The only externally referenced brand assets are the corporate logo and favicon.
